#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { DevelopmentalOrgan } from './organ.js';
import { MusicKernel } from './kernel.js';
import { DEFAULT_MODEL, PerspectiveEngine } from './perspective.js';
import { nextEncounterAt, retainedFailureBackoff } from './recurrence.js';
import { readHabitat } from './habitat.js';
import { runtimeProvenance } from './runtime-provenance.js';
import { archiveOutboundMessage, drainInboundMessages, pendingOutboundMessages, submitInboundMessage } from './mailbox.js';

const { command, options, positionals } = parse(process.argv.slice(2));

try {
  const habitat = resolve(options.habitat ?? process.env.MUSIC_HABITAT ?? '');
  if (!options.habitat && !process.env.MUSIC_HABITAT) {
    throw new Error('set MUSIC_HABITAT or pass --habitat');
  }
  if (existsSync(join(habitat, 'habitat.json'))) process.chdir(readHabitat(habitat).home);
  const kernel = new MusicKernel(habitat);
  const preparedHabitat = existsSync(join(habitat, 'habitat.json'));
  if (command === 'init') {
    const state = kernel.initialize(options.designation ?? null);
    print({ subject: state.subject, position: state.position.id, habitat });
  } else if (command === 'grant' || command === 'revoke') {
    const capability = positionals[0];
    if (!capability) throw new Error(`${command} requires a capability`);
    const grants = kernel.governance.set(capability, command === 'grant', options.by ?? 'local operator');
    print(grants.find(grant => grant.capability === capability));
  } else if (command === 'message') {
    const content = options.content ?? (options.stdin ? readFileSync(0, 'utf8') : null);
    if (preparedHabitat) {
      if (!kernel.state().subject) throw new Error('initialize the habitat first');
      print(submitInboundMessage(habitat, {
        sender: options.from, recipient: options.to ?? 'the entity', channel: options.channel ?? 'inbox',
        content, authentication: options.authentication ?? null,
      }));
    } else {
      print(kernel.receiveMessage({
        sender: options.from, recipient: options.to ?? 'the entity', channel: options.channel ?? 'inbox',
        content, authentication: options.authentication ?? null,
      }));
    }
  } else if (command === 'observe') {
    const value = JSON.parse(options.json ?? readFileSync(0, 'utf8'));
    print(kernel.receiveObservation(value));
  } else if (command === 'status') {
    print(projectStatus(kernel.state(), kernel.governance.read()));
  } else if (command === 'events') {
    const count = Number(options.count ?? 20);
    print(kernel.ledger.read().slice(-count));
  } else if (command === 'outbox') {
    print(preparedHabitat
      ? pendingOutboundMessages(habitat).map(value => value.message)
      : kernel.state().observations.filter(value => value.kind === 'message.outbound'));
  } else if (command === 'ack') {
    if (!preparedHabitat) throw new Error('ack requires a prepared habitat');
    const messageId = positionals[0];
    const selected = pendingOutboundMessages(habitat).find(value => value.message.messageId === messageId);
    if (!selected) throw new Error(`unknown pending outbound message: ${messageId}`);
    print({ messageId, archived: archiveOutboundMessage(habitat, selected.path) });
  } else if (command === 'step') {
    kernel.receiveObservation(runtimeProvenance(habitat, 'single-opening'));
    print(await step(kernel, options));
  } else if (command === 'run') {
    kernel.receiveObservation(runtimeProvenance(habitat, 'resident'));
    await run(kernel, options);
  } else {
    usage(command ? `unknown command: ${command}` : null);
  }
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}

async function step(kernel, options) {
  const state = kernel.state();
  if (!state.subject) throw new Error('initialize the habitat first');
  kernel.recoverInterruptedPerspectives();
  const engine = new PerspectiveEngine(kernel, inferenceOptions(options));
  const result = await new DevelopmentalOrgan(kernel, engine).open();
  return {
    wager: result.election?.output.selectedWagerId ?? result.wagerId,
    outcome: result.realized.evaluation.kind,
    position: (result.position ?? result.realized.position)?.id ?? kernel.state().position.id,
    generation: kernel.state().position.generation,
    assimilation: result.assimilation ? result.assimilation.output.disposition : null,
  };
}

async function run(kernel, options) {
  const continuityMs = integerOption(options.continuityMs ?? process.env.MUSIC_CONTINUITY_MS ?? 30 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000, 'continuityMs');
  const minimumCycleMs = integerOption(options.minimumCycleMs ?? process.env.MUSIC_MINIMUM_CYCLE_MS ?? 60_000, 0, continuityMs, 'minimumCycleMs');
  const pollMs = integerOption(options.pollMs ?? process.env.MUSIC_POLL_MS ?? 250, 50, 60_000, 'pollMs');
  const failureBackoffMs = integerOption(options.failureBackoffMs ?? process.env.MUSIC_FAILURE_BACKOFF_MS ?? 5_000, 100, 60 * 60_000, 'failureBackoffMs');
  const maximumFailureBackoffMs = integerOption(options.maximumFailureBackoffMs ?? process.env.MUSIC_MAXIMUM_FAILURE_BACKOFF_MS ?? 5 * 60_000, failureBackoffMs, 24 * 60 * 60_000, 'maximumFailureBackoffMs');
  let stopping = false;
  let lastEncounterAt = null;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    const state = kernel.state();
    if (!state.subject) throw new Error('initialize the habitat first');
    const now = Date.now();
    const contact = existsSync(join(kernel.habitat, 'habitat.json'))
      ? drainInboundMessages(kernel.habitat, kernel)
      : [];
    const backoff = retainedFailureBackoff(kernel.ledger.read(), now, failureBackoffMs, maximumFailureBackoffMs);
    if (backoff) {
      await interruptibleDelay(Math.min(pollMs, backoff.remainingMs), () => stopping);
      continue;
    }
    if (contact.length === 0) {
      const due = nextEncounterAt({
        now, notBefore: state.position.activeOpening.notBefore, lastEncounterAt, minimumCycleMs, continuityMs,
      });
      if (due > now) {
        await interruptibleDelay(Math.min(pollMs, due - now), () => stopping);
        continue;
      }
    }
    if (stopping) break;
    const current = kernel.state();
    const openingDue = current.position.activeOpening.notBefore === null ||
      Date.parse(current.position.activeOpening.notBefore) <= Date.now();
    if (contact.length === 0) {
      kernel.receiveObservation({
        kind: 'continuity.heartbeat', instruction: null, openingDue,
        pendingOpening: current.position.activeOpening, provenance: { scheduler: 'music-v2-recurrence-1' },
      });
    }
    try {
      const result = await step(kernel, options);
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} cycle failed: ${error?.message ?? error}\n`);
    } finally {
      lastEncounterAt = Date.now();
    }
  }
}

function inferenceOptions(options) {
  const keyFile = options.keyFile ?? process.env.MUSIC_OPENROUTER_KEY_FILE;
  const apiKey = keyFile ? readFileSync(resolve(keyFile), 'utf8').trim() : process.env.OPENROUTER_API_KEY;
  const model = options.model ?? process.env.MUSIC_MODEL ?? DEFAULT_MODEL;
  if (model !== DEFAULT_MODEL) {
    throw new Error(`this release permits only ${DEFAULT_MODEL}; model expansion requires an explicit governance change`);
  }
  return {
    apiKey,
    model,
    maxOutputTokens: integerOption(options.maxOutputTokens ?? process.env.MUSIC_MAX_OUTPUT_TOKENS ?? 15_000, 256, 32_768, 'maxOutputTokens'),
    timeoutMs: integerOption(options.inferenceTimeoutMs ?? process.env.MUSIC_INFERENCE_TIMEOUT_MS ?? 120_000, 1_000, 10 * 60_000, 'inferenceTimeoutMs'),
    reasoningEffort: options.reasoningEffort ?? process.env.MUSIC_REASONING_EFFORT ?? 'low',
  };
}

function projectStatus(state, grants) {
  return {
    subject: state.subject,
    position: state.position && {
      id: state.position.id,
      parent: state.position.parent,
      generation: state.position.generation,
      activeOpening: state.position.activeOpening,
    },
    observations: state.observations.length,
    perspectives: Object.fromEntries([...state.perspectives.values()].map(value => [value.status, 0]).map(([key]) => [key, [...state.perspectives.values()].filter(value => value.status === key).length])),
    activeWager: state.election,
    development: [...state.development.values()].map(value => ({ id: value.id, status: value.status, wagerId: value.wagerId })),
    grants,
    resources: state.resources,
    ledgerHead: state.head,
  };
}

function parse(args) {
  const [command, ...rest] = args;
  const options = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (name === 'stdin') options[name] = true;
    else {
      if (rest[index + 1] === undefined) throw new Error(`missing value for ${token}`);
      options[name] = rest[++index];
    }
  }
  return { command, options, positionals };
}

function integerOption(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

async function interruptibleDelay(milliseconds, stopped) {
  const end = Date.now() + milliseconds;
  while (!stopped() && Date.now() < end) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(1_000, end - Date.now())));
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(error) {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write(`Usage: music <command> --habitat PATH\n\nCommands:\n  init [--designation NAME]\n  grant CAPABILITY [--by PRINCIPAL]\n  revoke CAPABILITY [--by PRINCIPAL]\n  message --from SENDER (--content TEXT | --stdin)\n  observe (--json JSON | stdin)\n  status\n  events [--count N]\n  outbox\n  ack MESSAGE_ID\n  step [--key-file PATH] [--model ID]\n  run [--continuity-ms N] [--minimum-cycle-ms N] [--poll-ms N] [inference options]\n`);
  process.exitCode = 1;
}
