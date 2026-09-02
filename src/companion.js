import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DevelopmentalKernel } from './kernel.js';
import { RunStore } from './store.js';

const executeFile = promisify(execFile);

export function companionSnapshot(rootArg, { processAlive = defaultProcessAlive } = {}) {
  const root = resolve(rootArg);
  const store = new RunStore(root);
  const events = store.readEvents();
  if (events.length === 0) throw new Error(`Music run has no retained events: ${root}`);
  const state = new DevelopmentalKernel(root).state();
  const lease = readJsonIfPresent(join(root, 'resident.lock'));
  const running = lease?.format === 'music-v4-resident-lease-1' && processAlive(lease.pid);
  const phase = deriveCompanionPhase(events, state, running);
  return {
    format: 'music-v4-companion-snapshot-1',
    run: root,
    head: state.head,
    conversation: projectConversation(root, events),
    presence: {
      running,
      phase: phase.id,
      label: phase.label,
      tone: phase.tone,
      generation: state.subject.succession,
      revision: state.subject.revision,
      focus: state.subject.active?.stake.question ?? state.operation.reason,
      pendingObservations: state.pendingObservations.length,
      failures: state.residentFailures.length,
      currentOperation: state.operation,
    },
    activity: projectActivity(events),
  };
}

export async function sendCompanionMessage(rootArg, message, { cliPath, from = 'Chad', execute = executeFile } = {}) {
  const root = resolve(rootArg);
  const text = String(message ?? '').trim();
  if (!text) throw new Error('message is required');
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('message exceeds 64 KiB');
  const sealedCli = cliPath ?? await discoverResidentCli(root, { execute });
  const { stdout } = await execute(sealedCli, ['observe', root, JSON.stringify({ message: text }), 'operator', from], {
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (result.accepted !== true) throw new Error('sealed resident CLI did not accept the observation');
  return result;
}

export async function discoverResidentCli(rootArg, { execute = executeFile } = {}) {
  if (process.env.MUSIC_RESIDENT_CLI) return resolve(process.env.MUSIC_RESIDENT_CLI);
  const root = resolve(rootArg);
  const lease = readJsonIfPresent(join(root, 'resident.lock'));
  if (!Number.isInteger(lease?.pid) || lease.pid <= 0) throw new Error('resident is not running; set MUSIC_RESIDENT_CLI to its sealed cli.js');
  const { stdout } = await execute('/bin/ps', ['-ww', '-p', String(lease.pid), '-o', 'command='], { maxBuffer: 1024 * 1024 });
  const match = stdout.match(/(?:^|\s)(\/[^\n]+?\/src\/cli\.js)(?:\s|$)/);
  if (!match || !existsSync(match[1])) throw new Error('could not discover the sealed resident cli.js; set MUSIC_RESIDENT_CLI');
  return match[1];
}

export function discoverActiveResidentRoot(residentsRootArg, { processAlive = defaultProcessAlive } = {}) {
  const residentsRoot = resolve(residentsRootArg);
  const candidates = [];
  if (!existsSync(residentsRoot)) return join(residentsRoot, 'resident');
  for (const entry of readdirSync(residentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(residentsRoot, entry.name);
    const lease = readJsonIfPresent(join(root, 'resident.lock'));
    if (lease?.format !== 'music-v4-resident-lease-1' || !Number.isInteger(lease.pid) || !processAlive(lease.pid)) continue;
    candidates.push({ root, acquiredAt: Date.parse(lease.acquiredAt ?? '') || 0 });
  }
  candidates.sort((left, right) => right.acquiredAt - left.acquiredAt || left.root.localeCompare(right.root));
  return candidates[0]?.root ?? join(residentsRoot, 'resident');
}

export function projectConversation(root, events) {
  const messages = [];
  for (const event of events) {
    if (event.type !== 'observation.received') continue;
    const observation = event.payload;
    if (observation.channel === 'continuity') continue;
    messages.push({
      id: `observation:${observation.id}`,
      at: event.at,
      direction: 'human',
      speaker: observation.from || 'World',
      channel: observation.channel,
      text: displayContent(observation.content),
      deliveryStatus: 'retained',
    });
  }
  const outbox = join(root, 'outbox');
  if (existsSync(outbox)) {
    for (const name of readdirSync(outbox).filter(value => value.endsWith('.json'))) {
      const path = join(outbox, name);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      messages.push({
        id: `outbox:${record.deliveryId}`,
        at: statSync(path).mtime.toISOString(),
        direction: 'resident',
        speaker: 'Resident',
        channel: 'operator-outbox',
        text: displayContent(record.message),
        structuredContent: isStructuredContent(record.message) ? record.message : undefined,
        deliveryStatus: 'delivered',
        operationId: record.operationId,
        subjectId: record.subjectId,
      });
    }
  }
  return messages.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

export function deriveCompanionPhase(events, audit, running) {
  if (!running) return { id: 'offline', label: 'Offline', tone: 'error' };
  if (audit.completed) return { id: 'complete', label: 'Episode complete', tone: 'ok' };
  const terminals = new Set(events.filter(event => ['actor.completed', 'actor.failed', 'actor.abandoned'].includes(event.type)).map(event => event.payload.invocationId));
  const actor = [...events].reverse().find(event => event.type === 'actor.started' && !terminals.has(event.payload.invocationId));
  if (actor) {
    const labels = { select: 'Selecting', realize: 'Realizing contact', correct: 'Correcting', assimilate: 'Assimilating', expand: 'Expanding' };
    return { id: actor.payload.role, label: labels[actor.payload.role] ?? 'Thinking', tone: 'thinking' };
  }
  const completedContacts = new Set(events.filter(event => ['contact.completed', 'contact.failed'].includes(event.type)).map(event => event.payload.binding));
  const contact = [...events].reverse().find(event => event.type === 'contact.started' && !completedContacts.has(event.payload.binding));
  if (contact) return { id: 'contact', label: `Contacting ${contact.payload.world}`, tone: 'tool' };
  if (audit.waitingUntil) return { id: 'waiting', label: 'Waiting', tone: 'quiet' };
  const operation = audit.operation?.operation;
  const labels = { select: 'Ready to select', realize: 'Ready to realize', contact: 'Ready for contact', correct: 'Ready to correct', assimilate: 'Ready to assimilate', expand: 'Ready to expand', wait: 'Waiting' };
  return { id: operation ?? 'ready', label: labels[operation] ?? 'Between acts', tone: operation === 'contact' ? 'tool' : 'ok' };
}

function projectActivity(events) {
  const completed = events.filter(event => event.type === 'operation.completed');
  return {
    eventCount: events.length,
    completedOperations: completed.length,
    developmentalRevisions: events.filter(event => event.type === 'subject.advanced' && event.payload.developmental).length,
    actorCalls: events.filter(event => event.type === 'actor.started').length,
    recoverableActorFailures: events.filter(event => event.type === 'actor.failed').length,
    latestEvent: events.at(-1) ? { sequence: events.at(-1).sequence, type: events.at(-1).type, at: events.at(-1).at } : null,
    latestCompletedOperation: completed.at(-1)?.payload ?? null,
  };
}

function displayContent(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['text', 'message', 'request', 'claim']) if (typeof value[key] === 'string') return value[key];
    if (typeof value.kind === 'string') return value.kind;
  }
  return JSON.stringify(value, null, 2);
}

function isStructuredContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length !== 1 || !['text', 'message', 'request'].includes(keys[0]);
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
