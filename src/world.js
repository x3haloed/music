import { digest } from './canonical.js';

export class WorldRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || typeof adapter.version !== 'string') throw new Error('world adapter needs id and version');
    if (typeof adapter.conform !== 'function' || typeof adapter.conformOutput !== 'function' || typeof adapter.execute !== 'function') throw new Error(`world adapter ${adapter.id} is incomplete`);
    const normalized = {
      ...adapter,
      effects: [...new Set(adapter.effects ?? [])].sort(),
      publicContract: adapter.publicContract ?? {},
    };
    if (normalized.identityMaterial === undefined) throw new Error(`world adapter ${normalized.id} needs identityMaterial`);
    normalized.identity = digest({
      format: 'music-v3-world-adapter-1',
      id: normalized.id,
      version: normalized.version,
      effects: normalized.effects,
      publicContract: normalized.publicContract,
      identityMaterial: normalized.identityMaterial,
      implementation: {
        conform: String(normalized.conform),
        conformOutput: String(normalized.conformOutput),
        execute: String(normalized.execute),
      },
    });
    if (this.adapters.has(normalized.id)) throw new Error(`duplicate world adapter: ${normalized.id}`);
    this.adapters.set(normalized.id, normalized);
    return normalized;
  }

  get(id) { return this.adapters.get(id) ?? null; }

  verifySpec(spec) {
    for (const world of spec.worlds) {
      const adapter = this.get(world.adapter);
      if (!adapter) throw new Error(`missing world adapter: ${world.adapter}`);
      if (adapter.identity !== world.adapterIdentity) throw new Error(`world adapter identity changed: ${world.adapter}`);
    }
  }
}

export function defineWorld({ id, version, description, effects = [], publicContract = {}, identityMaterial, conform, conformOutput, execute }) {
  return { id, version, description, effects, publicContract, identityMaterial, conform, conformOutput, execute };
}
