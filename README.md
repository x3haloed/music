# Music v2

Music is a plastic agent harness for one continuing subject. Its probabilistic
perspectives orient, construct challenges, elect contact, and assimilate only
genuinely unsettled consequences. Its small deterministic runtime binds the
election, performs the exact selected tool call, retains the world receipt,
evaluates prospectively bound predicates, and applies a uniquely determined
transition without another model vote.

The founding causal design is frozen in [DESIGN.md](./DESIGN.md). This branch is
a clean implementation of that design, not a compatibility continuation of
Music v1.

## Current causal path

```text
exact position
  → fresh orientation
  → fresh challenge frontier
  → deterministic wager compilation and constitutional admission
  → fresh election over the frozen frontier
  → exact tool realization
  → retained world receipt
  → deterministic predicate classification
    ├─ unique support/contradiction → exact bound successor
    └─ underdetermined → fresh assimilation
                         → provisional position or tool development
                         → deterministic trial
                         → fresh disposition
                         → successor
```

Every position is content-addressed and names its parent. Events form a durable,
fsynced hash-chain ledger. Projections and perspective outputs are immutable
artifacts. A restart resumes a bound wager, retained receipt, unresolved
consequence, proposed development, or completed trial at the first unfinished
phase; it does not repeat an already retained external effect.

Tool development is real rather than descriptive. A subject-authored tool
contains executable JavaScript plus input/output contracts and declared effect
requirements. Its exact artifact is run against bound probes under current
external grants before a separate disposition may place it in active
mechanisms. Generic memory development cannot bypass that trial to install a
tool.

Human messages enter only as quoted `message.received` observations with sender,
recipient, channel, content, and capture provenance. They are not converted into
instructions, goals, permissions, or effect grants. Machine-owner grants are a
separate out-of-band governance operation.

## Requirements

- Node.js 22 or newer
- an OpenRouter API key
- the model `z-ai/glm-5.3-flash`

This release deliberately rejects every other model identifier. That is a
deployment safety boundary, not a claim that the subject's inference policy
should remain permanently immutable.

## Install and initialize a habitat

Keep the checkout and the resident habitat separate. The checkout is replaceable
software; the habitat is the subject's own lineage.

Install only a clean commit that has already been pushed. This makes the
resident's executable release exact and independently replaceable:

```sh
npm ci
node bin/music-install-release.js /absolute/path/to/music-installations
MUSIC_RELEASE=/absolute/path/to/music-installations/current
MUSIC_HABITAT=/absolute/path/to/music-habitat
node "$MUSIC_RELEASE/bin/music-habitat.js" create "$MUSIC_HABITAT"
node "$MUSIC_RELEASE/bin/music-habitat.js" init "$MUSIC_HABITAT"
```

The designation is generic by default. `--designation` is optional.

Store the key outside both the repository and habitat. The CLI accepts either
`OPENROUTER_API_KEY` or a raw key file passed with `--key-file`.

```sh
chmod 600 /absolute/path/to/openrouter.key
```

Grant only the physical effects the machine owner intends to make available:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" local.read --by "machine owner"
node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" local.write --by "machine owner"
node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" local.execute --by "machine owner"
node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" network.fetch --by "machine owner"
node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" message.send --by "machine owner"
node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" dependency.manage --by "machine owner"
```

Grants are independently revocable with `music revoke CAPABILITY`. Granting a
capability does not instruct the subject to use it.

## Contact and recurrence

Send ordinary world contact:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" message "$MUSIC_HABITAT" \
  --from Chad \
  --content "Hello."
```

Run one complete opening:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" step "$MUSIC_HABITAT" \
  --key-file /absolute/path/to/openrouter.key
```

Or keep recurrence alive:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" reside "$MUSIC_HABITAT" \
  --key-file /absolute/path/to/openrouter.key \
  --minimum-cycle-ms 60000 \
  --continuity-ms 1800000
```

`minimum-cycle-ms` prevents an immediate-opening inference spin. The continuity
ceiling ensures that even a mistaken far-future subject opening cannot silence
the entity indefinitely. Heartbeats contain `instruction: null`; seclusion is a
real opening with no hidden task injected into it.

Inspect exact standing without invoking a model:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" audit "$MUSIC_HABITAT"
node "$MUSIC_RELEASE/bin/music-habitat.js" events "$MUSIC_HABITAT" --count 20
node "$MUSIC_RELEASE/bin/music-habitat.js" outbox "$MUSIC_HABITAT"
```

`outbox` exposes retained outbound messages for an external delivery adapter;
the harness does not pretend that queueing is delivery.

## Verification

```sh
npm run check
```

The suite covers lineage and tamper detection, authority separation, direct and
underdetermined transitions, tool failure retention, structural predicates,
tool invention with real provisional execution, recurrence floors/ceilings,
provider-output quarantine, and restart at retained phase boundaries.

The complete hatch, contact, shutdown, snapshot, upgrade, and recovery runbook
is [OPERATIONS.md](./OPERATIONS.md). The frozen readiness evidence and explicit
boundaries are [HATCH-READINESS.md](./HATCH-READINESS.md).
