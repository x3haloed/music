# Music

**This is the song that never ends.**

Music is an experimental harness for one continuing agent identity. Its ordinary
tools are versioned executable JavaScript modules with the normal authority of
the Music Node.js process. File access, child processes, network access, native
modules, and arbitrary code are not sandboxed by the harness.

The stable bootstrap retains the subject and encounter loop, loads tool modules,
binds invocations to exact Soundings and module digests, and retains provisional
executable revisions for trial and explicit developmental admission. It also supplies exact fact envelopes and a
bounded emergency projection when learned delivery geometry fails. Recoverability comes from append-only
ancestry and deferred activation—not from limiting what ordinary tools can do.
Every append holds an exclusive local writer lease. A resident holds that lease
for its lifetime, so a second resident or direct ledger writer is refused rather
than becoming another author of the same subject.

Fresh format-12 subjects carry a parent-bound developmental position in every
Sounding. `revise_tool` authors provisional source rather than activating it on
clean completion. The subject can inspect and exercise that source, then use an
explicit atomic developmental transaction to admit or withhold it. Authorship,
trial, inference completion, and developmental promotion have distinct receipts.

Repeated inference failure cannot hot-loop. The resident derives an exponential
retry floor from retained failure outcomes (five seconds up to five minutes by
default), so restart does not erase it. Ingress remains live and durable during
the delay. This is an emergency continuity floor beneath revisable scheduling,
not a claim that fixed kernel policy should decide when the subject wants contact.

The subject can decide that timing itself. The ordinary, revisable
`schedule_wake` tool stages an exact future wake during an encounter. It becomes
active only when that inference completes, survives restart, suppresses the
fallback heartbeat until due, and returns as an exact fact in the waking
Sounding. Earlier world contact preempts the timer but carries its retained
reason into the contact Sounding. Interruption restores the wake that opened the
failed encounter. The fixed heartbeat is only the continuity fallback when the
subject chose no future wake.

Birth does not require a preselected personal name. The ledger gives the one
subject a stable opaque identity and the mind may later retain a self-designation
through its own continuity machinery—or choose none. The automatically present
`continuity` carrier component begins empty. The ordinary `retain_context` tool
lets the subject author the bounded account of its current situation that later
encounters should receive; completed transcripts remain inert audit history and
larger records may live in the resident-owned home. No summary is generated and
no update is obligatory.

Inference opportunity is plastic too. The projected `inference_policy` carrier
defaults to 120 model steps, a 2 MiB ceiling for each retained inference event,
and a 30-minute encounter timeout. The ordinary `tune_inference` tool stages a
successor policy for later encounters. The kernel keeps only broad physical
ceilings (10,000 steps, 64 MiB per inference event, and 24 hours) so a malformed
policy cannot make the continuity path physically unbounded.

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

Contact is sealed into a Sounding only after its complete exact-fact projection
is known to fit. A digest-bound frontier records the ordered queue, included
prefix, remainder, and next Delta; later Soundings drain the remainder without
loss or reordering. The same admission rule bounds live steering. Unresolved
consequences use retained bounded sweeps, so every item becomes visible without
turning a large unresolved set into either a deadlock or an immediate endless
replay. Learned tool and carrier revisions are also refused before activation if
their aggregate projected geometry would consume the reserved contact envelope.

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
The resident also begins with Watch-informed general affordances rather than
having to invent basic embodiment from inside a blind first encounter:
`read_file` provides bounded line-numbered text pagination, `write_file` creates
or explicitly replaces text files atomically, `search_files` discovers paths or
content through ripgrep, `shell` runs unrestricted foreground commands with
separate bounded output and explicit timeout uncertainty, and `web_fetch`
performs bounded direct HTTP requests. Each remains an independently revisable
ordinary module; none is fixed kernel policy.
`attend_consequence` lets the one mind defer or settle a consequence; deferred
consequences return in later Soundings. `shape_encounter` controls the ordering,
framing, and emphasis of initial Soundings and waking steering contact while the
kernel requires every authoritative fact envelope to remain byte-exact. Their
source is seed material for a new subject; afterward, the ledger-retained active
version is authoritative.
`schedule_wake` lets that same mind construct its own next temporal opening; its
interface and executable timing policy are revised through the same ancestry as
every other ordinary tool.
`retain_context` and `tune_inference` expose subject-authored situational
continuity and inference-envelope policy through the same ordinary, revisable
tool path.

When inventing or revising a tool, `source` contains executable async-function
body statements. It uses `input` and `context` directly and returns a JSON value;
it is not wrapped in `function` or `async function` syntax. Music returns a
specific corrective diagnostic when a wrapper would otherwise only yield
`undefined`.

A fallback heartbeat is secluded time, not a task. The seed encounter shaper
therefore delivers heartbeat facts without appending a request, reporting
obligation, or behavioral instruction. The heartbeat continues to carry exact
current geometry, and the resident may later revise the shaper itself.

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
JavaScript function body. It remains provisional across clean completion until
the subject exercises and explicitly admits it. Rollback does not erase history:
it authors a provisional child that copies a retained earlier executable body,
then passes through the same exercise and explicit rollback transaction.

A world-authored Delta may declare that it `bearsOn` an exact retained tool
invocation. That reference assigns no meaning to the observation. The one mind
may cite consequence Deltas delivered in its current Sounding when staging a
tool or carrier successor or an append-only rollback; the ledger then retains
the exact Delta-to-invocation-to-successor lineage.

Inference uses AI SDK 7. OpenRouter has a separate dedicated provider path in
strict compatibility mode, with tool-capability preflight and explicit spend
guards. The example remains locked to `z-ai/glm-5.3-flash`.

Each completed AI SDK step is appended immediately as an
`inference_checkpointed` event rather than accumulating every assistant/tool
turn in one terminal event. Completion or failure therefore closes already
retained work instead of attempting one monolithic append. Provider requests
retain URL, non-secret header names, model, message/tool counts, byte length,
and an exact body digest without duplicating the expanding request body into
every checkpoint. An explicit model-config `maxSteps` can still narrow the
carrier policy for a disposable spend-capped probe, but the long-term habitat
does not impose a second step authority.

## Hatch status

The pre-hatch causal path has completed a bounded live rehearsal with a fresh
disposable subject and `z-ai/glm-5.3-flash`: real inbound mailbox contact, retained
actor-authored selection, explicit outbound delivery with exact Delta lineage,
completed inference and Sounding, then clean one-signal shutdown. The final
ledger had no pending contact, failed inference, or failed/uncertain invocation
or projection. A subsequent independent audit's aggregate-capacity finding is
now closed by retained ordered frontiers, and the resident can construct and
revise its own future wakes without a second scheduler actor. Music is ready to
host its first long-term resident. This marks
habitat readiness, not the end of learning or a claim that future tools and
contact surfaces should be designed in advance.

A bounded live GLM Flash rehearsal also crossed the self-directed wake path: one
inbound Delta caused one `schedule_wake` invocation and a completed inference
with an exact retained ten-minute wake, no pending contact, and no failed or
uncertain operation.

## Installation and hatch

Development, installed runtime bytes, and resident state are deliberately
separate. The release installer accepts only a clean pushed commit, creates an
independent detached clone, installs locked dependencies, runs all checks, and
atomically updates a convenience `current` symlink. A resident is launched from
an exact release path, never from the development checkout or `current`.

`music-habitat create` prepares an empty home, state, mailbox, dependency, and
configuration tree without creating a subject. `music-habitat init` is the
separate explicit hatch act and requires no subject name. Runtime starts retain
the exact release commit, path and working-tree state beside the resident home
in the append-only ledger.

See [`OPERATIONS.md`](./OPERATIONS.md) for the prepared machine layout, exact
hatch procedure, snapshot discipline, and compatibility-gated upgrades.

## Development use

Requires Node.js 22 or newer. The seed `search_files` tool also expects
[`rg` (ripgrep)](https://github.com/BurntSushi/ripgrep) on `PATH`; because the
tool is ordinary retained geometry, the resident may later replace that search
embodiment without changing the kernel.

```sh
npm test
node src/cli.js init /tmp/music-events.jsonl
node src/cli.js sound /tmp/music-events.jsonl manual
node src/cli.js audit /tmp/music-events.jsonl
```

To submit a durable world Delta and run the continuing resident loop:

```sh
node src/cli.js submit /tmp/music-inbox /path/to/delta.json
mkdir -p /tmp/music-home
export MUSIC_HOME=/tmp/music-home
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
mkdir -p /tmp/music-home
export MUSIC_HOME=/tmp/music-home
node src/cli.js run /tmp/music-events.jsonl examples/openrouter.model.json manual
```

The example permits one model step, 32 output tokens, and no retries. It is not
long enough for a multi-step selection and invocation sequence. See
[`DESIGN.md`](./DESIGN.md) for the exact stable boundary, causal evidence, and
remaining failure frontier.
