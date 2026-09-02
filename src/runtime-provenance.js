import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './canonical.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const implementationFiles = [
  'src/actor.js',
  'src/builtin-worlds.js',
  'src/canonical.js',
  'src/cli.js',
  'src/kernel.js',
  'src/local-worlds.js',
  'src/operation.js',
  'src/predicate.js',
  'src/protocol.js',
  'src/rehearsal.js',
  'src/residency.js',
  'src/runtime-provenance.js',
  'src/store.js',
  'src/subject.js',
  'src/world.js',
];

export function runtimeProvenance() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const sources = Object.fromEntries(implementationFiles.map(path => [path, sha256(readFileSync(resolve(root, path)))]));
  const lockPath = resolve(root, 'package-lock.json');
  const implementation = {
    packageVersion: pkg.version,
    sources,
    dependencyLockSha256: existsSync(lockPath) ? sha256(readFileSync(lockPath)) : null,
  };
  const body = {
    format: 'music-v4-runtime-provenance-1',
    node: process.version,
    ...implementation,
  };
  return { ...body, implementationSha256: digest(implementation) };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
