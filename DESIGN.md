# Music's first executable bones

## Shared contract

Music carries one durable subject across runtime encounters. A world Delta can
reach that subject through a Sounding; the subject can author a bounded change
to executable tool geometry; and a later Sounding and invocation must use the
changed geometry.

The current envelope is one trusted local Node.js process, one writer, one
ledger, AI SDK 7 text/tool inference, OpenRouter or a generic OpenAI-compatible
endpoint, and bounded `emit` effects. It does not yet claim concurrent writers,
real messaging or filesystem effects, autonomous scheduling, multimodal
provider equivalence, evaluator independence, or safe native-code/tool
installation.

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
  -> complete AI SDK response messages retained for a later Sounding
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

Provider compatibility is not collapsed into one nominally OpenAI-shaped path.
OpenRouter uses `@openrouter/ai-sdk-provider` 3 in explicit `strict` mode. Local
or otherwise generic OpenAI-compatible servers use
`@ai-sdk/openai-compatible`. The request boundary records bodies and non-secret
header names for diagnosis, while never retaining authorization values. Tests
exercise the dedicated provider's two-request tool-call protocol rather than
assuming API-shape compatibility from package names.

OpenRouter model metadata must declare the `tools` supported parameter before a
run begins. Generic OpenAI-compatible endpoints do not share a reliable metadata
contract, so their configuration must explicitly claim `capabilities.tools`;
unknown capability is treated as unavailable rather than optimistic support.

An `inference_started` event is durable before the provider call begins. If a
process disappears, the next runtime explicitly closes that orphan as a failed
inference, adds an interruption observation to retained history, and only then
opens another Sounding. It never silently rewinds a tool effect or leaves the
subject permanently locked in an inference that no longer exists.

## Next risk frontier

The provider loop, multi-step tool protocol, later-turn history, agent-authored
tool invention, and interrupted-step recovery are exercised against AI SDK's
real loop and provider serializers. No OpenRouter credential was available in
the implementation environment, so a live remote model response remains beyond
the evidence horizon.

The next structural frontier is external-effect commit: real message and file
adapters need prepare/commit/reconcile semantics so a durable invocation and an
external side effect cannot disagree after a crash. Scheduling and live Delta
steering then need one explicit ordering authority rather than a second agent
loop.
