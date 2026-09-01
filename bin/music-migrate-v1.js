#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildV1Successor, planV1Succession, verifyV1Successor } from '../src/v1-migration.js';

const [command, snapshot, v1Release, destination] = process.argv.slice(2);

try {
  if (!['plan', 'build', 'verify'].includes(command) || !snapshot || !v1Release) usage();
  const plan = await planV1Succession(snapshot, v1Release);
  if (command === 'plan') {
    if (destination) writeFileSync(resolve(destination), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, planDigest: plan.planDigest, report: plan.report, output: destination ? resolve(destination) : null }, null, 2)}\n`);
  } else {
    if (!destination) throw new Error(`${command} requires a successor habitat path`);
    if (command === 'build') {
      buildV1Successor(plan, snapshot, destination);
      const result = verifyV1Successor(plan, snapshot, destination);
      process.stdout.write(`${JSON.stringify({ ...result, report: plan.report }, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(verifyV1Successor(plan, snapshot, destination), null, 2)}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`music-migrate-v1: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}

function usage() {
  throw new Error('usage: music-migrate-v1 <plan|build|verify> V1_SNAPSHOT V1_RELEASE [PLAN_OUTPUT|V2_HABITAT]');
}
