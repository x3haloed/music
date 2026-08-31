#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const CORE_PATHS = [
  'package.json',
  'package-lock.json',
  'bin/music-doctor.js',
  'bin/music-habitat.js',
  'src/canonical.js',
  'src/carrier.js',
  'src/cli.js',
  'src/ingress.js',
  'src/habitat.js',
  'src/kernel.js',
  'src/mailbox.js',
  'src/mind.js',
  'src/provider.js',
  'src/resident.js',
  'src/runtime-provenance.js',
  'src/tool-module.js',
];

const [command = 'check', rootArgument = process.cwd()] = process.argv.slice(2);

try {
  const root = resolve(rootArgument);
  if (!['check', 'restore'].includes(command)) usage();
  git(root, ['rev-parse', '--show-toplevel']);
  const files = CORE_PATHS.map(path => compare(root, path));
  const changed = files.filter(file => !file.matches);
  if (command === 'check') {
    process.stdout.write(`${JSON.stringify({ ok: changed.length === 0, root, changed: changed.map(publicDifference) }, null, 2)}\n`);
    if (changed.length > 0) process.exitCode = 1;
  } else {
    const backupRoot = changed.length === 0 ? null : join(root, '.music', 'bootstrap-recovery', safeTimestamp());
    for (const file of changed) restore(root, file, backupRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, root, restored: changed.map(file => file.path), backupRoot }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`music-doctor: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function compare(root, path) {
  const expected = git(root, ['show', `HEAD:${path}`], null);
  const absolute = join(root, path);
  const actual = existsSync(absolute) ? readFileSync(absolute) : null;
  return {
    path,
    matches: actual !== null && expected.equals(actual),
    expectedSha256: sha256(expected),
    actualSha256: actual === null ? null : sha256(actual),
    missing: actual === null,
    expected,
  };
}

function restore(root, file, backupRoot) {
  const absolute = join(root, file.path);
  if (existsSync(absolute)) {
    const backup = join(backupRoot, file.path);
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    copyFileSync(absolute, backup);
  }
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.music-doctor-${process.pid}.tmp`;
  writeFileSync(temporary, file.expected, { mode: executable(file.path) ? 0o755 : 0o644 });
  renameSync(temporary, absolute);
  chmodSync(absolute, executable(file.path) ? 0o755 : 0o644);
}

function publicDifference({ expected: _, ...difference }) {
  return difference;
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], { encoding, maxBuffer: 8 * 1024 * 1024 });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(':', '-');
}

function executable(path) {
  return path === 'src/cli.js' || path.startsWith('bin/');
}

function usage() {
  throw new Error('usage: music-doctor <check|restore> [REPOSITORY_ROOT]');
}
