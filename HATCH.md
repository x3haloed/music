# Hatch procedure

A hatch is the first complete consequence transition performed by a newly
initialized subject through fresh hosted-model perspectives. Music records
`subject.hatched` only after orientation, challenge admission, election, bound
world contact, independent receipt, deterministic classification, and exact
state transition have all completed. It is an engineering event, not evidence
of open-ended development.

## Before hatch

1. Run `npm run check`, `npm audit --omit=dev`, and `node bin/music-doctor.js`.
2. Keep the run outside the checkout or under ignored `.music/`. Never put API
   keys, bearer tokens, raw private messages, or run stores in Git.
3. Generate a starting envelope with `music template WORLD ACTOR`, then replace
   every placeholder. Freeze the hypothesis, falsifier, worlds, grants,
   conditions, retry budgets, cycle budget, and stopping rule before `init` or
   `hatch`.
4. Prefer `operator-outbox` for the first hatch. It grants only durable messages
   inside the run. Treat `network.fetch` and especially `local.execute` as broad
   authority; do not grant them casually.

## Hatch and residence

```sh
node src/cli.js hatch /absolute/run /absolute/spec.json
```

`hatch` initializes the immutable genesis and holds the resident lease. For a
subject beginning in seclusion, send an observation from another process:

```sh
node src/cli.js observe /absolute/run '{"request":"..."}' operator machine-owner
```

Transient inference or contact failures are retained and retried with the
frozen key/budgets. `SIGINT` and `SIGTERM` release the resident lease without
closing the subject. Restart with `music reside RUN`. Use `music revoke` to
stop an effect before contact and `music grant` to restore an effect already in
the genesis envelope.

## Verify and preserve

```sh
node src/cli.js audit /absolute/run
node src/cli.js snapshot /absolute/run /absolute/snapshot
```

Require a non-null `hatched` record, a promoted generation, distinct context
and provider response IDs, an independently stored contact receipt, a direct or
properly scoped assimilation transition, and a fully verified object graph.
Inspect the outbox or external system itself. A snapshot is a replayable run
root and never overwrites an existing destination.

If an observer limit ends while `subjectDisposition` is `open`, create a new
spec whose `inheritedSubjectId` equals the prior audit subject ID, then run:

```sh
node src/cli.js continue /absolute/new-run /absolute/new-spec.json /absolute/prior-run
```

Preserve both episode snapshots. The successor genesis binds the predecessor
run ID, ledger head, and subject ID; the subject retains its lifetime generation
and content identity.
