import { classify } from './predicate.js';
import { resolvePointer } from './predicate.js';
import { clone, digest } from './canonical.js';
import { affectedPaths, pathsOverlap, TransitionSchema } from './subject.js';
import { WagerSchema } from './protocol.js';

export function admitWager(value, { subject, spec, worlds, grants = spec.grants }) {
  const wager = WagerSchema.parse(value);
  const reasons = [];
  let boundWager = wager;
  if (wager.contact.mechanism) {
    const { found, value: mechanism } = resolvePointer(subject, wager.contact.mechanism.subjectPath);
    if (!found) reasons.push(`bound mechanism is absent: ${wager.contact.mechanism.subjectPath}`);
    else if (wager.contact.input === null || typeof wager.contact.input !== 'object' || Array.isArray(wager.contact.input)) reasons.push('mechanism binding requires an object contact input');
    else if (Object.hasOwn(wager.contact.input, wager.contact.mechanism.inputKey)) reasons.push(`mechanism input key must be absent before binding: ${wager.contact.mechanism.inputKey}`);
    else {
      const input = clone(wager.contact.input);
      input[wager.contact.mechanism.inputKey] = clone(mechanism);
      boundWager = {
        ...wager,
        contact: {
          ...wager.contact,
          input,
          binding: {
            subjectId: subject.id,
            subjectPath: wager.contact.mechanism.subjectPath,
            inputKey: wager.contact.mechanism.inputKey,
            mechanismDigest: digest(mechanism),
          },
        },
      };
    }
  }
  const declaredWorld = spec.worlds.find(world => world.id === wager.contact.world);
  const adapter = declaredWorld ? worlds.get(declaredWorld.adapter) : null;
  if (!declaredWorld) reasons.push(`world is outside the sealed envelope: ${wager.contact.world}`);
  if (declaredWorld && !adapter) reasons.push(`world adapter is unavailable: ${declaredWorld.adapter}`);
  if (adapter) {
    const published = new Set(adapter.attestationTypes);
    for (const type of boundWager.bearing.attestationTypes) if (!published.has(type)) reasons.push(`wager bearing ${type} is not attested by world ${declaredWorld.id}`);
    for (const reason of adapter.conform(boundWager.contact.input)) reasons.push(`contact: ${reason}`);
    for (const [kind, witness] of Object.entries(wager.witnesses)) {
      for (const reason of adapter.conformOutput(witness.output)) reasons.push(`${kind} witness: ${reason}`);
    }
    const required = [...adapter.effects].sort();
    const declared = [...new Set(wager.effectRequirements)].sort();
    if (JSON.stringify(required) !== JSON.stringify(declared)) {
      reasons.push(`effect requirements must equal adapter effects: ${required.join(', ')}`);
    }
  }
  const activeGrants = new Set(grants);
  for (const effect of wager.effectRequirements) if (!activeGrants.has(effect)) reasons.push(`missing grant: ${effect}`);

  const support = classify(wager.witnesses.support, wager.predicates);
  const contradiction = classify(wager.witnesses.contradiction, wager.predicates);
  if (support.kind !== 'support') reasons.push('support witness does not uniquely reach support');
  if (contradiction.kind !== 'contradiction') reasons.push('contradiction witness does not uniquely reach contradiction');

  const transitions = Object.values(wager.continuations).filter(Boolean).map(value => TransitionSchema.parse(value));
  const changed = transitions.flatMap(affectedPaths);
  for (const path of changed) {
    if (!wager.revisionScope.some(scope => pathsOverlap(scope, path))) reasons.push(`transition path is outside revision scope: ${path}`);
  }
  const derivedFloors = subject.floors
    .filter(floor => wager.revisionScope.some(scope => pathsOverlap(floor.scope, scope)))
    .map(floor => floor.id)
    .sort();
  const declaredFloors = [...new Set(wager.retainedFloorIds)].sort();
  if (JSON.stringify(derivedFloors) !== JSON.stringify(declaredFloors)) {
    reasons.push(`retained floors must equal derived floors: ${derivedFloors.join(', ')}`);
  }
  return { admissible: reasons.length === 0, reasons, derivedFloors, wager: boundWager };
}

export function validateAssimilation(transition, wager, subject) {
  const parsed = TransitionSchema.parse(transition);
  const changed = affectedPaths(parsed);
  for (const path of changed) {
    if (!wager.revisionScope.some(scope => pathsOverlap(scope, path))) {
      throw new Error(`assimilation path is outside bound revision scope: ${path}`);
    }
  }
  const derivedFloors = subject.floors
    .filter(floor => changed.some(path => pathsOverlap(floor.scope, path)))
    .map(floor => floor.id)
    .sort();
  if (JSON.stringify(derivedFloors) !== JSON.stringify([...wager.retainedFloorIds].sort())) {
    throw new Error('assimilation changes a different retained-floor surface than the bound wager');
  }
  return parsed;
}
