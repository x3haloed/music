#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHabitat, readHabitat, snapshotHabitat } from '../src/habitat.js';

const [command, root, ...args] = process.argv.slice(2);

try {
  if (!command || !root) usage();
  if (command === 'create') {
    process.stdout.write(`${JSON.stringify({ ok: true, habitat: createHabitat(root) }, null, 2)}\n`);
  } else if (command === 'snapshot') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...snapshotHabitat(root, args[0]) }, null, 2)}\n`);
  } else if (['init', 'step', 'reside', 'audit', 'message', 'grant', 'revoke', 'outbox', 'events'].includes(command)) {
    const habitat = readHabitat(root);
    if (command === 'init' && existsSync(habitat.ledger)) throw new Error(`habitat already has a resident ledger: ${habitat.ledger}`);
    if (command !== 'init' && !existsSync(habitat.ledger)) throw new Error(`habitat has not been initialized: ${habitat.root}`);
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
    const mapped = command === 'reside' ? 'run' : command === 'audit' ? 'status' : command;
    process.argv = [process.execPath, cli, mapped, ...args, '--habitat', habitat.root];
    await import('../src/cli.js');
  } else usage();
} catch (error) {
  process.stderr.write(`music-habitat: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function usage() {
  throw new Error('usage: music-habitat <create|init|step|reside|audit|message|grant|revoke|outbox|events|snapshot> HABITAT [arguments]');
}
