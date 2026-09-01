#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { CodexExecActor, OpenRouterActor } from './actor.js';
import { builtinWorlds, readOperatorOutbox } from './builtin-worlds.js';
import { digest } from './canonical.js';
import { DevelopmentalKernel } from './kernel.js';
import { RunSpecSchema } from './protocol.js';
import { runRehearsal } from './rehearsal.js';

const [command = 'help', ...args] = process.argv.slice(2);

try {
  if (command === 'init') await initialize(args);
  else if (command === 'continue') await continueRun(args);
  else if (command === 'successor-template') successorTemplate(args);
  else if (command === 'hatch') await hatch(args);
  else if (command === 'run') await run(args);
  else if (command === 'reside') await reside(args);
  else if (command === 'step') await step(args);
  else if (command === 'audit') audit(args);
  else if (command === 'outbox') outbox(args);
  else if (command === 'snapshot') snapshot(args);
  else if (command === 'observe') observe(args);
  else if (command === 'grant') grant(args, true);
  else if (command === 'revoke') grant(args, false);
  else if (command === 'rehearse') await rehearse(args);
  else if (command === 'worlds') worlds();
  else if (command === 'preflight') preflight(args);
  else if (command === 'template') template(args);
  else if (command === 'help' || command === '--help' || command === '-h') help();
  else throw new Error(`unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`music: ${error.message}\n`);
  process.exitCode = 1;
}

async function initialize([rootArg, specArg, condition = 'active']) {
  requireArgs(rootArg, specArg);
  const root = absolute(rootArg);
  const spec = RunSpecSchema.parse(JSON.parse(readFileSync(absolute(specArg), 'utf8')));
  const worlds = builtinWorlds();
  const actor = actorFor(spec);
  const kernel = new DevelopmentalKernel(root, { actor, worlds });
  const state = kernel.initialize(spec, { condition });
  output({ runId: state.runId, specId: spec.id, condition, subjectId: state.subject.id, root });
}

async function continueRun([rootArg, specArg, priorRootArg, condition = 'active']) {
  requireArgs(rootArg, specArg, priorRootArg);
  const root = absolute(rootArg);
  const priorKernel = new DevelopmentalKernel(absolute(priorRootArg));
  const prior = priorKernel.state();
  if (!prior.initialized) throw new Error('predecessor run is not initialized');
  if (prior.subject.continuation.kind === 'stop') throw new Error('predecessor subject chose closure');
  const spec = RunSpecSchema.parse(JSON.parse(readFileSync(absolute(specArg), 'utf8')));
  if (spec.inheritedSubjectId !== prior.subject.id) throw new Error('successor spec does not bind the predecessor subject id');
  const kernel = new DevelopmentalKernel(root, { actor: actorFor(spec), worlds: builtinWorlds() });
  const state = kernel.initialize(spec, {
    condition,
    inheritedSubject: prior.subject,
    predecessor: { runId: prior.runId, head: prior.head, subjectId: prior.subject.id },
    predecessorStore: priorKernel.store,
  });
  output({ runId: state.runId, specId: spec.id, condition, subjectId: state.subject.id, predecessor: state.predecessor, root });
}

async function hatch([rootArg, specArg, condition = 'active']) {
  requireArgs(rootArg, specArg);
  const root = absolute(rootArg);
  const spec = RunSpecSchema.parse(JSON.parse(readFileSync(absolute(specArg), 'utf8')));
  if (!['openrouter', 'codex'].includes(spec.inference.provider)) throw new Error('a hatch requires a hosted inference provider');
  const kernel = new DevelopmentalKernel(root, { actor: actorFor(spec), worlds: builtinWorlds() });
  kernel.initialize(spec, { condition });
  const controller = residentController();
  try { await kernel.reside({ signal: controller.signal }); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  output(kernel.audit());
}

async function run([rootArg]) {
  requireArgs(rootArg);
  const kernel = runtime(absolute(rootArg));
  await kernel.run();
  output(kernel.audit());
}

async function step([rootArg]) {
  requireArgs(rootArg);
  const kernel = runtime(absolute(rootArg));
  await kernel.advance();
  output(kernel.audit());
}

async function reside([rootArg]) {
  requireArgs(rootArg);
  const kernel = runtime(absolute(rootArg));
  const controller = residentController();
  try { await kernel.reside({ signal: controller.signal }); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  output(kernel.audit());
}

function residentController() {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('resident loop stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller;
}

function audit([rootArg]) {
  requireArgs(rootArg);
  const root = absolute(rootArg);
  if (!existsSync(root)) throw new Error(`run does not exist: ${root}`);
  output(new DevelopmentalKernel(root).audit());
}

function outbox([rootArg]) {
  requireArgs(rootArg);
  const root = absolute(rootArg);
  if (!existsSync(root)) throw new Error(`run does not exist: ${root}`);
  output({ format: 'music-v3-operator-outbox-1', run: root, messages: readOperatorOutbox(root) });
}

function snapshot([rootArg, destinationArg]) {
  requireArgs(rootArg, destinationArg);
  const kernel = new DevelopmentalKernel(absolute(rootArg));
  output({ destination: absolute(destinationArg), manifest: kernel.snapshot(absolute(destinationArg)) });
}

function observe([rootArg, contentArg, channel = 'operator', from = 'operator']) {
  requireArgs(rootArg, contentArg);
  const kernel = new DevelopmentalKernel(absolute(rootArg));
  const content = contentArg.startsWith('@')
    ? JSON.parse(readFileSync(absolute(contentArg.slice(1)), 'utf8'))
    : parseJsonArgument(contentArg);
  const state = kernel.receiveObservation({ channel, from, content });
  output({ accepted: true, pendingObservations: state.pendingObservations.length, head: state.head });
}

function grant([rootArg, effect, ...reasonParts], active) {
  requireArgs(rootArg, effect);
  const kernel = new DevelopmentalKernel(absolute(rootArg));
  const state = kernel.setGrant(effect, active, { reason: reasonParts.join(' ') || 'operator decision' });
  output({ effect, active, effectiveGrants: state.effectiveGrants, head: state.head });
}

async function rehearse([rootArg]) {
  const root = rootArg ? absolute(rootArg) : mkdtempSync(resolve(tmpdir(), 'music-v3-rehearsal-'));
  if (!rootArg) {
    // runRehearsal requires ownership of a not-yet-created path.
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });
  }
  const report = await runRehearsal(root);
  output({ root, report });
}

function runtime(root) {
  const reader = new DevelopmentalKernel(root);
  const state = reader.state();
  if (!state.initialized) throw new Error(`run is not initialized: ${root}`);
  return new DevelopmentalKernel(root, { actor: actorFor(state.spec), worlds: builtinWorlds() });
}

function actorFor(spec) {
  if (spec.inference.provider === 'openrouter') {
    const approved = approvedOpenRouterModels();
    if (!approved.includes(spec.inference.model)) {
      throw new Error(`OpenRouter model is outside MUSIC_ALLOWED_OPENROUTER_MODELS: ${spec.inference.model}`);
    }
    return new OpenRouterActor({ model: spec.inference.model, ...spec.inference.settings });
  }
  if (spec.inference.provider === 'codex') return new CodexExecActor({
    model: spec.inference.model,
    binary: process.env.MUSIC_CODEX_BINARY ?? 'codex',
    ...spec.inference.settings,
  });
  throw new Error(`CLI cannot construct inference provider: ${spec.inference.provider}`);
}

function approvedOpenRouterModels() {
  return (process.env.MUSIC_ALLOWED_OPENROUTER_MODELS ?? 'z-ai/glm-5.3-flash')
    .split(',').map(value => value.trim()).filter(Boolean);
}

function worlds() {
  const registry = builtinWorlds();
  output([...registry.adapters.values()].map(adapter => ({
    id: adapter.id,
    version: adapter.version,
    identity: adapter.identity,
    description: adapter.description,
    effects: adapter.effects,
    attestationTypes: adapter.attestationTypes,
    publicContract: adapter.publicContract,
  })));
}

function preflight([specArg]) {
  requireArgs(specArg);
  const spec = RunSpecSchema.parse(JSON.parse(readFileSync(absolute(specArg), 'utf8')));
  const actor = actorFor(spec);
  if (digest(actor.describe()) !== digest(spec.inference)) throw new Error('inference binding does not match the installed provider');
  const result = actor.preflight();
  output({ format: 'music-v3-inference-preflight-1', ...result, inference: actor.describe() });
}

function successorTemplate([priorRootArg, provider = 'codex', modelArg = null]) {
  requireArgs(priorRootArg);
  const priorRoot = absolute(priorRootArg);
  if (residentIsRunning(priorRoot)) throw new Error('predecessor resident must be stopped before sealing a successor');
  const prior = new DevelopmentalKernel(priorRoot).state();
  if (!prior.initialized) throw new Error('predecessor run is not initialized');
  if (prior.subject.continuation.kind === 'stop') throw new Error('predecessor subject chose closure');
  const registry = builtinWorlds();
  const worlds = prior.spec.worlds.map(world => {
    const adapter = registry.get(world.adapter);
    if (!adapter) throw new Error(`successor release has no world adapter: ${world.adapter}`);
    return {
      id: world.id,
      adapter: adapter.id,
      adapterIdentity: adapter.identity,
      attestationTypes: adapter.attestationTypes,
      description: adapter.description,
      publicContract: adapter.publicContract,
    };
  });
  const actor = actorForChoice(provider, modelArg);
  output({
    format: 'music-v3-run-spec-1',
    id: 'replace-with-stable-successor-id',
    title: `Successor of ${prior.spec.title}`,
    hypothesis: prior.spec.hypothesis,
    cheapestFalsifier: prior.spec.cheapestFalsifier,
    inference: actor.describe(),
    worlds,
    grants: prior.spec.grants,
    initialSubject: {},
    inheritedSubjectId: prior.subject.id,
    conditions: prior.spec.conditions,
    limits: prior.spec.limits,
    stoppingRule: prior.spec.stoppingRule,
  });
}

function residentIsRunning(root) {
  const leasePath = resolve(root, 'resident.lock');
  if (!existsSync(leasePath)) return false;
  try {
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (!Number.isInteger(lease.pid) || lease.pid <= 0) return false;
    process.kill(lease.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function template([adapterId = 'http-json', provider = 'openrouter', modelArg = null]) {
  const registry = builtinWorlds();
  const adapter = registry.get(adapterId);
  if (!adapter) throw new Error(`unknown built-in world: ${adapterId}`);
  const actor = actorForChoice(provider, modelArg);
  output({
    format: 'music-v3-run-spec-1',
    id: 'replace-with-stable-observation-id',
    title: 'Replace with the bounded developmental observation',
    hypothesis: 'State the prospectively frozen causal hypothesis.',
    cheapestFalsifier: 'State the cheapest result that ends this observation.',
    inference: actor.describe(),
    worlds: [{
      id: 'primary-world',
      adapter: adapter.id,
      adapterIdentity: adapter.identity,
      attestationTypes: adapter.attestationTypes,
      description: adapter.description,
      publicContract: adapter.publicContract,
    }],
    grants: adapter.effects,
    initialSubject: {
      stakes: {}, mechanisms: {}, language: {}, authority: {}, memory: {}, floors: [],
      continuation: { kind: 'continue', focus: 'Originate one bounded falsifiable contact with the available world.', notBefore: null },
    },
    conditions: [{ id: 'active', interventions: [] }],
    limits: { maxCycles: 20, maxActorCalls: 80, maxChallengeAttempts: 3, maxContactAttempts: 8, residentRetryDelayMs: 5000, continuityPulseMs: 300_000, projectionHistoryEntries: 16 },
    stoppingRule: 'Stop after twenty promoted cycles, subject-authored closure, or the first invalid transition.',
  });
}

function actorForChoice(provider, modelArg) {
  if (provider === 'codex-exec') provider = 'codex';
  if (!['openrouter', 'codex'].includes(provider)) throw new Error(`unknown inference provider: ${provider}`);
  return provider === 'codex'
    ? new CodexExecActor({ model: modelArg ?? 'gpt-5.6-luna', binary: process.env.MUSIC_CODEX_BINARY ?? 'codex', reasoningEffort: 'low' })
    : new OpenRouterActor({ model: modelArg ?? 'z-ai/glm-5.3-flash', apiKey: null });
}

function absolute(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function requireArgs(...values) {
  if (values.some(value => !value)) throw new Error('missing required argument; run `music help`');
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonArgument(value) {
  try { return JSON.parse(value); }
  catch { return value; }
}

function help() {
  process.stdout.write(`Music v3\n\nCommands:\n  init RUN SPEC [CONDITION]\n  hatch RUN SPEC [CONDITION]\n  continue RUN SPEC PREDECESSOR_RUN [CONDITION]\n  successor-template PREDECESSOR_RUN [openrouter|codex] [MODEL]\n  run RUN\n  reside RUN\n  step RUN\n  observe RUN CONTENT_OR_@FILE [CHANNEL] [FROM]\n  outbox RUN\n  grant RUN EFFECT [REASON]\n  revoke RUN EFFECT [REASON]\n  audit RUN\n  snapshot RUN DESTINATION\n  worlds\n  preflight SPEC\n  template [WORLD_ADAPTER] [openrouter|codex] [MODEL]\n  rehearse [OUTPUT]\n`);
}
