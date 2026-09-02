#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecActor, OpenRouterActor, resolveCodexBinary } from './actor.js';
import { builtinWorlds, readOperatorOutbox } from './builtin-worlds.js';
import { digest } from './canonical.js';
import { DevelopmentalKernel } from './kernel.js';
import { RunSpecSchema } from './protocol.js';
import { runRehearsal } from './rehearsal.js';

const [command = 'help', ...args] = process.argv.slice(2);

try {
  if (command === 'init') initialize(args);
  else if (command === 'hatch') await hatch(args);
  else if (command === 'run') await run(args);
  else if (command === 'reside') await reside(args);
  else if (command === 'resident') await resident(args);
  else if (command === 'step') await step(args);
  else if (command === 'audit') audit(args);
  else if (command === 'outbox') outbox(args);
  else if (command === 'snapshot') snapshot(args);
  else if (command === 'upgrade') upgrade(args);
  else if (command === 'runtime-check') runtimeCheck(args);
  else if (command === 'observe') observe(args);
  else if (command === 'grant') grant(args, true);
  else if (command === 'revoke') grant(args, false);
  else if (command === 'worlds') listWorlds();
  else if (command === 'preflight') preflight(args);
  else if (command === 'template') template(args);
  else if (command === 'rehearse') await rehearse(args);
  else if (command === 'help' || command === '--help' || command === '-h') help();
  else throw new Error(`unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`music: ${error.message}\n`);
  process.exitCode = 1;
}

function initialize([rootArg, specArg]) {
  requireArgs(rootArg, specArg);
  const root = absolute(rootArg);
  const spec = readSpec(specArg);
  const kernel = new DevelopmentalKernel(root, { actor: actorFor(spec), worlds: builtinWorlds() });
  const state = kernel.initialize(spec);
  output({ format: 'music-v4-initialization-1', runId: state.runId, specId: spec.id, subjectId: state.subject.id, root });
}

async function hatch([rootArg, specArg]) {
  requireArgs(rootArg, specArg);
  const root = absolute(rootArg);
  const spec = readSpec(specArg);
  if (!['openrouter', 'codex'].includes(spec.inference.provider)) throw new Error('a hatch requires OpenRouter or Codex inference');
  const kernel = new DevelopmentalKernel(root, { actor: actorFor(spec), worlds: builtinWorlds() });
  kernel.initialize(spec);
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

async function resident([rootArg, specArg]) {
  requireArgs(rootArg, specArg);
  const root = absolute(rootArg);
  let kernel;
  if (existsSync(resolve(root, 'ledger.ndjson'))) {
    kernel = runtime(root);
  } else {
    const spec = readSpec(specArg);
    kernel = new DevelopmentalKernel(root, { actor: actorFor(spec), worlds: builtinWorlds() });
    kernel.initialize(spec);
  }
  const controller = residentController();
  try { await kernel.reside({ signal: controller.signal }); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  output(kernel.audit());
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
  output({ format: 'music-v4-operator-outbox-1', run: root, messages: readOperatorOutbox(root) });
}

function snapshot([rootArg, destinationArg]) {
  requireArgs(rootArg, destinationArg);
  output({ destination: absolute(destinationArg), manifest: new DevelopmentalKernel(absolute(rootArg)).snapshot(absolute(destinationArg)) });
}

function upgrade([rootArg, destinationArg, ...reasonParts]) {
  requireArgs(rootArg, destinationArg);
  const root = absolute(rootArg);
  const reader = new DevelopmentalKernel(root);
  const before = reader.state();
  if (!before.initialized) throw new Error(`run is not initialized: ${root}`);
  const kernel = new DevelopmentalKernel(root, { actor: actorFor(before.spec), worlds: builtinWorlds() });
  const state = kernel.upgradeRuntime({
    snapshotDestination: absolute(destinationArg),
    reason: reasonParts.join(' ') || 'explicit runtime maintenance',
    release: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  });
  kernel.requireRuntime(state.spec, state.runtime);
  output({
    format: 'music-v4-runtime-upgrade-result-1',
    run: root,
    subject: { id: state.subject.id, succession: state.subject.succession, revision: state.subject.revision },
    runtimeEpoch: state.runtimeEpochs.length,
    runtime: state.runtime,
    specId: state.spec.id,
    head: state.head,
    snapshot: state.runtimeEpochs.at(-1).snapshot,
  });
}

function runtimeCheck([rootArg]) {
  requireArgs(rootArg);
  const root = absolute(rootArg);
  const kernel = runtime(root);
  const state = kernel.state();
  kernel.requireRuntime(state.spec, state.runtime);
  output({
    format: 'music-v4-runtime-check-1', ready: true, run: root,
    subjectId: state.subject.id, runtimeEpoch: state.runtimeEpochs.length,
    implementationSha256: state.runtime.implementationSha256,
  });
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
  const state = new DevelopmentalKernel(absolute(rootArg)).setGrant(effect, active, { reason: reasonParts.join(' ') || 'operator decision' });
  output({ effect, active, effectiveGrants: state.effectiveGrants, head: state.head });
}

function listWorlds() {
  output([...builtinWorlds().adapters.values()].map(adapter => ({
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
  const spec = readSpec(specArg);
  const actor = actorFor(spec);
  if (digest(actor.describe()) !== digest(spec.inference)) throw new Error('inference binding does not match installed provider');
  output({ format: 'music-v4-inference-preflight-1', ...actor.preflight(), inference: actor.describe() });
}

function template([surface = 'starter', provider = 'openrouter', modelArg = null]) {
  const registry = builtinWorlds();
  const selected = surface === 'starter' || surface === 'all'
    ? [...registry.adapters.values()]
    : [registry.get(surface)].filter(Boolean);
  if (selected.length === 0) throw new Error(`unknown built-in world: ${surface}`);
  const actor = actorForChoice(provider, modelArg);
  output({
    format: 'music-v4-run-spec-1',
    id: 'replace-with-stable-resident-id',
    title: 'One continuing Music resident',
    inference: actor.describe(),
    worlds: selected.map(adapter => ({
      id: adapter.id,
      adapter: adapter.id,
      adapterIdentity: adapter.identity,
      attestationTypes: adapter.attestationTypes,
      description: adapter.description,
      publicContract: adapter.publicContract,
    })),
    grants: [...new Set(selected.flatMap(adapter => adapter.effects))].sort(),
    initialSubject: {},
    limits: {
      maxOperations: 100_000,
      maxActorCalls: 100_000,
      maxRealizationAttempts: 4,
      maxContactAttempts: 8,
      residentRetryDelayMs: 5_000,
      continuityPulseMs: 300_000,
      projectionHistoryEntries: 16,
      maximumInputTokens: 200_000,
      maximumInputCharacters: 900_000,
    },
    stoppingRule: 'The observer may stop the process without closing the subject; the exact run remains restartable.',
  });
}

async function rehearse([destinationArg]) {
  requireArgs(destinationArg);
  output({ destination: absolute(destinationArg), report: await runRehearsal(absolute(destinationArg)) });
}

function runtime(root) {
  const reader = new DevelopmentalKernel(root);
  const state = reader.state();
  if (!state.initialized) throw new Error(`run is not initialized: ${root}`);
  return new DevelopmentalKernel(root, { actor: actorFor(state.spec), worlds: builtinWorlds() });
}

function actorFor(spec) {
  if (spec.inference.provider === 'openrouter') {
    if (!approvedOpenRouterModels().includes(spec.inference.model)) {
      throw new Error(`OpenRouter model is outside MUSIC_ALLOWED_OPENROUTER_MODELS: ${spec.inference.model}`);
    }
    return new OpenRouterActor({ model: spec.inference.model, ...spec.inference.settings });
  }
  if (spec.inference.provider === 'codex') {
    return new CodexExecActor({ model: spec.inference.model, binary: resolveCodexBinary(), ...spec.inference.settings });
  }
  throw new Error(`CLI cannot construct inference provider: ${spec.inference.provider}`);
}

function actorForChoice(provider, modelArg) {
  if (!['openrouter', 'codex'].includes(provider)) throw new Error(`unknown inference provider: ${provider}`);
  return provider === 'codex'
    ? new CodexExecActor({ model: modelArg ?? 'gpt-5.6-luna', binary: resolveCodexBinary(), reasoningEffort: 'low' })
    : new OpenRouterActor({ model: modelArg ?? 'z-ai/glm-5.3-flash', apiKey: null });
}

function readSpec(value) { return RunSpecSchema.parse(JSON.parse(readFileSync(absolute(value), 'utf8'))); }
function approvedOpenRouterModels() { return (process.env.MUSIC_ALLOWED_OPENROUTER_MODELS ?? 'z-ai/glm-5.3-flash').split(',').map(value => value.trim()).filter(Boolean); }
function absolute(value) { return isAbsolute(value) ? value : resolve(process.cwd(), value); }
function requireArgs(...values) { if (values.some(value => !value)) throw new Error('missing required argument; run `music help`'); }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function parseJsonArgument(value) { try { return JSON.parse(value); } catch { return value; } }

function residentController() {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('resident loop stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller;
}

function help() {
  process.stdout.write(`Music v4\n\nCommands:\n  init RUN SPEC\n  hatch RUN SPEC\n  resident RUN SPEC\n  run RUN\n  reside RUN\n  step RUN\n  observe RUN CONTENT_OR_@FILE [CHANNEL] [FROM]\n  outbox RUN\n  grant RUN EFFECT [REASON]\n  revoke RUN EFFECT [REASON]\n  audit RUN\n  snapshot RUN DESTINATION\n  upgrade RUN SNAPSHOT [REASON]\n  runtime-check RUN\n  worlds\n  preflight SPEC\n  template [starter|WORLD] [openrouter|codex] [MODEL]\n  rehearse DESTINATION\n`);
}
