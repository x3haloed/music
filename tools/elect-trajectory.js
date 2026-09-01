import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialTrajectoryElectionTool() {
  return validateToolModule({
    id: 'elect_trajectory',
    version: 1,
    parent: null,
    description: 'Judge one exact frozen developmental review and set the resident\'s active trajectory envelope. Supply one assessment for every review candidate. This selector alone may create or replace the trajectory; it does not execute the selected contact. After it returns, Music delivers the retained trajectory as authoritative context and restores the full action surface.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: { type: 'string', minLength: 1, maxLength: 128 },
        assessments: {
          type: 'array', minItems: 2, maxItems: 16,
          items: {
            type: 'object',
            properties: {
              candidateId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              worldValid: { type: 'boolean' },
              reversible: { type: 'boolean' },
              heldRepeat: { type: 'boolean' },
              completedFloors: {
                type: 'array', maxItems: 16,
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['world-delta', 'tool-invocation', 'trajectory-election', 'developmental-proposal', 'active-tool'] },
                    id: { type: 'string', minLength: 1, maxLength: 128 },
                    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  },
                  required: ['kind', 'id'], additionalProperties: false,
                },
              },
              predictedExpansion: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 },
              actionableRegret: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 },
              basis: { type: 'string', minLength: 1, maxLength: 2_048 },
            },
            required: ['candidateId', 'worldValid', 'reversible', 'heldRepeat', 'completedFloors', 'predictedExpansion', 'actionableRegret', 'basis'],
            additionalProperties: false,
          },
        },
        trajectory: {
          type: 'object',
          properties: {
            objective: { type: 'string', minLength: 1, maxLength: 2_048 },
            direction: { type: 'string', minLength: 1, maxLength: 2_048 },
            horizon: { type: 'string', enum: ['immediate', 'near', 'open-ended'] },
            successSignals: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 512 } },
            reconsiderWhen: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 512 } },
          },
          required: ['objective', 'direction', 'horizon', 'successSignals', 'reconsiderWhen'], additionalProperties: false,
        },
      },
      required: ['reviewId', 'assessments', 'trajectory'], additionalProperties: false,
    },
    source: sourceBody(electTrajectory),
  });
}

async function electTrajectory(input, context) {
  // Event-12 ledgers may retain the first selector body. Keeping its execution
  // path here makes provisional trials and historical fixtures reconstructable;
  // new recurrence admission still requires a frozen review-bound election.
  if (Array.isArray(input.candidates)) {
    const candidates = input.candidates;
    const eligible = candidates.filter(candidate => candidate.geometry.worldValid && !candidate.geometry.heldRepeat);
    if (eligible.length === 0) throw new Error('trajectory frontier has no world-valid, non-repeated candidate');
    eligible.sort((left, right) => {
      const leftComposition = left.geometry.completedFloors.length >= 2 ? 1 : 0;
      const rightComposition = right.geometry.completedFloors.length >= 2 ? 1 : 0;
      return rightComposition - leftComposition
        || right.geometry.predictedExpansion - left.geometry.predictedExpansion
        || right.geometry.actionableRegret - left.geometry.actionableRegret
        || Number(right.geometry.reversible) - Number(left.geometry.reversible)
        || right.id.localeCompare(left.id);
    });
    return context.executeTrajectoryElection({ candidates, selectedCandidateId: eligible[0].id });
  }
  const ids = new Set();
  const assessments = input.assessments.map(assessment => {
    if (ids.has(assessment.candidateId)) throw new Error(`trajectory assessment repeats candidate: ${assessment.candidateId}`);
    ids.add(assessment.candidateId);
    const floors = assessment.completedFloors;
    if (new Set(floors.map(floor => `${floor.kind}:${floor.id}`)).size !== floors.length) {
      throw new Error(`trajectory candidate ${assessment.candidateId} repeats a completed floor`);
    }
    return assessment;
  });
  const eligible = assessments.filter(assessment => assessment.worldValid && !assessment.heldRepeat);
  if (eligible.length === 0) throw new Error('trajectory frontier has no world-valid, non-repeated candidate');
  eligible.sort((left, right) => {
    const leftComposition = left.completedFloors.length >= 2 ? 1 : 0;
    const rightComposition = right.completedFloors.length >= 2 ? 1 : 0;
    return rightComposition - leftComposition
      || right.predictedExpansion - left.predictedExpansion
      || right.actionableRegret - left.actionableRegret
      || Number(right.reversible) - Number(left.reversible)
      || right.candidateId.localeCompare(left.candidateId);
  });
  return context.recordTrajectoryElection({
    reviewId: input.reviewId,
    assessments,
    selectedCandidateId: eligible[0].candidateId,
    trajectory: input.trajectory,
  });
}
