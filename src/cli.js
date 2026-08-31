#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { MusicKernel } from './kernel.js';
import { MusicMind } from './mind.js';
import { createConfiguredModel } from './provider.js';
import { submitWorldDelta } from './ingress.js';
import { MusicResident } from './resident.js';
import { archiveOutboundMessage, pendingOutboundMessages, submitMailboxMessage } from './mailbox.js';

const [command, ledger, ...args] = process.argv.slice(2);

try {
  if (!command || !ledger) usage();
  const mailboxRoot = command === 'reside' ? args[1] : (command === 'run' ? args[2] : undefined);
  const kernel = new MusicKernel(ledger, {
    toolEnvironment: {
      dependencyRoot: process.env.MUSIC_DEPENDENCY_ROOT ?? `${ledger}.dependencies`,
      ...(mailboxRoot === undefined ? {} : { mailboxRoot }),
    },
  });
  let result;
  let afterOutput = () => {};
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
    case 'talk':
    case 'reply': {
      const replyingToInvocationId = command === 'reply' ? args[0] : undefined;
      const sender = args[command === 'reply' ? 1 : 0];
      const content = args.slice(command === 'reply' ? 2 : 1).join(' ');
      const existing = new Set(pendingOutboundMessages(ledger).map(entry => entry.path));
      const submitted = submitMailboxMessage(ledger, {
        from: sender,
        content,
        ...(replyingToInvocationId === undefined ? {} : { bearsOnInvocationId: replyingToInvocationId }),
      });
      const reply = await waitForOutbound(
        ledger,
        entry => !existing.has(entry.path) && entry.message.replyToDeltaId === submitted.delta.id,
        talkTimeoutMs(),
      );
      result = {
        contactDeltaId: submitted.delta.id,
        ...(replyingToInvocationId === undefined ? {} : { bearsOnInvocationId: replyingToInvocationId }),
        message: reply.message,
      };
      afterOutput = () => archiveOutboundMessage(ledger, reply.path);
      break;
    }
    case 'listen': {
      const pending = pendingOutboundMessages(ledger);
      result = { messages: pending.map(entry => entry.message) };
      afterOutput = () => pending.forEach(entry => archiveOutboundMessage(ledger, entry.path));
      break;
    }
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
      const releaseWriter = kernel.acquireWriter('single inference run');
      try {
        kernel.recoverLedgerTail();
        kernel.recoverInterruptedInference('The previous Music process ended before its active inference could complete.');
        kernel.recoverInterruptedDeliveryProjections('The previous Music process ended before delivery projection completion was retained.');
        const configured = createConfiguredModel(readJsonFile(args[0]));
        await configured.preflight();
        const soundingId = kernel.state().openSoundingId ?? kernel.openSounding(args[1] ?? 'manual').id;
        result = await new MusicMind(kernel, configured, configured.inference).receive(soundingId);
      } finally {
        releaseWriter();
      }
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
  await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  afterOutput();
} catch (error) {
  process.stderr.write(`music: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function readJsonFile(path) {
  if (!path) throw new Error('missing JSON file path');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function usage() {
  throw new Error('usage: music <init|delta|submit|talk|reply|listen|sound|run|reside|audit> TARGET [arguments]');
}

function boundedInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function talkTimeoutMs() {
  const value = process.env.MUSIC_TALK_TIMEOUT_MS ?? '60000';
  const parsed = boundedInteger(value, 'MUSIC_TALK_TIMEOUT_MS');
  if (parsed > 300_000) throw new Error('MUSIC_TALK_TIMEOUT_MS must not exceed 300000');
  return parsed;
}

async function waitForOutbound(root, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = pendingOutboundMessages(root).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no mailbox reply arrived within ${timeoutMs}ms; the inbound message remains durable and 'music listen ${root}' can receive a later response`);
}

function writeStdout(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, error => error ? reject(error) : resolve());
  });
}
