# Music

**This is the song that never ends.**

Music is an experimental harness for one continuing agent identity. It retains
Watch-like Soundings and Deltas while allowing the agent's learning to become a
bounded, executable change in the tools and action geometry it encounters later.

The current repository is the first vertical skeleton, not a finished agent
runtime. It proves one causal path:

```text
world Delta -> Sounding -> agent-authored tool revision
            -> later Sounding -> changed executable action
```

State has one authority: a hash-linked append-only event ledger. The kernel
preserves subject identity, world/agent authorship, ancestry, activation bounds,
and exact invocation receipts. The agent—not a tool-local learner—decides what
a consequence means and what should change.

## Try it

Requires Node.js 22 or newer.

```sh
npm test
node src/cli.js init /tmp/music-events.jsonl Aster
node src/cli.js sound /tmp/music-events.jsonl manual
node src/cli.js audit /tmp/music-events.jsonl
```

The CLI also accepts `delta`, `revise`, and `invoke` commands. See
[`DESIGN.md`](./DESIGN.md) for the explicit capability envelope, causal map,
deliberate exclusions, and next risk frontier.
