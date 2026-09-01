import { join } from 'node:path';
import { DevelopmentalKernel } from './kernel.js';

export async function runExperiment(root, spec, { actorFactory, worlds, conditions = spec.conditions.map(value => value.id), kernelOptions = {} }) {
  const reports = [];
  for (const condition of conditions) {
    const actor = actorFactory();
    const kernel = new DevelopmentalKernel(join(root, condition), { actor, worlds, ...kernelOptions });
    kernel.initialize(spec, { condition });
    const state = await kernel.run();
    reports.push({ condition, audit: kernel.audit(), finalSubject: state.subject });
  }
  return {
    format: 'music-v3-experiment-report-1',
    specId: spec.id,
    reports,
  };
}
