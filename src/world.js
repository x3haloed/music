import { digest } from './canonical.js';

const AttestationType = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class WorldRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || typeof adapter.version !== 'string') throw new Error('world adapter needs id and version');
    if (typeof adapter.conform !== 'function' || typeof adapter.conformOutput !== 'function' || typeof adapter.execute !== 'function' || typeof adapter.attest !== 'function') throw new Error(`world adapter ${adapter.id} is incomplete`);
    const normalized = {
      ...adapter,
      effects: [...new Set(adapter.effects ?? [])].sort(),
      attestationTypes: [...new Set(adapter.attestationTypes ?? [])].sort(),
      publicContract: adapter.publicContract ?? {},
    };
    if (normalized.attestationTypes.length === 0 || normalized.attestationTypes.some(value => typeof value !== 'string' || !AttestationType.test(value))) throw new Error(`world adapter ${normalized.id} needs valid attestation types`);
    if (normalized.identityMaterial === undefined) throw new Error(`world adapter ${normalized.id} needs identityMaterial`);
    normalized.identity = digest({
      format: 'music-v4-world-adapter-1',
      id: normalized.id,
      version: normalized.version,
      effects: normalized.effects,
      attestationTypes: normalized.attestationTypes,
      publicContract: normalized.publicContract,
      identityMaterial: normalized.identityMaterial,
      implementation: {
        conform: String(normalized.conform),
        conformOutput: String(normalized.conformOutput),
        attest: String(normalized.attest),
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
      if (JSON.stringify(adapter.attestationTypes) !== JSON.stringify([...world.attestationTypes].sort())) throw new Error(`world adapter attestation types changed: ${world.adapter}`);
    }
  }
}

export function defineWorld({ id, version, description, effects = [], attestationTypes, publicContract = {}, identityMaterial, conform, conformOutput, attest, execute }) {
  return { id, version, description, effects, attestationTypes, publicContract, identityMaterial, conform, conformOutput, attest, execute };
}

export function deriveAttestations(adapter, input, output, envelope) {
  const declared = new Set(adapter.attestationTypes);
  const values = adapter.attest(input, output);
  if (!Array.isArray(values) || values.length === 0) throw new Error(`world adapter ${adapter.id} emitted no attestations`);
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !declared.has(value.type) || !Object.hasOwn(value, 'value')) throw new Error(`world adapter ${adapter.id} emitted invalid attestation ${index + 1}`);
    const body = {
      format: 'music-v4-world-attestation-1',
      type: value.type,
      world: envelope.world,
      adapter: adapter.id,
      adapterIdentity: adapter.identity,
      input: envelope.input,
      receipt: envelope.receipt,
      value: value.value,
    };
    return { ...body, id: digest(body) };
  });
}

export function verifyAttestation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 'music-v4-world-attestation-1' || typeof value.id !== 'string' || !AttestationType.test(value.type)) throw new Error('invalid world attestation');
  if (typeof value.world !== 'string' || typeof value.adapter !== 'string' || !/^[a-f0-9]{64}$/.test(value.adapterIdentity)) throw new Error('invalid world attestation identity');
  if (value.input?.format !== 'music-v4-object-1' || value.receipt?.format !== 'music-v4-object-1') throw new Error('invalid world attestation evidence reference');
  const { id, ...body } = value;
  if (digest(body) !== id) throw new Error('world attestation identity mismatch');
  return value;
}
