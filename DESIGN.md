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
does not yet claim concurrent writers, transactional rollback of arbitrary
external effects, autonomous scheduling, live messaging transport, dependency
installation recovery, or survival when the bootstrap itself is corrupted.

Event format 6 intentionally rejects earlier ledgers because unresolved
consequence state, staged dispositions, and the initial consequence-attention
tool are now part of subject continuity.

## Stable boundary

The bootstrap currently owns only the irreducible continuity and mutation path:

- one subject, event chain, and exact Sounding lifecycle;
- inference-provider connection and interrupted-turn recovery;
- loading and invoking a retained JavaScript tool body;
- exact projection/digest binding plus durable invocation start, completion, and
  failure boundaries;
- `inspect_tool`, `revise_tool`, and `rollback_tool`;
- carrier mutation and parent-bound activation mechanics;
- staged consequence deferral and settlement mechanics;
- the receipt primitive used by selection modules.

The JavaScript loader is not a capability filter. A tool body receives `input`
and an encounter context, but it can also use normal globals and dynamically
import any Node or installed package available to the process.

Everything projected as an ordinary tool is revisable. The initial modules live
under [`tools/`](./tools):

- `file_patch` performs a real atomic exact-text replacement on any visible
  path;
- `message` currently produces a local outbound record;
- `select_tool_action` invokes the stable receipt primitive, but its interface,
  sequencing, and executable source are themselves ordinary revisable geometry;
- `attend_consequence` invokes the staged consequence-transition primitive, but
  its interface, policy, and sequencing remain ordinary revisable geometry.

These files seed a new subject only. Once initialized, the ledger-retained tool
version is authoritative. The bootstrap does not re-read seed source to replace
an active learned version.

## Causal map

```text
world-authored Delta
  -> durable Sounding offer
  -> inference accepts its exact projection and acknowledges its Deltas
  -> subject encounters current carrier and ordinary-tool digests/interfaces
  -> inspect_tool retrieves exact projected source when needed
  -> ordinary module executes with unrestricted Node authority
  -> invocation input, output, tool digest, and encounter binding are retained
  -> later world Delta cites the exact invocation without interpreting it
  -> current Sounding delivers that consequence reference and observation
  -> the subject may defer it; unresolved consequence returns in later Soundings
  -> revise_tool stages a complete replacement interface and source body
  -> the subject may explicitly settle the consequence
  -> successful inference completion atomically promotes the staged successor
  -> later Sounding projects the successor digest and interface
  -> later invocation runs the changed source
  -> rollback_tool can copy retained prior source into a new parent-bound version
```

Tool source is omitted from the default Sounding projection to avoid replaying
every implementation into every prompt. `inspect_tool` returns the exact source
bound to that encounter, so modification is informed rather than blind.

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

## Provider boundary

OpenRouter uses `@openrouter/ai-sdk-provider` in explicit strict mode. Generic
OpenAI-compatible endpoints use `@ai-sdk/openai-compatible` separately.
OpenRouter preflight requires declared tool support. Request receipts retain the
model, body, and non-secret header names without authorization values. Tests run
Music's full current tool schemas through the dedicated serializer.

## Resident world ingress

The resident runtime owns one durable filesystem ingress and remains the sole
ledger writer. Producers use atomic rename into `pending/`; they report complete
world-authored Deltas but do not construct Soundings or interpret observations.
The resident validates and admits each Delta, archives accepted and rejected
files separately, and treats a repeated already-admitted Delta id as recovery
from the append-before-archive crash window rather than duplicate contact.

An admitted waking Delta triggers a Sounding when the resident is idle. Arrival
during an active inference is still durably admitted and triggers the next
Sounding after that inference closes. Periodic heartbeats also reopen contact,
which makes explicitly deferred consequences revisitable without new input.

## Evidence and next risk frontier

Automated evidence currently proves that:

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
- a second Delta arriving while inference is active is admitted without overlap
  and automatically wakes the next Sounding;
- invented invocation references and consequence claims from outside the current
  Sounding are rejected, while uncertain effects remain uncertainty rather than
  being reclassified by the kernel;
- OpenRouter strict serialization accepts the complete executable-tool surface.

The next risk frontier is live steering and real communication. Music now has a
generic durable adapter boundary and follow-up wake sequencing, but it does not
yet inject a waking Delta into an inference already in progress; same-Sounding
steering must preserve the encounter's exact projection and staged-change
authority. Generic non-consequence Deltas also need an interruption policy so a
failed first encounter cannot make important contact disappear from the active
surface. The local `message` tool remains an emission record rather than a real
transport. Beyond those edges, ordinary tools still need a learned dependency
and module-installation story capable of recovering when newly installed code
breaks the next encounter.
