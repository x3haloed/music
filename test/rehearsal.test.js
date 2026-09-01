import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/canonical.js';
import { DevelopmentalKernel } from '../src/kernel.js';
import { rehearsalActor, rehearsalFixture, runRehearsal } from '../src/rehearsal.js';

function temporary(name) {
  const parent = mkdtempSync(join(tmpdir(), `${name}-`));
  const root = join(parent, 'run');
  return { parent, root };
}

test('one unchanged kernel carries active development across two worlds and separates a sealed control', async t => {
  const { parent, root } = temporary('music-v3-rehearsal');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const report = await runRehearsal(root);
  const active = report.reports.find(value => value.condition === 'active');
  const control = report.reports.find(value => value.condition === 'mechanism-erased');
  assert.equal(active.finalSubject.generation, 4);
  assert.equal(active.finalSubject.memory.rehearsal, 'complete');
  assert.equal(active.finalSubject.mechanisms.allocation, 'constraint-aware');
  assert.equal(active.finalSubject.mechanisms.contactable.op, 'difference');
  assert.equal(active.finalSubject.language['contactable-distinction'].kind, 'set-source');
  assert.deepEqual(active.audit.cycles.map(value => value.classification), ['support', 'underdetermined', 'support', 'support']);
  assert.equal(active.audit.cycles[1].transitionAuthority, 'fresh-assimilation');
  assert.equal(active.audit.cycles.filter(value => value.transitionAuthority === 'bound-predicate').length, 3);
  const directUse = active.audit.cycles.find(value => value.wagerId === 'use-authored-distinction');
  assert.equal(directUse.complete, true);
  const activeKernel = new DevelopmentalKernel(join(root, 'active'));
  const activeState = activeKernel.state();
  const boundDirectUse = activeKernel.store.get(activeState.cycles[3].binding.wager);
  assert.equal(boundDirectUse.contact.binding.subjectPath, '/mechanisms/contactable');
  assert.equal(boundDirectUse.contact.binding.mechanismDigest, digest(activeState.cycles[2].transition ? activeKernel.store.get(activeState.cycles[2].transition.subject).mechanisms.contactable : null));
  assert.deepEqual(boundDirectUse.contact.input.program, activeKernel.store.get(activeState.cycles[2].transition.subject).mechanisms.contactable);
  assert.equal(control.finalSubject.generation, 3);
  assert.equal(control.finalSubject.memory.control_result, 'mechanism authority absent');
  assert.equal(control.finalSubject.language['contactable-distinction'], undefined);
});

test('every completed perspective has a unique fresh context and no hidden continuity', async t => {
  const { parent, root } = temporary('music-v3-contexts');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const report = await runRehearsal(root);
  for (const condition of report.reports) {
    const completed = condition.audit.actorInvocations.filter(value => value.status === 'completed');
    assert.equal(new Set(completed.map(value => value.contextId)).size, completed.length);
    assert.ok(completed.every(value => value.responseChain === null && value.workspaceContinuity === null));
  }
});

test('fresh projections retain only the configured number of completed generations', async t => {
  const { parent, root } = temporary('music-v3-projection-history');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { worlds, spec, plans } = rehearsalFixture();
  spec.limits.projectionHistoryEntries = 2;
  const kernel = new DevelopmentalKernel(root, { worlds, actor: rehearsalActor(plans) });
  kernel.initialize(spec);
  await kernel.run();
  const projections = kernel.state().invocations
    .filter(value => value.status === 'completed')
    .map(value => kernel.store.get(value.projection));
  assert.ok(projections.every(value => value.history.length <= 2));
  assert.deepEqual(projections.find(value => value.role === 'orient' && value.subject.generation === 3).history.map(value => value.generation), [1, 2]);
});

test('projection erasure changes actor-visible state without rewriting the control subject', async t => {
  const { parent, root } = temporary('music-v3-control');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { worlds, spec, plans } = rehearsalFixture();
  const kernel = new DevelopmentalKernel(root, {
    worlds,
    actor: rehearsalActor(plans),
  });
  kernel.initialize(spec, { condition: 'mechanism-erased' });
  await kernel.run();
  const state = kernel.state();
  assert.equal(state.subject.mechanisms.allocation, 'constraint-aware');
  const generationTwoOrientation = state.invocations.find(value => value.role === 'orient' && value.status === 'completed' && kernel.store.get(value.projection).subject.generation === 2);
  const projection = kernel.store.get(generationTwoOrientation.projection);
  assert.equal(projection.subject.mechanisms.allocation, undefined);
  assert.ok(projection.history.every(entry => entry.successor.mechanisms.allocation === undefined));
  assert.equal(JSON.stringify(projection).includes('mechanism-erased'), false);
});

test('ledger tampering is detected before state reconstruction', async t => {
  const { parent, root } = temporary('music-v3-tamper');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { worlds, spec, plans } = rehearsalFixture();
  const kernel = new DevelopmentalKernel(root, { worlds, actor: rehearsalActor(plans) });
  kernel.initialize(spec);
  const ledger = join(root, 'ledger.ndjson');
  const bytes = readFileSync(ledger, 'utf8').replace('"condition":"active"', '"condition":"tampered"');
  writeFileSync(ledger, bytes);
  assert.throws(() => kernel.state(), /invalid event hash/);
});
