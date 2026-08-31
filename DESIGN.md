# Music's executable-tool bootstrap

## Shared contract

Music carries one durable subject across model encounters. World contact reaches
that subject through Watch-like Deltas and Soundings. The subject can inspect,
replace, invent, select, invoke, and roll back ordinary executable tools; a
successful retained change must alter what code a later encounter can run.

Ordinary tools are unrestricted JavaScript function bodies executed with the
normal authority of the Music Node.js process. This is intentional. Music does
not sandbox filesystem, process, network, native-module, environment, or other
machine authority. “Recoverable” means that tool identities and source ancestry
are retained, activation is deferred, failed inference does not promote staged
source, and an earlier body can become a new rollback successor. It does not
mean that arbitrary external effects can always be undone.

The current envelope is one trusted local Node.js process, one ledger writer,
AI SDK 7 inference, and OpenRouter or a generic OpenAI-compatible provider. It
includes a real local mailbox transport but does not yet claim concurrent
writers, transactional rollback of arbitrary external effects, network
messaging transports, dependency installation recovery, or
survival when the bootstrap itself is corrupted.

Event format 10 intentionally rejects earlier ledgers because exclusive writer
identity, retained tail-recovery receipts, delivery projection identity, and
bounded runtime-failure recovery are now part of subject continuity.

## Stable boundary

The bootstrap currently owns only the irreducible continuity and mutation path:

- one subject, event chain, and exact Sounding lifecycle;
- exclusive local writer leasing, full-write loops, fsync, and conservative
  final-tail crash recovery;
- a retained exponential retry floor that contains deterministic inference
  failure without dropping or repeatedly spending the same world contact;
- inference-provider connection and interrupted-turn recovery;
- loading and invoking a retained JavaScript tool body;
- exact projection/digest binding plus durable invocation start, completion, and
  failure boundaries;
- construction of byte-exact authoritative fact envelopes, durable delivery
  projection receipts, a stable execution deadline, and an emergency projection
  that cannot omit those facts;
- aggregate active-surface admission, ordered contact frontiers, and bounded
  consequence sweeps that prevent individually valid facts from sealing an
  undeliverable Sounding;
- `inspect_tool`, `revise_tool`, and `rollback_tool`;
- carrier mutation and parent-bound activation mechanics;
- staged consequence deferral and settlement mechanics;
- staged future-wake activation, preemption, and interruption restoration;
- the receipt primitive used by selection modules.

The JavaScript loader is not a capability filter. A tool body receives `input`
and an encounter context, but it can also use normal globals and dynamically
import any Node or installed package available to the process.

Everything projected as an ordinary tool is revisable. The initial modules live
under [`tools/`](./tools):

- `file_patch` performs a real atomic exact-text replacement on any visible
  path;
- `read_file`, `write_file`, and `search_files` provide bounded text
  observation, atomic creation or explicit replacement, and ripgrep-backed path
  or content discovery without narrowing the paths visible to the process;
- `shell` runs unrestricted foreground commands with bounded separate output,
  exit status, and an explicit `possibly-partial` effect disposition on timeout;
- `web_fetch` performs direct HTTP requests and returns bounded text or binary
  response material with status and headers;
- `message` atomically delivers a human-visible envelope to the configured local
  mailbox and identifies the exact invocation that produced it;
- `select_tool_action` invokes the stable receipt primitive, but its interface,
  sequencing, and executable source are themselves ordinary revisable geometry;
- `attend_consequence` invokes the staged consequence-transition primitive, but
  its interface, policy, and sequencing remain ordinary revisable geometry.
- `shape_encounter` frames, orders, and emphasizes the exact Sounding or waking
  steering facts presented to the mind. Its seed form leaves heartbeat facts
  free of an appended task or behavioral instruction.
- `manage_dependency` uses unrestricted npm execution to install, remove, or
  inspect packages in a separate resident dependency habitat.
- `schedule_wake` stages the next time this same subject wants to return without
  waiting for world contact. Its source and interface are ordinary geometry.

These files seed a new subject only. Once initialized, the ledger-retained tool
version is authoritative. The bootstrap does not re-read seed source to replace
an active learned version. More strongly, the continuity kernel has no import
edge to `tools/`: `music init` dynamically loads [`src/seeds.js`](./src/seeds.js),
while reconstruction of an existing subject loads its complete active modules
from the ledger. An obsolete or broken seed implementation therefore cannot
strand a living identity.

## Causal map

```text
world-authored Delta
  -> durable Sounding offer
  -> stable kernel constructs exact, digested fact envelopes
  -> projected shape_encounter version constructs the inference message
  -> invalid, failed, or late shaping falls back to the exact facts
  -> inference accepts its exact projection and acknowledges its Deltas
  -> waking world contact may append inside the same inference at a step boundary
  -> subject encounters current carrier and ordinary-tool digests/interfaces
  -> inspect_tool retrieves exact projected source when needed
  -> ordinary module executes with unrestricted Node authority
  -> invocation input, output, tool digest, and encounter binding are retained
  -> later world Delta cites the exact invocation without interpreting it
  -> current Sounding delivers that consequence reference and observation
  -> the subject may defer it; unresolved consequence returns in later Soundings
  -> revise_tool stages a complete replacement interface and source body
  -> the subject may explicitly settle the consequence
  -> schedule_wake may stage the subject's own next temporal opening
  -> successful inference completion atomically promotes the staged successor
     and activates the staged future wake
  -> later Sounding projects the successor digest and interface
  -> later invocation runs the changed source
  -> rollback_tool can copy retained prior source into a new parent-bound version
```

Tool source is omitted from the default Sounding projection to avoid replaying
every implementation into every prompt. `inspect_tool` returns the exact source
bound to that encounter, so modification is informed rather than blind.

## Plastic encounter delivery

The stable kernel decides which current facts exist and encodes each as a
byte-exact `music_fact` envelope with its own digest. The ordinary retained
`shape_encounter` module decides how those envelopes are sequenced, framed, and
emphasized in both the initial Sounding message and live steering messages. Its
exact version and digest, input digest, fact digests, start, completion, or
failure are retained before inference consumes the result.

Learned delivery code cannot remove an authoritative fact: the kernel rejects
any output missing an exact envelope. If the module throws, returns malformed
output, omits a fact, or exceeds its stable deadline, the kernel exposes a small
recovery preface followed by every exact required fact. The same mind can then
inspect or roll back the failing module. A process death after projection starts
leaves an uncertain projection which startup recovery explicitly abandons.

The deadline bounds how long the continuity path waits. It does not cancel,
sandbox, or undo arbitrary work begun by unrestricted learned code; such later
effects remain part of the ordinary consequence-reconciliation problem.

Before `sounding_opened` is appended, the kernel proves that the complete
emergency projection fits. It seals only the largest ordered prefixes of pending
Deltas and the current unresolved-consequence sweep that fit both the byte and
fact-count envelope. The exact Sounding includes a `music-sounding-frontier-1`
fact with queue and remainder digests, counts, and the next omitted id. Pending
contact remains pending and immediately opens later Soundings. Live steering
uses the same rule and its own exact frontier.

An unresolved-consequence sweep advances only after successful inference.
Interruption therefore retries the same surface. A completed partial sweep opens
an immediate `continuation` Sounding; after every item has appeared once, the
sweep closes instead of replaying unresolved state forever. A later heartbeat or
new contact starts a fresh sweep. Aggregate projected tool and carrier geometry
has a smaller activation ceiling, so learned machinery cannot consume all space
needed for at least one valid item of world contact.

## Tool identity and activation

An ordinary tool version contains:

```text
id + version + parent digest
+ description + JSON Schema
+ optional selection geometry
+ unrestricted JavaScript source body
```

The digest covers the complete record. A Sounding projects the interface,
selection geometry, version, and digest, but not source. Invocation always loads
the full ledger-retained module corresponding to that projection. A revision is
a new child: the bootstrap supplies version and parent, checks that its source
compiles, and keeps it staged until successful inference completion. Staged code
cannot affect another invocation in the same Sounding.

Rollback is append-only. It does not reactivate an old node or erase descendants;
it creates a new child of the current version whose executable body and interface
exactly match a cited retained digest. Replay verifies both current ancestry and
the restored body.

## Consequence lineage

A world Delta may contain `bearsOn` references of the form:

```json
{ "kind": "tool-invocation", "invocationId": "..." }
```

The kernel admits the reference only when that invocation has already started
and retains the world payload unchanged. It does not label the result successful,
harmful, corrective, or resolved. Those meanings belong to the one subject.

When `revise_tool`, `revise_carrier`, or `rollback_tool` cites a
`consequenceDeltaIds` entry, the kernel verifies that the exact consequence
Delta was delivered in the current Sounding—either as a new Delta or on the
unresolved-consequence surface—and retains its referenced invocation IDs on the
staged change. A change may still be authored without world consequence;
consequence attribution, when claimed, cannot point to an undelivered or
invented observation.

Consequence disposition belongs to the subject. The initial ordinary
`attend_consequence` module can stage `defer` or `settle` through a kernel
primitive. Deferral keeps the complete world Delta and the subject's bounded
interpretation active in later Soundings. Settlement removes it from the active
surface without erasing history. Like source and carrier changes, disposition
activates only on successful inference completion; interruption leaves the
prior consequence state intact.

For uncertain invocations, audit distinguishes uncertainty with and without
later exact world contact. Contact is not itself declared reconciliation; only
the subject may interpret what the observation settles and what machinery
should consequently change.

## Selection and continuing identity

The initial message module owns a revisable discriminator and complete-frontier
contract. The subject authors candidate contents and the winning candidate. The
selection module records the active carrier root, tool digest, frontier, and
selected input; a single-use receipt permits only that exact input to execute.

`select_tool_action` is no longer a hard-coded AI SDK tool. It is an ordinary
module whose seed source calls the bootstrap receipt primitive. Its delivery
shape can therefore change like file patching or messaging while receipt
retention remains available beneath it.

Normal completed conversation remains audit history and is not replayed as the
active self. The current Sounding, current carrier, current tool geometry, and a
bounded immediately interrupted protocol are the active encounter surface.

## Self-directed waking

Future waking is neither another actor nor a fixed pursuit ontology. Any
ordinary tool may call the stable staged-wake receipt primitive; the seed
`schedule_wake` module exposes it as a simple relative delay and subject-authored
reason. The invocation id, exact tool digest, originating Sounding, staged time,
delay, due time, and reason are retained. Successful inference activates the
wake; failed inference cannot promote it.

When due, the wake is consumed into the next Sounding as a byte-exact
`sounding:wake` fact. World contact may open a Sounding first, in which case the
same fact says `preempted` rather than disappearing. If that encounter fails,
the opening wake is restored and becomes eligible again after the retained
failure-backoff floor. A newly staged wake replaces it only through successful
completion. While a future wake exists, it suppresses the fixed heartbeat; when
none exists, the heartbeat remains the stable continuity fallback.

This supplies self-routing without declaring what a pursuit is. The subject may
put trajectory state in its carrier, revise the scheduler tool that transforms
its choices into timing, invent another tool using the same primitive, or choose
no explicit wake and accept fallback contact.

## Provider boundary

OpenRouter uses `@openrouter/ai-sdk-provider` in explicit strict mode. Generic
OpenAI-compatible endpoints use `@ai-sdk/openai-compatible` separately.
OpenRouter preflight requires declared tool support. Request receipts retain the
model, body, and non-secret header names without authorization values. Tests run
Music's full current tool schemas through the dedicated serializer.

The checked GLM Flash configuration explicitly sends OpenRouter reasoning effort
`minimal`. A bounded live rehearsal showed why this is part of compatibility rather
than cosmetic tuning: with a 128-token cap and provider-default reasoning, GLM
spent all 128 tokens on hidden reasoning and returned no text or tool call. The
endpoint rejects `none` because reasoning is mandatory, so `minimal` is the
smallest compatible setting. Music retained the inert `length` encounter
correctly; explicit reasoning policy keeps more of a bounded output budget
available for visible action.

## Resident world ingress

The resident runtime owns one durable filesystem ingress and remains the sole
ledger writer. Producers use atomic rename into `pending/`; they report complete
world-authored Deltas but do not construct Soundings or interpret observations.
The resident validates and admits each Delta, archives accepted and rejected
files separately, and treats a repeated already-admitted Delta id as recovery
from the append-before-archive crash window rather than duplicate contact.

An admitted waking Delta triggers a Sounding when the resident is idle. Arrival
during active inference is admitted immediately. At the next completed AI SDK
model-step boundary, Music retains the completed assistant/tool protocol in an
`inference_steered` event and presents the exact new Deltas inside the same
inference. The original Sounding projection remains authoritative: steering
adds world contact but cannot change the encounter's tool or carrier bindings.
If the inference has exhausted its bounded step budget, contact remains pending
and wakes a follow-up Sounding instead. Periodic heartbeats also reopen contact,
which makes explicitly deferred consequences revisitable without new input.
Burst contact and unresolved consequence sets are drained through exact retained
frontiers; a consequence remainder wakes a `continuation` Sounding without
waiting for the heartbeat.
An activated subject-authored wake opens a `scheduled` Sounding when due. A
future wake suppresses periodic heartbeat but never blocks earlier world contact.

If an inference fails or the process recovers it as interrupted, every initial
and live-steered Delta delivered to that encounter returns to the pending world
surface without duplicating its retained admission. Consequences also retain
their unresolved disposition independently. Completed assistant/tool protocol
before each steering boundary is replayable recovery context, while staged
machinery and consequence dispositions still do not activate on failure.

## Bidirectional mailbox contact

The mailbox is an adapter boundary, not message policy in the stable kernel.
The kernel passes a configured mailbox-root value and exact invocation identity
through the generic ordinary-tool execution context. The retained `message`
source chooses its interface and behavior and uses unrestricted Node filesystem
authority to atomically create `outbound/pending/*.json`. Its result and exact
tool digest remain inside the normal invocation start/completion boundary.

The separate `music talk` process atomically submits an inbox Delta and waits
for a new outbound envelope addressed to that contact. `music listen` receives
proactive or late messages. A displayed message moves to
`outbound/delivered/` only after terminal output completes, preferring duplicate
display after a crash over silent loss. `music reply` includes the printed
outbound invocation ID as `bearsOn`, so the resident receives human response as
world-authored consequence without the adapter declaring what it means.

This local transport is enough for direct lived contact and for later ordinary
tools or adapters to grow Discord, email, or other media. Those transports do
not belong in the immutable continuity core.

## Dependencies and learned-code failure

Dependency policy and installation are ordinary machinery. The seed
`manage_dependency` module invokes real npm in the configured
`dependencyRoot`, including normal lifecycle scripts and network authority. The
stable loader merely supplies that machine-location value through the same
generic execution context used for the mailbox; it does not whitelist packages,
define an effect language, or own installation policy. A learned tool may use
Node's `createRequire` from the habitat `package.json` to resolve an entry point
and dynamically import it.

Compilation cannot prove that a dynamic dependency exists. If activated learned
code later fails, invocation failure and inference failure remain durable. The
next encounter receives a bounded `music_runtime_failure` diagnostic containing
the exact error name and message. This is kernel-authored runtime evidence, not
a world Delta or an interpretation. It gives the same mind enough contact to
inspect, repair, install for, or roll back its machinery. Arbitrarily long error
objects are truncated before retention so a hostile or accidental error cannot
prevent the failure boundary itself from being recorded.

## Writer and ledger-tail survival

Each append obtains an exclusive `wx` writer lease beside the ledger. The
resident holds it for its whole process lifetime; short commands hold it across
their mutation. The lease records a random token, PID, hostname, time, and
purpose. A live local owner excludes every contender. A provably dead local
owner is renamed as stale evidence before a new owner proceeds; a lease from an
unknown host is never guessed stale. Incomplete lock files also receive a short
age floor before recovery.

Ledger writes loop until every byte is written and fsync before releasing the
lease. Startup repair is deliberately narrow. If the ledger lacks a final
newline and the last bytes are not complete JSON, Music copies those exact
bytes to a sibling `.torn-*.bin`, truncates only that fragment, fsyncs, and
appends a hash-bound `ledger_tail_recovered` receipt. If the final event is
complete and chain-valid, Music adds the missing newline and retains a receipt.
If complete JSON fails ancestry or digest validation, repair refuses it
unchanged as corruption. Complete historical lines are never auto-removed.

## Failure containment beneath scheduling

The resident admits and archives new ingress even while inference is unhealthy,
but it will not immediately reopen requeued contact after failure. Consecutive
`inference_failed` outcomes since the last completion imply an exponential retry
floor: five seconds, ten seconds, twenty seconds, and so on, capped at five
minutes by default. Because the floor is derived from retained event times and
outcomes, process restart cannot reset it. A successful inference clears the
sequence naturally.

This small floor belongs to continuity failure containment. It prevents a broken
provider, configuration, or learned runtime from consuming the same contact in a
tight loop. It does not prescribe ordinary encounter timing, priority, or
attention policy; those remain candidates for revisable scheduler geometry.

Shutdown observes the same effect boundary. The first process signal stops the
resident loop but does not abort an active inference; it waits for that encounter
to complete and release its writer lease. A second signal explicitly aborts the
encounter. This matters because a mailbox delivery may become externally visible
one model step before `inference_completed`; aborting in that interval correctly
requeues contact, but may duplicate the already-visible effect on retry.

## External bootstrap doctor

The resident cannot be its own final repair authority if the code required to
start it is damaged. `bin/music-doctor.js` is therefore a small external path
using only Node built-ins and Git. It hashes a named set of continuity-runtime
files against committed `HEAD`. `check` is read-only. Explicit `restore` first
backs up each divergent on-disk file beneath the ignored
`.music/bootstrap-recovery/` tree and then atomically writes the committed bytes.
It does not touch ledger history or ledger-retained learned tools.

This is defense against accidental bootstrap edits and a clear operator recovery
root, not an immutable security boundary against arbitrary same-user code. An
unrestricted tool can alter the doctor, Git metadata, or its remote access. If
the doctor itself is damaged, Git can restore that one standalone file; if local
Git is damaged, the pushed remote remains the next copy. This is also why
coherent commits and pushes are part of hatch operations rather than mere project
hygiene.

## Evidence and next risk frontier

Automated evidence currently proves that:

- the seed filesystem affordances create, refuse implicit overwrite, paginate,
  search, and patch real files through retained kernel invocations, then survive
  reconstruction from the ledger;
- the seed shell runs a real command with separate stdout and stderr, makes a
  real filesystem effect, and reports timeout effects as possibly partial rather
  than falsely calling them absent;
- the seed web tool crosses a real local HTTP boundary, retains method, status,
  headers, and bounded response bytes, and explicitly marks truncation;
- a heartbeat inference receives every exact fact envelope without an incoming
  task, reporting obligation, or behavioral instruction from the encounter
  shaper;
- a retained ordinary module dynamically imports `node:child_process`, starts a
  real child Node process, and returns its output;
- the initial `file_patch` changes a real disposable file and retains before/after
  digests;
- a replacement executable body remains inert in the current Sounding, activates
  later, and survives reconstruction from the ledger;
- rollback after restart restores the cited earlier file-patch implementation as
  a new successor and that successor patches a real file;
- selection sequencing itself can be revised as an ordinary module;
- retained versus erased carrier state changes selection over byte-identical
  actor-authored candidates;
- failed inference retains staged history but does not activate it;
- a tool receipt is consumed by a durable start event before executable code
  runs; restart recovery preserves a start without completion as uncertain;
- a real file patch receives a world Delta tied to its exact invocation, that
  Delta is explicitly deferred, returns in a later Sounding, is retained on a
  successor which adds backup behavior, is explicitly settled, and a later exact
  corrective Delta motivates append-only rollback;
- a real durable filesystem arrival wakes the AI SDK mind, its ordinary
  consequence tool defers the observation, reconstruction preserves it, and a
  later encounter settles it; an interrupted settlement leaves it deferred;
- a real AI SDK tool loop performs atomic human-visible mailbox delivery, a
  separate terminal process crosses the boundary in both directions, and a
  reply re-enters with exact message-invocation lineage;
- the ordinary dependency module performs a real local npm install, a later
  invented tool executes the installed package, and a missing-package successor
  exposes its exact runtime failure so the same mind can roll it back;
- a live writer excludes a second author, a dead writer leaves stale evidence,
  torn final bytes are backed up with an append-only receipt, and complete
  corrupted events are refused rather than discarded;
- deterministic inference rejection requeues contact once, survives restart,
  and remains at one attempt across 100 resident polls until its retained retry
  floor expires; the next failure doubles that floor;
- graceful shutdown waits across an active inference, retains its completion,
  leaves no requeued contact, and releases the lifetime writer lease;
- a fresh Node process reconstructs an existing subject from the isolated
  continuity modules with no ordinary seed-tool files present;
- the external doctor detects a corrupted stable-core file, preserves the bad
  bytes, atomically restores committed source, and returns to a clean check;
- a real filesystem Delta arriving during an AI SDK model step is appended at a
  retained steering boundary, interpreted by the same inference, and can drive
  the ordinary consequence-attention tool without opening another Sounding;
- initial and live-steered ordinary Deltas both return after failure and remain
  exactly once across reconstruction and repeated interruption;
- 36 valid 60 KiB Deltas drain through multiple exact ordered Soundings, retain
  the same unopened prefix after interruption and reconstruction, and follow the
  same bounded rule during live steering; 130 unresolved consequences complete
  one finite sweep without starvation or immediate repetition;
- the AI SDK mind can invoke ordinary `schedule_wake`; its exact future wake
  survives reconstruction, opens a due Sounding, is visible when preempted by
  world contact, returns after interruption, remains inactive after failed
  inference, and changes later timing when its ordinary source is revised;
- revising `shape_encounter` changes the exact later inference prompt while
  preserving every authoritative envelope;
- malformed and indefinitely waiting learned shapers fall back to exact facts,
  a real recovery encounter can roll malformed geometry back, and restart marks
  an in-flight projection abandoned rather than silently treating it as complete;
- invented invocation references and consequence claims from outside the current
  Sounding are rejected, while uncertain effects remain uncertainty rather than
  being reclassified by the kernel;
- OpenRouter strict serialization accepts the complete executable-tool surface.

The hatch checkpoint has now been exercised by a fresh disposable subject using
only `z-ai/glm-5.3-flash`. One incoming mailbox Delta caused an actor-authored
message frontier, retained selection, and explicit outbound message with exact
reply lineage. The inference reached `stop`, the Sounding completed, and one
SIGINT exited gracefully. The final ledger contained no pending contact, failed
inference, or failed/uncertain invocation or delivery projection. The three
provider requests used `minimal` reasoning, 256 output tokens maximum each, zero
retries, and cost $0.00075142 in total; retained request metadata contained no
credential material.

The self-directed wake path also crossed the live provider boundary. A separate
fresh disposable subject received one mailbox Delta and used the retained
ordinary `schedule_wake` module to activate an exact ten-minute future wake.
The completed ledger bound it to the GLM Flash tool invocation, tool digest,
Sounding, staged time, due time, and subject-authored reason with no pending
contact, failure, or uncertainty. The two requests used `minimal` reasoning,
256 output tokens maximum each, zero retries, cost $0.00127575, and retained no
credential material.

Music is therefore ready to hatch a long-term resident under the stated
criterion: causal end-to-end continuity and direct lived observation, not an
evaluation campaign. Network messaging and richer contact surfaces can grow as
ordinary/adaptor machinery after hatch, in response to what the resident and
its world actually need.
