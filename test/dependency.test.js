import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { MusicKernel } from '../src/kernel.js';
import { MusicMind } from '../src/mind.js';
import { toolModuleDigest } from '../src/tool-module.js';
import { initialTools } from '../src/seeds.js';

test('the ordinary dependency tool installs a real package used by a later invented tool', async () => {
  const { root, kernel } = harness();
  const fixture = join(root, 'fixture-package');
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({
    name: 'music-fixture-dependency', version: '1.0.0', type: 'module', main: './index.js',
  })}\n`);
  writeFileSync(join(fixture, 'index.js'), `export default 'dependency-ok';\n`);

  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const installed = await kernel.invokeTool(inferenceId, sounding.id, 'manage_dependency', {
    action: 'install', name: 'music-fixture-dependency', spec: fixture,
  });
  assert.equal(installed.action, 'install');
  assert.match(installed.retainedSpec, /^file:/);
  kernel.stageToolRevision(inferenceId, sounding.id, {
    interpretation: 'Use the newly installed resident dependency in a later executable affordance.',
    tool: {
      id: 'dependency_probe',
      description: 'Load the installed fixture package from the resident dependency habitat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      source: `
const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
const require = createRequire(join(context.environment.dependencyRoot, 'package.json'));
const entry = require.resolve('music-fixture-dependency');
const loaded = await import(pathToFileURL(entry).href);
return { value: loaded.default };`,
    },
  });
  complete(kernel, inferenceId);

  const later = kernel.openSounding();
  const laterInference = begin(kernel, later.id);
  assert.deepEqual(await kernel.invokeTool(laterInference, later.id, 'dependency_probe', {}), { value: 'dependency-ok' });
});

test('a broken learned dependency surfaces its exact failure and the same mind can roll it back', async () => {
  const { kernel } = harness();
  const first = kernel.openSounding();
  const firstInference = begin(kernel, first.id);
  const working = kernel.stageToolRevision(firstInference, first.id, {
    interpretation: 'Create a working dependency-backed affordance before exercising correction.',
    tool: {
      id: 'fragile_dependency', description: 'Exercise a learned dependency.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      source: `return { value: 'working' };`,
    },
  });
  complete(kernel, firstInference);
  const workingDigest = toolModuleDigest(working);

  const revision = kernel.openSounding();
  const revisionInference = begin(kernel, revision.id);
  kernel.stageToolRevision(revisionInference, revision.id, {
    interpretation: 'Fixture a successor whose declared runtime dependency is absent.',
    tool: {
      id: 'fragile_dependency', description: 'Exercise a learned dependency.',
      inputSchema: working.inputSchema,
      source: `await import('music-package-that-does-not-exist'); return { unreachable: true };`,
    },
  });
  complete(kernel, revisionInference);

  const failed = kernel.openSounding();
  const failedInference = begin(kernel, failed.id);
  let dependencyError;
  try {
    await kernel.invokeTool(failedInference, failed.id, 'fragile_dependency', {});
  } catch (error) {
    dependencyError = error;
  }
  assert.match(dependencyError.message, /music-package-that-does-not-exist/);
  kernel.failInference(failedInference, dependencyError);

  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) return toolCallResult('rollback_tool', {
        toolId: 'fragile_dependency', targetDigest: workingDigest,
        interpretation: 'The kernel runtime diagnostic identifies my missing dependency; restore the retained working executable body.',
      });
      return textResult('I restored the working dependency affordance.');
    },
  });
  const recovery = kernel.openSounding();
  await new MusicMind(kernel, {
    model,
    identity: { provider: model.provider, model: model.modelId },
  }).receive(recovery.id);

  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.match(prompt, /music_runtime_failure/);
  assert.match(prompt, /music-package-that-does-not-exist/);
  assert.equal(kernel.state().tools.get('fragile_dependency').version, 2);
  const rollback = [...kernel.state().developmentalProposals.values()]
    .find(proposal => proposal.revision?.rollbackOf === workingDigest);
  const trial = kernel.openSounding();
  const trialInference = begin(kernel, trial.id);
  assert.deepEqual(
    (await kernel.trialDevelopmentalProposal(trialInference, trial.id, rollback.proposalId, {})).output,
    { value: 'working' },
  );
  complete(kernel, trialInference);
  const admission = kernel.openSounding();
  const admissionInference = begin(kernel, admission.id);
  kernel.stageDevelopmentalTransaction(admissionInference, admission.id, {
    interpretation: 'The retained working ancestor executed successfully.',
    decisions: [{
      proposalId: rollback.proposalId, disposition: 'rollback',
      interpretation: 'Admit the exercised recovery successor.',
    }],
  });
  complete(kernel, admissionInference);
  assert.equal(kernel.state().tools.get('fragile_dependency').version, 3);
  assert.equal(kernel.state().tools.get('fragile_dependency').source, working.source);
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'music-dependency-test-'));
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), {
    id: () => `dependency-id-${++identity}`,
    toolEnvironment: { dependencyRoot: join(root, 'dependencies') },
  });
  kernel.initialize('Test Subject', initialTools());
  return { root, kernel };
}

function begin(kernel, soundingId) {
  return kernel.beginInference(soundingId, { provider: 'fixture', model: 'fixture' }, { role: 'user', content: 'Fixture.' });
}

function complete(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
    text: 'Done.', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}

function toolCallResult(toolName, input) {
  return {
    content: [{ type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: usage(), warnings: [],
  };
}

function textResult(text) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(), warnings: [],
  };
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}
