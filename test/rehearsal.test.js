import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runRehearsal } from '../src/rehearsal.js';

test('V4 rehearsal closes selection, correction, organ reuse, saturation, expansion, and waiting', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v4-rehearsal-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const report = await runRehearsal(join(parent, 'run'));
  assert.equal(report.passed, true);
  assert.equal(report.subject.revision, 4);
  assert.equal(report.subject.succession, 19);
  assert.equal(report.anchors.revisedOrganChangedLaterOpportunityOrder, true);
  assert.equal(report.anchors.saturationCausedExpansion, true);
  assert.equal(report.anchors.emptyExpansionCausedBoundedWait, true);
  assert.equal(report.uniqueFreshContexts, report.completedPerspectives);
});
