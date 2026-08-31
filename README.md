# Music

**This is the song that never ends.**

Music is an experimental harness for one continuing agent identity. Its ordinary
tools are versioned executable JavaScript modules with the normal authority of
the Music Node.js process. File access, child processes, network access, native
modules, and arbitrary code are not sandboxed by the harness.

The stable bootstrap retains the subject and encounter loop, loads tool modules,
binds invocations to exact Soundings and module digests, and stages, activates,
or rolls back executable revisions. Recoverability comes from append-only
ancestry and deferred activation—not from limiting what ordinary tools can do.

A resident runtime watches a durable filesystem ingress. External adapters
atomically submit world-authored Delta files without writing the subject ledger;
the one resident runtime admits them, wakes an encounter, and archives each
arrival. A Delta arriving during inference is durably queued for a follow-up
Sounding.

The current causal path is:

```text
world Delta -> Sounding -> active carrier
            -> exact prior invocation reference
            -> actor-authored alternatives -> selected executable input
            -> unrestricted tool module -> retained invocation
            -> staged source revision -> changed later execution
            -> retained prior source -> rollback successor
```

Initial ordinary modules live in [`tools/`](./tools). `file_patch` performs a
real atomic textual replacement on any path visible to the process. `message`
and even `select_tool_action` are ordinary revisable modules.
`attend_consequence` lets the one mind defer or settle a consequence; deferred
consequences return in later Soundings. Their source is seed material for a new
subject; afterward, the ledger-retained active version is authoritative.

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
