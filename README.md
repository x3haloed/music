# Music v4

Music hosts one continuing subject through a content-free developmental
recurrence. The subject is not a transcript or a provider thread. Its durable
body is an exact, content-identified developmental position whose installed
machinery mechanically determines which operation is warranted next.

```text
exact position + ordinary world facts
  -> select | realize | contact | correct | assimilate | expand | wait
  -> one fresh operation-specific model perspective when judgment is needed
  -> deterministic binding or world execution
  -> exact receipt and consequence classification
  -> deterministic successor compilation
  -> reopened subject
```

The operation class is never chosen by a generic model call. Selection chooses
a developmental stake; realization designs one exact contact; the kernel later
executes that contact without inference; correction or assimilation receives
the independently retained consequence. Saturated local geometry routes to
expansion, and an honestly empty reachable field routes to bounded waiting
rather than subject termination.

Model invocations are fresh perspectives of the same subject. They share no
provider response chain, model thread, workspace, or hidden scratch state.
Continuity lives only in the exact retained position and evidence. The initial
subject has no preselected personal name.

## What is stable and what can learn

The small stable core verifies schemas, derives the next operation, invokes the
selected inference provider, executes bound world calls, stores exact evidence,
and compiles successors. Selection and attention organs are inspectable subject
state with declared schemas and mutation surfaces. A consequence-bearing
correction or assimilation can revise them prospectively.

Operational succession and developmental revision are distinct. Every accepted
operation advances exact ancestry, but a successful tool call, a completed
model turn, or waiting does not by itself count as learning.

The opportunity projection is mechanically derived from authoritative state.
It is an attention surface only: it has no authority to select a target, admit
development, cause an effect, or declare an outcome.

## World contact

The starter envelope includes:

- content-addressed evidence reading;
- durable operator outbox delivery;
- bounded HTTP JSON and structured external JSON commands;
- paginated file reading, atomic file writing, exact-count patching, and search;
- unrestricted foreground shell execution with process-group timeout handling.

Local paths resolve from `RUN/workspace`; absolute paths remain available. The
shell is deliberately unrestricted and not process-isolated. Its timeout means
an effect may be partial. File reads reject sources over 16 MiB before loading
them, and patches reject sources or projected results over 8 MiB.

World adapters own effect and receipt truth. Actor prose and files containing
claims remain interpretations. Each adapter publishes its exact contract,
effect requirements, attestation types, and receipt shape. Contact is
restart-safe: an interrupted effect retains the same binding and idempotency
identity on retry.

Human messages arrive through `observe` as ordinary world events. They receive
no special transition or trajectory authority.

## Inference and attention

Run genesis explicitly seals either OpenRouter or subscription-backed Codex
inference, including model, reasoning effort, limits, and adapter identity.
OpenRouter defaults to the approved `z-ai/glm-5.3-flash`; additional models must
be named in `MUSIC_ALLOWED_OPENROUTER_MODELS`. Codex uses a fresh `--ephemeral`
process for every perspective, with no tools, thread continuation, user rules,
or repository instructions.

The retained projection is bounded at 200,000 input tokens and 900,000
characters. It carries the exact current subject once, unresolved evidence,
compact causal transitions, and content-addressed retrieval paths—not an
ever-growing transcript. Resolved opportunity and memory material is indexed
before salient active evidence is trimmed. Provider caching may reuse stable
prefix tokens, but never response state or continuity authority.

The runtime body is immutable during residence, but it is not a life sentence.
A stopped run can accept an explicit runtime epoch: Music first takes an exact
snapshot, then records the prior ledger head and implementation digest, the new
runtime provenance and refreshed implementations of the same declared worlds,
and the unchanged subject identity. An epoch cannot change inference, grants,
limits, initial conditions, world IDs, or world adapter names. Old code then
refuses to advance the upgraded run; the new body must pass `runtime-check`.

## Verify

```sh
npm ci
npm run check
npm audit --omit=dev
node bin/music-doctor.js
node src/cli.js rehearse /absolute/new/rehearsal-directory
```

The deterministic rehearsal exercises contradiction, consequence-grounded
selector revision, changed later choice, support assimilation, saturation,
expansion, honest waiting, fresh-context separation, and restart-safe contact.
It is engineering evidence about the harness, not a scientific claim that a
resident will develop wisely.

## CLI

```sh
node src/cli.js worlds
node src/cli.js template starter codex gpt-5.6-terra > /absolute/spec.json
node src/cli.js preflight /absolute/spec.json
node src/cli.js init /absolute/run /absolute/spec.json
node src/cli.js observe /absolute/run '{"message":"Hello."}' operator Chad
node src/cli.js reside /absolute/run

node src/cli.js audit /absolute/run
node src/cli.js outbox /absolute/run
node src/cli.js snapshot /absolute/run /absolute/new-snapshot
node src/cli.js upgrade /absolute/run /absolute/pre-upgrade-snapshot 'reason'
node src/cli.js runtime-check /absolute/run
node src/cli.js revoke /absolute/run network.fetch 'maintenance'
node src/cli.js grant /absolute/run network.fetch 'maintenance complete'
```

`hatch RUN SPEC` combines initialization and residence for foreground use.
`resident RUN SPEC` initializes only if the ledger does not exist, making it
safe for macOS service restarts. `SIGINT` and `SIGTERM` release the resident
lease without closing the subject.

## Immutable installation and Companion

```sh
node bin/music-install.js /absolute/new/release-directory
node /absolute/new/release-directory/bin/music-doctor.js
node /absolute/new/release-directory/bin/music-service.js install \
  com.x3haloed.music.resident-v4 /absolute/new/release-directory \
  /absolute/run /absolute/spec.json
```

The release installer publishes a new immutable runtime only after production
dependencies and the copied doctor pass. Resident state belongs outside both
the release and the development checkout. Runtime upgrades are explicit ledger
epochs performed only while the resident is stopped; they are never implicit
file replacement. The LaunchAgent contains no secret;
Codex subscription inference is therefore the simplest unattended provider.

Music Companion is an external observation window, not an authority or another
mind. It discovers the active V4 resident and imports that resident release's
matching inspection code:

```sh
npm run companion
npm run companion:package
```

See [DESIGN.md](./DESIGN.md), [HATCH.md](./HATCH.md), and
[READINESS.md](./READINESS.md).
