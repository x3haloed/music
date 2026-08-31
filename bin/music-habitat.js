#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHabitat, migrateHabitat, readHabitat, snapshotHabitat } from '../src/habitat.js';

const [command, root, ...args] = process.argv.slice(2);

try {
  if (!command || !root) usage();
  if (command === 'create') {
    const habitat = createHabitat(root, { modelConfigPath: args[0] });
    process.stdout.write(`${JSON.stringify({ ok: true, habitat }, null, 2)}\n`);
  } else if (command === 'snapshot') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...snapshotHabitat(root, args[0]) }, null, 2)}\n`);
  } else if (command === 'migrate') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...migrateHabitat(root) }, null, 2)}\n`);
  } else if (['init', 'reside', 'audit'].includes(command)) {
    const habitat = readHabitat(root);
    if (command === 'init' && existsSync(habitat.ledger)) throw new Error(`habitat already has a resident ledger: ${habitat.ledger}`);
    if (command !== 'init' && !existsSync(habitat.ledger)) throw new Error(`habitat has not been initialized: ${habitat.root}`);
    process.env.MUSIC_HOME = habitat.home;
    process.env.MUSIC_DEPENDENCY_ROOT = habitat.dependencies;
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
    process.argv = command === 'init'
      ? [process.execPath, cli, 'init', habitat.ledger, ...args]
      : command === 'reside'
        ? [process.execPath, cli, 'reside', habitat.ledger, habitat.modelConfig, habitat.mailbox, ...args]
        : [process.execPath, cli, 'audit', habitat.ledger];
    await import('../src/cli.js');
  } else usage();
} catch (error) {
  process.stderr.write(`music-habitat: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function usage() {
  throw new Error('usage: music-habitat <create|init|migrate|reside|audit|snapshot> HABITAT [arguments]');
}
