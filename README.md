# Music

**This is the song that never ends.**

Music is an experimental harness for one continuing agent identity. Its ordinary
tools are versioned executable JavaScript modules with the normal authority of
the Music Node.js process. File access, child processes, network access, native
modules, and arbitrary code are not sandboxed by the harness.

The stable bootstrap retains the subject and encounter loop, loads tool modules,
binds invocations to exact Soundings and module digests, and stages, activates,
or rolls back executable revisions. It also supplies exact fact envelopes and a
bounded emergency projection when learned delivery geometry fails. Recoverability comes from append-only
ancestry and deferred activation—not from limiting what ordinary tools can do.
Every append holds an exclusive local writer lease. A resident holds that lease
for its lifetime, so a second resident or direct ledger writer is refused rather
than becoming another author of the same subject.

Repeated inference failure cannot hot-loop. The resident derives an exponential
retry floor from retained failure outcomes (five seconds up to five minutes by
default), so restart does not erase it. Ingress remains live and durable during
the delay. This is an emergency continuity floor beneath revisable scheduling,
not a claim that fixed kernel policy should decide when the subject wants contact.

The first SIGINT or SIGTERM requests graceful shutdown: Music stops opening new
encounters and waits for the active one to retain completion. A second signal is
the explicit force-abort path. This prevents receiving an outbound effect and
then accidentally requeueing its contact merely because the process was stopped
before the model's final step finished.

A resident runtime watches a durable filesystem ingress. External adapters
atomically submit world-authored Delta files without writing the subject ledger;
the one resident runtime admits them, wakes an encounter, and archives each
arrival. A Delta arriving during inference is durably injected into that same
encounter at the next completed model-step boundary. If the encounter has
exhausted its step budget, the pending contact wakes a follow-up Sounding.

The same mailbox root now carries durable outbound delivery. The ordinary
`message` module—not fixed kernel policy—atomically writes the human-visible
message and includes the exact retained invocation ID. `music talk` and
`music reply` submit inbound contact and wait for that explicit tool delivery;
final model text remains private working speech. A reply can therefore return as
a consequence Delta bearing on the precise message invocation it answers.

The current causal path is:

```text
world Delta -> Sounding -> active carrier
            -> exact fact envelopes -> revisable encounter shape
            -> exact prior invocation reference
            -> actor-authored alternatives -> selected executable input
            -> unrestricted tool module -> retained invocation
            -> staged source revision -> changed later execution
            -> retained prior source -> rollback successor
```

Initial ordinary modules live in [`tools/`](./tools). `file_patch` performs a
real atomic textual replacement on any path visible to the process. `message`
performs real durable mailbox delivery, and even `select_tool_action` is an
ordinary revisable module.
`attend_consequence` lets the one mind defer or settle a consequence; deferred
consequences return in later Soundings. `shape_encounter` controls the ordering,
framing, and emphasis of initial Soundings and waking steering contact while the
kernel requires every authoritative fact envelope to remain byte-exact. Their
source is seed material for a new subject; afterward, the ledger-retained active
version is authoritative.

Seed modules are dynamically loaded only by `music init`. Reconstructing an
existing subject does not import `tools/`; a broken or deleted seed file cannot
prevent an already-living subject from loading its ledger-retained machinery.

`manage_dependency` is ordinary revisable machinery too. It runs real npm—with
normal lifecycle scripts and unrestricted network/process authority—inside the
resident dependency habitat (by default `LEDGER.dependencies`). Learned tools
can resolve installed packages from `context.environment.dependencyRoot`.

Startup can recover a syntactically torn final ledger write. The exact fragment
is preserved beside the ledger and an append-only recovery receipt is added.
A complete event with a bad digest is treated as corruption and is never
silently truncated.

The standalone `music-doctor` uses only Node built-ins and Git. It checks the
tracked continuity runtime against committed `HEAD`; explicit restore first
copies every divergent core file into `.music/bootstrap-recovery/`, then
atomically restores committed bytes. This is a recovery root, not a sandbox:
unrestricted tools can still alter these files, and the remote Git history is
the further copy if the local doctor or repository metadata is damaged.

`revise_tool` and `rollback_tool` are bootstrap meta-tools. A revision carries a
complete replacement description, JSON Schema, optional selection geometry, and
JavaScript function body. It remains unavailable in the current Sounding and
becomes active only when the inference completes successfully. Rollback does not
erase history: it copies a retained earlier executable body into a new child of
the current version.

A world-authored Delta may declare that it `bearsOn` an exact retained tool
invocation. That reference assigns no meaning to the observation. The one mind
may cite consequence Deltas delivered in its current Sounding when staging a
tool or carrier successor or an append-only rollback; the ledger then retains
the exact Delta-to-invocation-to-successor lineage.

Inference uses AI SDK 7. OpenRouter has a separate dedicated provider path in
strict compatibility mode, with tool-capability preflight and explicit spend
guards. The example remains locked to `z-ai/glm-5.3-flash`.

## Try it

Requires Node.js 22 or newer.

```sh
npm test
node src/cli.js init /tmp/music-events.jsonl Aster
node src/cli.js sound /tmp/music-events.jsonl manual
node src/cli.js audit /tmp/music-events.jsonl
```

To submit a durable world Delta and run the continuing resident loop:

```sh
node src/cli.js submit /tmp/music-inbox /path/to/delta.json
node src/cli.js reside /tmp/music-events.jsonl examples/openrouter.model.json /tmp/music-inbox
```

`submit` writes atomically into `pending/`. The resident is the sole ledger
writer and moves arrivals to `accepted/` or `rejected/`; replay of an already
admitted Delta id is archived without duplicating world contact.

With the resident running, a separate terminal can open a real round trip:

```sh
node src/cli.js talk /tmp/music-inbox Chad "Hello. Are you there?"
node src/cli.js listen /tmp/music-inbox
node src/cli.js reply /tmp/music-inbox OUTBOUND_INVOCATION_ID Chad "That worked."
```

`talk` starts new contact; `reply` additionally binds the inbound Delta to the
outbound invocation ID printed by Music. Both wait up to 60 seconds for a new
explicit message-tool delivery. `listen` drains proactive or later deliveries.
Files move to `outbound/delivered/` only after their JSON has been written to the
terminal, so a crash may repeat a display rather than silently lose it.

Set `MUSIC_DEPENDENCY_ROOT` when the resident dependency habitat should live
somewhere other than `LEDGER.dependencies`.

To inspect or explicitly repair the tracked continuity bootstrap:

```sh
node bin/music-doctor.js check /path/to/music
node bin/music-doctor.js restore /path/to/music
```

`restore` is intentionally explicit because it overwrites current core source;
the overwritten bytes remain in the reported backup directory.

To run a deliberately capped OpenRouter connectivity probe:

```sh
set -a
source /Users/chad/.config/music/openrouter.env
set +a
node src/cli.js run /tmp/music-events.jsonl examples/openrouter.model.json manual
```

The example permits one model step, 32 output tokens, and no retries. It is not
long enough for a multi-step selection and invocation sequence. See
[`DESIGN.md`](./DESIGN.md) for the exact stable boundary, causal evidence, and
remaining failure frontier.
