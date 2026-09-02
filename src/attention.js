import { clone, digest } from './canonical.js';
import { z } from 'zod';

export const ATTENTION_POLICY_KEY = 'attentionPolicy';
export const DEFAULT_ATTENTION_POLICY = Object.freeze({
  format: 'music-v3-attention-policy-1',
  targetInputTokens: 180_000,
  maximumInputTokens: 200_000,
  maximumInputCharacters: 900_000,
  recentCompleteConsequences: 2,
  maximumHistoryCards: 64,
});

export const AttentionPolicySchema = z.object({
  format: z.literal('music-v3-attention-policy-1'),
  targetInputTokens: z.number().int().min(16_384).max(200_000),
  maximumInputTokens: z.number().int().min(16_384).max(200_000),
  maximumInputCharacters: z.number().int().min(65_536).max(900_000),
  recentCompleteConsequences: z.number().int().min(0).max(64),
  maximumHistoryCards: z.number().int().min(1).max(256),
}).strict();

export const ATTENTION_INTERFACE = Object.freeze({
  subjectPath: '/mechanisms/attentionPolicy',
  format: 'music-v3-attention-policy-1',
  purpose: 'Deterministically allocate bounded immediate attention without destroying retained evidence.',
  writable: true,
  hardRuntimeCeiling: 'The runtime may enforce a stricter provider-safe ceiling than the subject requests.',
  evidenceRetrieval: 'Use the evidence-read world with an exact object reference to elect omitted evidence back into attention.',
});

export function attentionPolicy(subject, limits = {}) {
  const candidate = subject?.mechanisms?.[ATTENTION_POLICY_KEY];
  const parsed = AttentionPolicySchema.safeParse(candidate);
  const policy = parsed.success ? parsed.data : DEFAULT_ATTENTION_POLICY;
  const hardTokens = Math.min(limits.maximumInputTokens ?? 200_000, 200_000);
  const hardCharacters = Math.min(limits.maximumInputCharacters ?? 900_000, 900_000);
  return {
    ...clone(DEFAULT_ATTENTION_POLICY),
    ...clone(policy),
    targetInputTokens: Math.min(policy.targetInputTokens ?? 180_000, hardTokens),
    maximumInputTokens: hardTokens,
    maximumInputCharacters: hardCharacters,
  };
}

export function compactHistory(entries, policy) {
  const recent = Math.max(0, Math.min(policy.recentCompleteConsequences ?? 2, entries.length));
  return entries.slice(-Math.min(policy.maximumHistoryCards ?? 64, entries.length)).map((entry, index, selected) => {
    const receiptReference = entry.receiptReference;
    const complete = index >= selected.length - recent;
    return {
      generation: entry.generation,
      wager: complete ? entry.wager : wagerCard(entry.wager),
      world: entry.world,
      receipt: {
        reference: receiptReference,
        sha256: receiptReference.sha256,
        bytes: receiptReference.bytes,
        rawIncluded: false,
        retrieval: { world: 'evidence-read', input: { reference: receiptReference, offset: 0, maxCharacters: 65_536 } },
      },
      attestations: entry.attestations,
      evaluation: entry.evaluation,
      transition: entry.transition,
      transitionAuthority: entry.transitionAuthority,
      successor: entry.successor,
      selection: complete ? entry.selection : selectionCard(entry.selection),
      detail: complete ? 'causally-complete-except-raw-receipt' : 'structural-card',
    };
  });
}

export function attachAttentionManifest(projection, policy) {
  const value = clone(projection);
  const targetCharacters = Math.min(policy.maximumInputCharacters, policy.targetInputTokens * 2);
  const indexedHistory = [];
  while (JSON.stringify(value).length > targetCharacters && value.history.length > 2) {
    const removed = value.history.shift();
    indexedHistory.push({ generation: removed.generation, successorId: removed.successor.id, receipt: removed.receipt.reference, detail: 'index-only' });
  }
  if (indexedHistory.length > 0) value.historyIndex = indexedHistory;
  if (JSON.stringify(value).length > targetCharacters && value.subject?.facts) {
    const facts = Object.entries(value.subject.facts);
    const retained = facts.slice(-32);
    value.subject.facts = Object.fromEntries(retained);
    value.subjectFactsIndex = {
      total: facts.length,
      retainedIds: retained.map(([id]) => id),
      omittedCount: Math.max(0, facts.length - retained.length),
      exactSubject: value.subjectEvidence,
    };
  }
  if (JSON.stringify(value).length > targetCharacters && value.subject?.memory) {
    const entries = Object.entries(value.subject.memory).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, memory] of entries) {
      if (JSON.stringify(value).length <= targetCharacters) break;
      value.subject.memory[key] = { attention: 'indexed', sha256: digest(memory), exactSubject: value.subjectEvidence };
    }
  }
  value.attentionManifest = {
    format: 'music-v3-attention-manifest-1',
    policyId: digest(policy),
    policy,
    estimatedInputTokens: estimateTokens(JSON.stringify(value)),
    projectionCharacters: JSON.stringify(value).length,
    completeHistoryEntries: value.history.filter(item => item.detail?.startsWith('causally-complete')).length,
    structuralHistoryEntries: value.history.filter(item => item.detail === 'structural-card').length,
    indexedHistoryEntries: indexedHistory.length,
    omittedRawReceipts: value.history.length,
    retrievableReferences: value.history.map(item => item.receipt.reference),
    trimming: ['raw historical receipts replaced by exact references', 'older wagers and selection records reduced to structural cards', 'oldest cards, facts, and memory become exact indexes only when required by the target'],
  };
  return value;
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 2);
}

function wagerCard(wager) {
  return {
    id: wager.id,
    stake: wager.stake,
    contact: { world: wager.contact.world },
    bearing: wager.bearing,
    revisionScope: wager.revisionScope,
    effectRequirements: wager.effectRequirements,
  };
}

function selectionCard(selection) {
  if (!selection) return null;
  const card = { policyId: selection.policyId ?? null };
  if (selection.selectedIds !== undefined) card.selectedIds = selection.selectedIds;
  if (selection.rejectedIds !== undefined) card.rejectedIds = selection.rejectedIds;
  if (selection.dominatedIds !== undefined) card.dominatedIds = selection.dominatedIds;
  return card;
}
