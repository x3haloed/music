import { clone, digest } from './canonical.js';
import { z } from 'zod';

export const DEFAULT_ATTENTION_POLICY = Object.freeze({
  format: 'music-v4-attention-policy-1',
  targetInputTokens: 180_000,
  maximumInputTokens: 200_000,
  maximumInputCharacters: 900_000,
  recentCompleteConsequences: 2,
  maximumCausalCards: 64,
});

export const AttentionPolicySchema = z.object({
  format: z.literal('music-v4-attention-policy-1'),
  targetInputTokens: z.number().int().min(16_384).max(200_000),
  maximumInputTokens: z.number().int().min(16_384).max(200_000),
  maximumInputCharacters: z.number().int().min(65_536).max(900_000),
  recentCompleteConsequences: z.number().int().min(0).max(64),
  maximumCausalCards: z.number().int().min(1).max(256),
}).strict();

export const ATTENTION_INTERFACE = Object.freeze({
  subjectPath: '/organs/attentionPolicy',
  format: 'music-v4-attention-policy-1',
  purpose: 'Allocate bounded immediate attention without destroying retained evidence.',
  writable: true,
  authority: { fact: false, outcome: false, operation: false, admission: false },
  hardRuntimeCeiling: 'The runtime may enforce a stricter provider-safe ceiling than the subject requests.',
  evidenceRetrieval: 'Use evidence-read with an exact object reference to bring omitted evidence back into immediate attention.',
});

export function attentionPolicy(subject, limits = {}) {
  const parsed = AttentionPolicySchema.safeParse(subject?.organs?.attentionPolicy);
  const policy = parsed.success ? parsed.data : DEFAULT_ATTENTION_POLICY;
  const hardTokens = Math.min(limits.maximumInputTokens ?? 200_000, 200_000);
  const hardCharacters = Math.min(limits.maximumInputCharacters ?? 900_000, 900_000);
  return {
    ...clone(policy),
    targetInputTokens: Math.min(policy.targetInputTokens, hardTokens),
    maximumInputTokens: hardTokens,
    maximumInputCharacters: hardCharacters,
  };
}

export function compactCausalTrail(entries, policy) {
  const selected = entries.slice(-Math.min(policy.maximumCausalCards, entries.length));
  const completeFrom = Math.max(0, selected.length - policy.recentCompleteConsequences);
  return selected.map((entry, index) => index >= completeFrom ? clone(entry) : causalCard(entry));
}

export function attachAttentionManifest(projection, policy) {
  const value = clone(projection);
  const targetCharacters = Math.min(policy.maximumInputCharacters, policy.targetInputTokens * 2);
  const indexed = [];
  value.causalTrail ??= [];
  while (JSON.stringify(value).length > targetCharacters && value.causalTrail.length > 2) {
    const removed = value.causalTrail.shift();
    indexed.push({ succession: removed.succession, subjectId: removed.subjectId, evidence: removed.evidence ?? null });
  }
  if (indexed.length > 0) value.causalTrailIndex = indexed;
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
  const rendered = JSON.stringify(value);
  value.attentionManifest = {
    format: 'music-v4-attention-manifest-1',
    policyId: digest(policy),
    policy,
    estimatedInputTokens: estimateTokens(rendered),
    projectionCharacters: rendered.length,
    retainedCausalCards: value.causalTrail.length,
    indexedCausalCards: indexed.length,
    exactSubjectReference: value.subjectEvidence,
    trimming: ['older causal cards become exact indexes', 'old facts and memory become exact indexes only when required'],
  };
  return value;
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 2);
}

function causalCard(entry) {
  return {
    succession: entry.succession,
    revision: entry.revision,
    operation: entry.operation,
    classification: entry.classification ?? null,
    disposition: entry.disposition ?? null,
    subjectId: entry.subjectId,
    evidence: entry.evidence ?? null,
    detail: 'structural-card',
  };
}
