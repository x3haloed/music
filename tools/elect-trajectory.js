import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialTrajectoryElectionTool() {
  return validateToolModule({
    id: 'elect_trajectory',
    version: 1,
    parent: null,
    description: 'Run the resident\'s current general trajectory-election geometry over a complete actor-authored frontier containing at least one executable alternative. The ordinary module computes the winner and directly asks Music to execute that exact selected action before returning; quiet executes nothing. When the elected tool has its own selection geometry, include one trajectory candidate for every required tool action; Music derives and binds the nested selection from this same frontier. Completed floors are exact retained references whose existence and current status Music verifies without interpreting them.',
    inputSchema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array', minItems: 2, maxItems: 16,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              description: { type: 'string', minLength: 1, maxLength: 2_048 },
              action: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['tool', 'quiet'] },
                  tool: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
                  input: { type: 'object', additionalProperties: true },
                  selectionReceipt: { type: 'string', minLength: 1, maxLength: 128 },
                  observation: { type: 'string', minLength: 1, maxLength: 2_048 },
                },
                required: ['kind'], additionalProperties: false,
              },
              geometry: {
                type: 'object',
                properties: {
                  worldValid: { type: 'boolean' },
                  reversible: { type: 'boolean' },
                  heldRepeat: { type: 'boolean' },
                  completedFloors: {
                    type: 'array', maxItems: 16,
                    items: {
                      type: 'object',
                      properties: {
                        kind: {
                          type: 'string',
                          enum: [
                            'world-delta', 'tool-invocation', 'trajectory-election',
                            'developmental-proposal', 'active-tool',
                          ],
                        },
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
                required: [
                  'worldValid', 'reversible', 'heldRepeat', 'completedFloors',
                  'predictedExpansion', 'actionableRegret', 'basis',
                ],
                additionalProperties: false,
              },
            },
            required: ['id', 'description', 'action', 'geometry'], additionalProperties: false,
          },
        },
      },
      required: ['candidates'], additionalProperties: false,
    },
    source: sourceBody(electTrajectory),
  });
}

async function electTrajectory(input, context) {
  const ids = new Set();
  const candidates = input.candidates.map(candidate => {
    if (ids.has(candidate.id)) throw new Error(`trajectory frontier repeats candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    const floors = candidate.geometry.completedFloors;
    if (new Set(floors.map(floor => `${floor.kind}:${floor.id}`)).size !== floors.length) {
      throw new Error(`trajectory candidate ${candidate.id} repeats a completed floor`);
    }
    if (candidate.action.kind === 'tool') {
      if (!candidate.action.tool || !candidate.action.input) {
        throw new Error(`trajectory candidate ${candidate.id} needs a concrete tool and input`);
      }
      if (candidate.action.tool === context.tool.id) {
        throw new Error('a trajectory election cannot recursively select itself');
      }
    } else if (candidate.action.tool !== undefined || candidate.action.input !== undefined
      || candidate.action.selectionReceipt !== undefined) {
      throw new Error(`quiet trajectory candidate ${candidate.id} cannot carry a tool action`);
    }
    return candidate;
  });
  const eligible = candidates.filter(candidate => candidate.geometry.worldValid
    && !candidate.geometry.heldRepeat);
  if (!candidates.some(candidate => candidate.action.kind === 'tool')) {
    throw new Error('trajectory frontier needs at least one executable alternative');
  }
  if (eligible.length === 0) {
    throw new Error('trajectory frontier has no world-valid, non-repeated candidate');
  }
  eligible.sort((left, right) => {
    const leftComposition = left.geometry.completedFloors.length >= 2 ? 1 : 0;
    const rightComposition = right.geometry.completedFloors.length >= 2 ? 1 : 0;
    return rightComposition - leftComposition
      || right.geometry.predictedExpansion - left.geometry.predictedExpansion
      || right.geometry.actionableRegret - left.geometry.actionableRegret
      || Number(right.geometry.reversible) - Number(left.geometry.reversible)
      || right.id.localeCompare(left.id);
  });
  return context.executeTrajectoryElection({
    candidates,
    selectedCandidateId: eligible[0].id,
  });
}
