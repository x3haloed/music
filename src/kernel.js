import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ArtifactStore } from './artifacts.js';
import { canonical, digest } from './canonical.js';
import { admitWager } from './constitution.js';
import { Governance } from './governance.js';
import { Ledger } from './ledger.js';
import { applyTransition, initialPosition } from './position.js';
import { affectedPaths, pathsOverlap, TransitionSchema, verifyPosition } from './position.js';
import { reconstruct } from './state.js';
import { executeTool, starterTools, ToolArtifactSchema } from './tools.js';
import { classifyReceipt, evaluatePredicate } from './predicate.js';

export class MusicKernel {
  constructor(habitat, { clock = () => new Date(), id = () => randomUUID() } = {}) {
    this.habitat = habitat;
    this.clock = clock;
    this.id = id;
    this.ledger = new Ledger(join(habitat, 'state', 'ledger.jsonl'), { clock, id });
    this.artifacts = new ArtifactStore(join(habitat, 'state', 'artifacts'));
    this.governance = new Governance(join(habitat, 'governance', 'grants.json'), { clock });
  }

  state() {
    return reconstruct(this.ledger.read());
  }

  initialize(designation = null) {
    if (this.state().subject) throw new Error('Music subject already exists');
    const at = this.clock().toISOString();
    const mechanisms = {};
    for (const tool of starterTools()) {
      const artifact = this.artifacts.putJson(tool);
      mechanisms[tool.manifest.id] = {
        kind: 'tool',
        artifact,
        manifest: tool.manifest,
        standing: 'available',
      };
    }
    const subject = {
      id: this.id(),
      designation: normalizeDesignation(designation),
      bornAt: at,
    };
    const position = initialPosition(at, { mechanisms });
    this.ledger.append('subject.born', { subject, position });
    return this.state();
  }

  receiveMessage({ sender, recipient = 'the entity', channel = 'inbox', content, authentication = null }) {
    const state = this.state();
    requireSubject(state);
    if (typeof sender !== 'string' || sender.trim() === '') throw new Error('message sender is required');
    if (typeof content !== 'string' || content.length === 0) throw new Error('message content is required');
    const observation = {
      id: this.id(),
      kind: 'message.received',
      sender: sender.trim(),
      recipient,
      channel,
      observedAt: this.clock().toISOString(),
      content,
      authentication,
      delivery: { adapter: 'music.cli', transformed: false },
    };
    this.ledger.append('observation.received', { observation });
    return observation;
  }

  receiveObservation(observationValue) {
    const state = this.state();
    requireSubject(state);
    const observation = {
      ...structuredClone(observationValue),
      id: this.id(),
      observedAt: this.clock().toISOString(),
    };
    canonical(observation);
    this.ledger.append('observation.received', { observation });
    return observation;
  }

  bindWager(wagerValue, electionReceipt = null) {
    const state = this.state();
    requireSubject(state);
    if (state.election) throw new Error(`wager is already active: ${state.election.wagerId}`);
    if (state.wagers.has(wagerValue?.id)) throw new Error(`duplicate wager id: ${wagerValue.id}`);
    const grants = this.governance.read();
    const admission = admitWager(wagerValue, {
      position: state.position,
      grants,
      artifactExists: id => this.artifacts.has(id),
      toolEffects: id => ToolArtifactSchema.parse(this.artifacts.readJson(id)).manifest.effects,
    });
    if (!admission.admissible) throw new Error(`wager is inadmissible:\n- ${admission.reasons.join('\n- ')}`);
    this.ledger.append('wager.bound', {
      wager: admission.wager,
      position: state.position.id,
      electionReceipt,
      admission: {
        constitution: 'music-v2-constitution-1',
        derivedFloors: admission.derivedFloors,
      },
    });
    return admission.wager;
  }

  async realize(wagerId) {
    const state = this.state();
    requireSubject(state);
    const bound = state.wagers.get(wagerId);
    if (!bound) throw new Error(`unknown wager: ${wagerId}`);
    if (state.realizations.has(wagerId)) throw new Error(`wager was already realized: ${wagerId}`);
    if (bound.position !== state.position.id) throw new Error('wager parent position is no longer active');
    const wager = bound.wager;
    const tool = ToolArtifactSchema.parse(this.artifacts.readJson(wager.contact.tool));
    const startedAt = this.clock().toISOString();
    const output = await executeTool(tool, wager.contact.input, {
      grants: this.governance.read(),
      habitat: this.habitat,
      emitObservation: value => this.receiveObservation(value),
    });
    const receipt = {
      id: this.id(),
      kind: 'tool.result',
      tool: { artifact: wager.contact.tool, id: tool.manifest.id },
      input: structuredClone(wager.contact.input),
      output,
      startedAt,
      completedAt: this.clock().toISOString(),
      capture: { runtime: 'music-v2-tool-runtime-1', transformed: false },
    };
    this.ledger.append('realization.completed', { wagerId, receipt });
    const evaluation = classifyReceipt(receipt, wager.classifiers);
    const evaluationReceipt = {
      ...evaluation,
      evaluator: 'music-v2-predicate-1',
      receipt: digest(receipt),
      evaluatedAt: this.clock().toISOString(),
    };
    this.ledger.append('predicate.evaluated', { wagerId, evaluation: evaluationReceipt });
    if (evaluation.kind === 'support' || evaluation.kind === 'contradiction') {
      const operation = wager.continuations[evaluation.kind];
      const position = applyTransition(state.position, operation, this.clock().toISOString());
      this.ledger.append('transition.applied', {
        wagerId,
        outcome: evaluation.kind,
        operation,
        position,
      });
      return { receipt, evaluation: evaluationReceipt, position };
    }
    this.ledger.append('consequence.underdetermined', {
      wagerId,
      evaluation: evaluationReceipt,
      position: state.position.id,
    });
    return { receipt, evaluation: evaluationReceipt, position: null };
  }

  proposeDevelopment({ wagerId, invocationId, proposal }) {
    const state = this.state();
    const bound = state.wagers.get(wagerId);
    if (!bound) throw new Error(`unknown wager: ${wagerId}`);
    const transition = TransitionSchema.parse(proposal.proposedTransition);
    for (const path of affectedPaths(transition)) {
      if (!bound.wager.revisionScope.some(scope => pathsOverlap(scope.replace(/\/$/, ''), path))) {
        throw new Error(`development path is outside the bound wager scope: ${path}`);
      }
    }
    const id = digest({ parentPosition: state.position.id, wagerId, invocationId, proposal });
    this.ledger.append('development.proposed', {
      id,
      parentPosition: state.position.id,
      wagerId,
      invocationId,
      proposal,
    });
    return id;
  }

  trialDevelopment(id) {
    const state = this.state();
    const development = state.development.get(id);
    if (!development || development.status !== 'proposed') throw new Error(`development is not proposed: ${id}`);
    if (development.parentPosition !== state.position.id) throw new Error('development parent is no longer active');
    const candidate = applyTransition(
      state.position,
      development.proposal.proposedTransition,
      this.clock().toISOString(),
    );
    const requiredFloorIds = state.position.floors
      .filter(floor => affectedPaths(development.proposal.proposedTransition).some(path => pathsOverlap(floor.scope, path)))
      .map(floor => floor.id);
    const passedFloorIds = state.position.floors
      .filter(floor => requiredFloorIds.includes(floor.id) && evaluatePredicate(candidate, floor.predicate))
      .map(floor => floor.id);
    const trial = {
      candidate,
      transition: development.proposal.proposedTransition,
      requiredFloorIds,
      passedFloorIds,
      effects: [],
      eligible: requiredFloorIds.length === passedFloorIds.length,
      runtime: 'music-v2-transition-trial-1',
      completedAt: this.clock().toISOString(),
    };
    this.ledger.append('development.trialed', { id, trial });
    return trial;
  }

  disposeDevelopment(id, disposition, receipt) {
    const state = this.state();
    const development = state.development.get(id);
    if (!development || development.status !== 'trialed') throw new Error(`development is not trialed: ${id}`);
    if (development.parentPosition !== state.position.id) throw new Error('development parent is no longer active');
    if (!['admit', 'retain-parent', 'surrender'].includes(disposition.choice)) throw new Error('invalid development disposition');
    let position;
    if (disposition.choice === 'admit') {
      if (!development.trial.eligible) throw new Error('ineligible development cannot be admitted');
      position = verifyPosition(development.trial.candidate);
    } else {
      position = applyTransition(state.position, {
        kind: 'position.transition',
        set: {},
        remove: [],
        opening: disposition.opening,
      }, this.clock().toISOString());
    }
    this.ledger.append('development.disposed', {
      id,
      disposition: disposition.choice,
      receipt,
      position,
    });
    return position;
  }
}

function normalizeDesignation(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 128) throw new Error('designation must be at most 128 characters');
  return value;
}

function requireSubject(state) {
  if (!state.subject) throw new Error('Music subject does not exist');
}
