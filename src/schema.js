import { z } from 'zod';

export const JsonValueSchema = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

export const IsoDateSchema = z.string().refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, 'must be an ISO-8601 timestamp');

export const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
