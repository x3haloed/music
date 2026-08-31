#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { MusicKernel } from './kernel.js';
import { MusicMind } from './mind.js';
import { createConfiguredModel } from './provider.js';
import { submitWorldDelta } from './ingress.js';
import { MusicResident } from './resident.js';

const [command, ledger, ...args] = process.argv.slice(2);

try {
  if (!command || !ledger) usage();
  const kernel = new MusicKernel(ledger);
  let result;
  switch (command) {
    case 'init':
      result = kernel.initialize(args.join(' '));
      result = { subject: result.subject, head: result.head };
      break;
    case 'delta':
      result = kernel.admitDelta(readJsonFile(args[0]));
      result = { head: result.head, pendingDeltas: result.pendingDeltas.length };
      break;
    case 'submit':
      result = { path: submitWorldDelta(ledger, readJsonFile(args[0])) };
      break;
    case 'sound':
      result = kernel.openSounding(args[0] ?? 'manual');
      break;
    case 'revise':
    case 'invoke':
      throw new Error(`${command} is agent-authority behavior and is only available inside an active Music inference`);
    case 'audit':
      result = kernel.audit();
      break;
    case 'run': {
      kernel.recoverInterruptedInference('The previous Music process ended before its active inference could complete.');
      const configured = createConfiguredModel(readJsonFile(args[0]));
      await configured.preflight();
      const soundingId = kernel.state().openSoundingId ?? kernel.openSounding(args[1] ?? 'manual').id;
      result = await new MusicMind(kernel, configured, configured.inference).receive(soundingId);
      break;
    }
    case 'reside': {
      const configured = createConfiguredModel(readJsonFile(args[0]));
      await configured.preflight();
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const resident = new MusicResident(
        kernel,
        new MusicMind(kernel, configured, configured.inference),
        {
          ingress: args[1],
          ...(args[2] === undefined ? {} : { pollMs: boundedInteger(args[2], 'pollMs') }),
          ...(args[3] === undefined ? {} : { heartbeatMs: boundedInteger(args[3], 'heartbeatMs') }),
          onError: error => process.stderr.write(`music resident: ${error instanceof Error ? error.message : String(error)}\n`),
        },
      );
      await resident.run({ signal: controller.signal });
      result = kernel.audit();
      break;
    }
    default:
      usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`music: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function readJsonFile(path) {
  if (!path) throw new Error('missing JSON file path');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function usage() {
  throw new Error('usage: music <init|delta|submit|sound|run|reside|audit> TARGET [arguments]');
}

function boundedInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
