#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildV1Successor, planV1Succession } from '../src/v1-migration.js';

const [command, snapshot, v1Release, destination] = process.argv.slice(2);

try {
  if (!['plan', 'build'].includes(command) || !snapshot || !v1Release) usage();
  const plan = await planV1Succession(snapshot, v1Release);
  if (command === 'plan') {
    if (destination) writeFileSync(resolve(destination), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, planDigest: plan.planDigest, report: plan.report, output: destination ? resolve(destination) : null }, null, 2)}\n`);
  } else {
    if (!destination) throw new Error('build requires a new empty target habitat path');
    const result = buildV1Successor(plan, snapshot, destination);
    process.stdout.write(`${JSON.stringify({
      ok: true, planDigest: result.planDigest, habitat: result.habitat.root, ledgerHead: result.ledgerHead,
      subject: result.state.subject, position: result.state.position.id, report: plan.report,
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`music-migrate-v1: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}

function usage() {
  throw new Error('usage: music-migrate-v1 <plan|build> V1_SNAPSHOT V1_RELEASE [PLAN_OUTPUT|NEW_V2_HABITAT]');
}
