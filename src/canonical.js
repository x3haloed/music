import { createHash } from 'node:crypto';

export function canonical(value) {
  return JSON.stringify(normalize(value));
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalize(value, path = '$') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalize(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== undefined) {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`${path}.${key} is undefined`);
      normalized[key] = normalize(value[key], `${path}.${key}`);
    }
    return normalized;
  }
  throw new TypeError(`${path} is not JSON data`);
}
