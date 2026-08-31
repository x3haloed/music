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
preserves subject identity, world/agent authorship, ancestry, activation bounds,
and exact invocation receipts. The agent—not a tool-local learner—decides what
a consequence means and what should change.

Inference uses AI SDK 7. OpenRouter uses its dedicated AI SDK provider in
explicit strict-compatibility mode; generic and local OpenAI-compatible servers
use `@ai-sdk/openai-compatible` separately. Complete response messages and
completed step checkpoints are retained so tool-call/result protocol survives
later Soundings and provider interruption. OpenRouter runs also verify the
selected model currently declares tool support before opening a Sounding;
generic compatible servers require an explicit `capabilities.tools` claim.

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
export OPENROUTER_API_KEY=...
node src/cli.js run /tmp/music-events.jsonl examples/openrouter.model.json delta
```

Choose a tool-capable model appropriate to the deployment; the example model is
only a replaceable configuration value. The CLI also accepts `delta`, `revise`,
and `invoke` commands. See
[`DESIGN.md`](./DESIGN.md) for the explicit capability envelope, causal map,
deliberate exclusions, and next risk frontier.
