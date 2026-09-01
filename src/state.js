import { PositionSchema, verifyPosition } from './position.js';

export function reconstruct(events) {
  const state = {
    subject: null,
    position: null,
    observations: [],
    perspectives: new Map(),
    wagers: new Map(),
    election: null,
    realizations: new Map(),
    evaluations: new Map(),
    development: new Map(),
    pendingAssimilation: null,
    head: null,
  };
  for (const event of events) {
    applyEvent(state, event);
    state.head = event.hash;
  }
  return state;
}

function applyEvent(state, event) {
  const payload = event.payload;
  if (event.type === 'subject.born') {
    if (state.subject) throw new Error('ledger contains more than one subject birth');
    state.subject = structuredClone(payload.subject);
    state.position = verifyPosition(payload.position);
    return;
  }
  if (!state.subject) throw new Error(`${event.type} precedes subject birth`);
  if (event.type === 'observation.received') {
    state.observations.push(structuredClone(payload.observation));
  } else if (event.type === 'perspective.started') {
    state.perspectives.set(payload.invocation.id, { ...structuredClone(payload.invocation), status: 'started' });
  } else if (event.type === 'perspective.completed') {
    const prior = state.perspectives.get(payload.invocationId);
    if (!prior || prior.status !== 'started') throw new Error('perspective completion lacks active invocation');
    state.perspectives.set(payload.invocationId, { ...prior, status: 'completed', receipt: structuredClone(payload.receipt) });
  } else if (event.type === 'perspective.failed') {
    const prior = state.perspectives.get(payload.invocationId);
    if (!prior || prior.status !== 'started') throw new Error('perspective failure lacks active invocation');
    state.perspectives.set(payload.invocationId, { ...prior, status: 'failed', failure: structuredClone(payload.failure) });
  } else if (event.type === 'wager.bound') {
    state.wagers.set(payload.wager.id, structuredClone(payload));
    state.election = { wagerId: payload.wager.id, event: event.hash };
  } else if (event.type === 'realization.completed') {
    state.realizations.set(payload.wagerId, structuredClone(payload.receipt));
  } else if (event.type === 'predicate.evaluated') {
    state.evaluations.set(payload.wagerId, structuredClone(payload.evaluation));
  } else if (event.type === 'transition.applied') {
    PositionSchema.parse(payload.position);
    if (payload.position.parent !== state.position.id) throw new Error('position transition has wrong parent');
    state.position = verifyPosition(payload.position);
    state.election = null;
  } else if (event.type === 'consequence.underdetermined') {
    state.election = null;
    state.pendingAssimilation = { wagerId: payload.wagerId, position: payload.position };
  } else if (event.type === 'development.proposed') {
    state.development.set(payload.id, { ...structuredClone(payload), status: 'proposed' });
    state.pendingAssimilation = null;
  } else if (event.type === 'development.trialed') {
    const prior = state.development.get(payload.id);
    if (!prior || prior.status !== 'proposed') throw new Error('development trial lacks proposal');
    state.development.set(payload.id, { ...prior, status: 'trialed', trial: structuredClone(payload.trial) });
  } else if (event.type === 'development.disposed') {
    const prior = state.development.get(payload.id);
    if (!prior || prior.status !== 'trialed') throw new Error('development disposition lacks trial');
    state.development.set(payload.id, { ...prior, status: payload.disposition, dispositionReceipt: structuredClone(payload.receipt) });
    if (payload.position) {
      if (payload.position.parent !== state.position.id) throw new Error('development successor has wrong parent');
      state.position = verifyPosition(payload.position);
    }
    state.pendingAssimilation = null;
  } else {
    throw new Error(`unsupported ledger event type: ${event.type}`);
  }
}
