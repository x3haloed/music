# Music v3

Music v3 is a compact developmental habitat and candidate final Open
Trajectory harness. It runs
one exact continuing subject through a prospectively sealed sequence of fresh
model contexts and independently owned world consequences without a researcher
choosing the phase between cycles.

The implementation has one transition authority, an append-only hash-chain
ledger, a content-addressed object store, versioned actor and world adapters,
prospectively bound wagers, subject-authored executable pursuit selectors,
deterministic selector application and consequence predicates, exact scoped
transitions, behavioral floors, restart-safe idempotency keys, and
projection-only matched controls. A resident can also receive durable
observations, wait in seclusion, operate under revocable machine-owner grants,
cross process and bounded-episode boundaries without changing subject identity,
and leave replayable snapshots.

Seclusion is real but not annihilation. External observations wake the subject
immediately, subject-requested openings wake it when due, and the sealed
`continuityPulseMs` floor (five minutes by default) eventually delivers an
ordinary retained observation shaped as
`{kind: "continuity-pulse", instructions: []}`. A far-future opening therefore
cannot silence the resident indefinitely, and continuity does not smuggle in a
task.

## Quick verification

```sh
npm install
npm run check
npm run rehearse
node bin/music-install.js /absolute/new/release-directory
```

`rehearse` runs a deterministic multi-cycle developmental trajectory through
two independent world adapters. It is executable evidence about the harness,
not evidence that an AI subject develops.

The standard selector organ lives at `subject.mechanisms.pursuitSelector`.
When present, every unblocked wager publishes the selector's scalar measurement;
the kernel excludes blocked candidates, rejects missing measurements, preserves
tied extrema, and permits election only from the resulting subset. The selector
itself remains ordinary consequence-addressable subject state. Every fresh
perspective receives its exact writable contract in
`developmentalInterfaces.pursuitSelector`; a consequence-bound transition may
install, replace, or remove it. Removal restores ordinary actor election on the
next frontier.

The supported hosted actors are OpenRouter and an ephemeral `codex exec`
adapter. Both open a fresh provider context for every role. OpenRouter returns
plain JSON text for broad model compatibility; Music validates it locally
against the exact role schema before the kernel can use it. The actor condition
also seals reasoning effort and output budget.
The CLI defaults its machine-owner provider policy to the single approved
OpenRouter model `z-ai/glm-5.3-flash`. Set comma-separated
`MUSIC_ALLOWED_OPENROUTER_MODELS` explicitly to change that spending boundary;
a sealed run naming any other model fails before inference.

The starter world set includes durable operator outbox delivery, bounded HTTP
JSON, structured external JSON commands, paginated UTF-8 file reads, atomic
file writes, exact-count file patches, bounded ripgrep search, and unrestricted
foreground shell execution with process-group timeout handling. Relative local
paths resolve from `RUN/workspace`; absolute paths remain available. Every
world has an exact sealed identity and effect requirement (`local.read`,
`local.write`, `local.execute`, `network.fetch`, or `operator.message`). Shell
timeouts return `effect: "possibly-partial"` rather than pretending an
arbitrary command was rolled back.

File input is bounded before body allocation: `file-read` refuses sources over
16 MiB, while `file-patch` refuses sources or projected results over 8 MiB.
Sparse files and files that grow beyond their checked size are refused. The
unrestricted shell remains available when deliberate streaming or specialized
large-file handling is needed.

## CLI

```sh
# Inspect runtime and repository readiness
node bin/music-doctor.js

# Create a sealed run from JSON
node src/cli.js worlds
node src/cli.js template http-json > /absolute/spec.json
node src/cli.js init /absolute/run-directory /absolute/spec.json

# Or initialize and remain resident until the bounded observation ends
node src/cli.js template operator-outbox codex-exec > /absolute/hatch.json
node src/cli.js hatch /absolute/run-directory /absolute/hatch.json

# Advance until the subject stops or the frozen cycle limit is reached
OPENROUTER_API_KEY=... node src/cli.js run /absolute/run-directory

# Or remain resident across subject-authored not-before openings
OPENROUTER_API_KEY=... node src/cli.js reside /absolute/run-directory

# Deliver new experience, alter machine-owner authority, and snapshot evidence
node src/cli.js observe /absolute/run-directory '{"request":"..."}' operator machine-owner
node src/cli.js outbox /absolute/run-directory
node src/cli.js revoke /absolute/run-directory network.fetch 'maintenance window'
node src/cli.js grant /absolute/run-directory network.fetch 'maintenance complete'
node src/cli.js snapshot /absolute/run-directory /absolute/snapshot-directory

# Carry an open subject into a new prospectively sealed episode
node src/cli.js continue /absolute/new-run /absolute/new-spec.json /absolute/prior-run

# Inspect exact state without model inference
node src/cli.js audit /absolute/run-directory

# Run the bundled deterministic causal rehearsal
node src/cli.js rehearse /absolute/output-directory
```

## Music Companion

The optional macOS Companion is an external conversation and observation
window. It does not own the resident loop or alter its authority. Human
messages are submitted through the exact sealed CLI of the running resident as
ordinary `operator` observations from `Chad`; resident messages appear only
after a real `operator-outbox` contact. The activity disclosure is a projection
of retained ledger facts, not another inference layer.

For the default durable resident:

```sh
npm run companion
```

Set `MUSIC_RUN_DIR` to attach to another run. If that run is not currently
resident, set `MUSIC_RESIDENT_CLI` to the absolute `src/cli.js` inside its sealed
release before sending. Build a standalone Apple Silicon application with:

```sh
npm run companion:package
```

The application is written to `dist/Music Companion-darwin-arm64/`. Closing its
window leaves its menu-bar item available; quitting Companion never stops the
resident.

A normal run specification names an OpenRouter or ephemeral Codex actor and
built-in world adapters. Additional adapters can be registered by embedding the
library; their stable identity and effect requirements must match the sealed
specification.

See [HATCH.md](./HATCH.md) for the operating procedure, [DESIGN.md](./DESIGN.md)
for the claim envelope and authorities, and [READINESS.md](./READINESS.md) for
the exact local evidence and the boundary between an engineering hatch and a
scientific developmental claim.

The release installer copies only the runtime body and lockfile, installs
production dependencies in a new directory, runs the copied doctor, and then
publishes the directory atomically with `release.json`. Resident stores belong
outside both that immutable release and the mutable development checkout.
