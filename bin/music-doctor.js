#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeProvenance } from '../src/runtime-provenance.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const major = Number(process.versions.node.split('.')[0]);
const required = [
  'src/actor.js', 'src/attention.js', 'src/kernel.js', 'src/operation.js',
  'src/protocol.js', 'src/subject.js', 'src/world.js', 'src/builtin-worlds.js',
  'src/rehearsal.js',
  'src/local-worlds.js', 'src/store.js', 'src/residency.js',
  'src/runtime-provenance.js', 'src/install.js', 'DESIGN.md', 'HATCH.md',
];
const missing = required.filter(path => !existsSync(resolve(root, path)));
const report = {
  format: 'music-v4-doctor-1',
  version: pkg.version,
  node: process.version,
  nodeSupported: major >= 22,
  missing,
  runtime: runtimeProvenance(),
  ready: major >= 22 && missing.length === 0,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ready) process.exitCode = 1;
