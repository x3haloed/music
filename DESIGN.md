# Music's first executable bones

## Shared contract

Music carries one durable subject across runtime encounters. A world Delta can
reach that subject through a Sounding; the subject can author a bounded change
to executable tool geometry; and a later Sounding and invocation must use the
changed geometry.

The first envelope is one trusted local Node.js process, one writer, one ledger,
and bounded `emit` effects. It does not yet claim concurrent writers, inference
provider integration, real messaging or filesystem effects, autonomous
scheduling, evaluator independence, or safe native-code/tool installation.

The event chain, subject identity, admitted world Deltas, Soundings, activated
tool versions, and invocation receipts are preserved exactly. Tool descriptions,
actions, fields, and bounded effects are intentionally revisable.

The authorized embodiment depth is Node.js and local append-only files. No
database, service boundary, plugin process, or platform-specific native code is
introduced.

## Causal map

```text
world-authored Delta
  -> kernel admission and durable event
  -> Sounding projection to the one subject
  -> agent-authored, head-bound tool revision
  -> kernel validation and durable activation
  -> later Sounding projects the changed actions
  -> invocation executes that exact tool version
  -> durable observable emission receipt
```

The ledger is the only state authority. Current subject state, pending Deltas,
active tool geometry, and emissions are replayed from it. The kernel decides
admission, ancestry, activation, and bounded execution; it does not decide what
a consequence means or what the subject should learn.

## Why this shape

A process per tool would introduce identity, synchronization, deployment, and
failure boundaries before any demonstrated need. A central learned-policy layer
over fixed tools would preserve two behavior authorities and allow a lesson to
remain advisory. Here, an activated manifest is both what later Soundings expose
and what invocation executes.

Tool invention is present in a deliberately narrow form: the subject may add a
new named tool and actions using the existing bounded `emit` primitive. This
proves that the action vocabulary can grow without claiming that arbitrary new
machine authority is safe.

## Next risk frontier

The least-proven boundary is model inference: demonstrating that one continuing
subject can interpret a real Delta, author a useful revision, and later act
through it without splitting authority between prompts, provider sessions, and
the retained self. After that, external-effect adapters need prepare/commit
semantics so a durable invocation and a real side effect cannot disagree after
a crash.
