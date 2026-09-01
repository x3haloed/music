#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rehearsalDigest } from '../src/rehearsal.js';
import { runtimeProvenance } from '../src/runtime-provenance.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const major = Number(process.versions.node.split('.')[0]);
const required = ['src/kernel.js', 'src/constitution.js', 'src/actor.js', 'src/world.js', 'src/residency.js', 'src/runtime-provenance.js', 'src/rehearsal.js', 'DESIGN.md', 'HATCH.md'];
const missing = required.filter(path => !existsSync(resolve(root, path)));
const report = {
  format: 'music-v3-doctor-1',
  version: pkg.version,
  node: process.version,
  nodeSupported: major >= 22,
  missing,
  rehearsalSpecSha256: rehearsalDigest(),
  runtime: runtimeProvenance(),
  ready: major >= 22 && missing.length === 0,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ready) process.exitCode = 1;
