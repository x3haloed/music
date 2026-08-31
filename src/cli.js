#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { MusicKernel } from './kernel.js';
import { MusicMind } from './mind.js';
import { createConfiguredModel } from './provider.js';

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
    case 'sound':
      result = kernel.openSounding(args[0] ?? 'manual');
      break;
    case 'revise':
      result = kernel.activateToolRevision(readJsonFile(args[0]));
      break;
    case 'invoke':
      result = kernel.invokeTool(args[0], args[1], JSON.parse(args[2] ?? '{}'), { soundingId: args[3] ?? null });
      break;
    case 'audit':
      result = kernel.audit();
      break;
    case 'run': {
      kernel.recoverInterruptedInference('The previous Music process ended before its active inference could complete.');
      const configured = createConfiguredModel(readJsonFile(args[0]));
      await configured.preflight();
      const sounding = kernel.openSounding(args[1] ?? 'manual');
      result = await new MusicMind(kernel, configured).receive(sounding);
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
  throw new Error('usage: music <init|delta|sound|revise|invoke|run|audit> LEDGER [arguments]');
}
