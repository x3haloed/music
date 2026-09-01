import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { canonical } from './canonical.js';
import { IdentifierSchema, IsoDateSchema } from './schema.js';

const GrantSchema = z.object({
  capability: IdentifierSchema,
  active: z.boolean(),
  grantedBy: z.string().min(1).max(256),
  changedAt: IsoDateSchema,
});

export class Governance {
  constructor(path, { clock = () => new Date() } = {}) {
    this.path = path;
    this.clock = clock;
  }

  read() {
    if (!existsSync(this.path)) return [];
    return z.array(GrantSchema).parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  set(capability, active, grantedBy) {
    IdentifierSchema.parse(capability);
    if (typeof grantedBy !== 'string' || grantedBy.trim() === '') throw new Error('grantedBy is required');
    const grants = this.read().filter(grant => grant.capability !== capability);
    grants.push({ capability, active, grantedBy: grantedBy.trim(), changedAt: this.clock().toISOString() });
    grants.sort((a, b) => a.capability.localeCompare(b.capability));
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${canonical(grants)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    return grants;
  }
}
