# Music

**This is the song that never ends.**

Music is an experimental harness for one continuing agent identity. It retains
Watch-like Soundings and Deltas while allowing the agent's learning to become a
bounded, executable change in the tools and action geometry it encounters later.

The current repository contains the first provider-connected vertical skeleton.
It proves this causal path:

```text
world Delta -> Sounding -> agent-authored tool revision
            -> later Sounding -> changed executable action
```

State has one authority: a hash-linked append-only event ledger. The kernel
preserves subject identity, authority provenance, exact Sounding lifecycle,
projection and tool bindings, ancestry, activation bounds, and invocation
receipts. The agent—not a tool-local learner—decides what a consequence means
and what should change.

Inference uses AI SDK 7. OpenRouter uses its dedicated AI SDK provider in
explicit strict-compatibility mode; generic and local OpenAI-compatible servers
use `@ai-sdk/openai-compatible` separately. Complete response messages and
completed step checkpoints are retained so tool-call/result protocol survives
later Soundings and provider interruption. OpenRouter runs also verify the
selected model currently declares tool support before opening a Sounding;
generic compatible servers require an explicit `capabilities.tools` claim.

Opening a Sounding reserves its Deltas but does not consume them. Beginning an
inference durably accepts that exact projection. Tool calls execute the manifest
digest projected into that Sounding, and revisions remain staged until successful
inference completion makes them available to a later Sounding.

## Try it

Requires Node.js 22 or newer.

```sh
npm test
node src/cli.js init /tmp/music-events.jsonl Aster
node src/cli.js sound /tmp/music-events.jsonl manual
node src/cli.js audit /tmp/music-events.jsonl
```

To run a real inference through OpenRouter:

```sh
set -a
source /Users/chad/.config/music/openrouter.env
set +a
node src/cli.js run /tmp/music-events.jsonl examples/openrouter.model.json manual
```

The example is deliberately locked down for inexpensive smoke testing: it uses
`z-ai/glm-5.3-flash`, permits one model step, caps generation at 32 tokens, and
disables retries. Those three inference limits are explicit configuration, and
the completed inference receipt records the actual model request and token use.
The CLI accepts `delta`, `sound`, `run`, and `audit` after initialization.
Invocation and revision are agent-authority behavior and exist only inside an
active inference; the CLI cannot self-assert them. See
[`DESIGN.md`](./DESIGN.md) for the explicit capability envelope, causal map,
deliberate exclusions, and next risk frontier.
