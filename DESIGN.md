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

The event chain, subject identity, admitted world Deltas, exact Sounding
projections, projected tool bindings, staged and activated tool versions, and
invocation receipts are preserved exactly. Tool descriptions, actions, fields,
and bounded effects are intentionally revisable. Event format 2 intentionally
does not replay format-1 ledgers because delivery and activation changed meaning.

The authorized embodiment depth is Node.js and local append-only files. No
database, service boundary, plugin process, or platform-specific native code is
introduced.

## Causal map

```text
world-authored Delta
  -> kernel admission and durable event
  -> durable Sounding offer (Delta remains pending)
  -> inference accepts the exact projection and acknowledges its Deltas
  -> invocation executes the manifest digest bound to that Sounding
  -> agent-authored tool revision is staged inside that inference
  -> successful inference completion atomically activates the revision
  -> later Sounding projects the changed actions
  -> durable observable emission receipt
  -> complete AI SDK response messages retained for a later Sounding
```

The ledger is the only state authority. Current subject state, pending Deltas,
Sounding lifecycle, active tool geometry, and emissions are replayed from it.
The kernel decides admission, acknowledgement, projection binding, ancestry,
activation, and bounded execution; it does not decide what a consequence means
or what the subject should learn.

## Why this shape

A process per tool would introduce identity, synchronization, deployment, and
failure boundaries before any demonstrated need. A central learned-policy layer
over fixed tools would preserve two behavior authorities and allow a lesson to
remain advisory. Here, the ledger retains the full executable manifest
corresponding to each projected digest. An invocation uses that exact binding
even if the subject has staged later geometry; only a completed encounter can
activate the staged successor for a later Sounding.

Opening a Sounding constructs an offer; it is not delivery. The kernel permits
only one offered or active Sounding at a time. `inference_started` binds the
stored projection digest, acknowledges exactly its Delta IDs, and supplies the
only context in which agent tool invocation or revision is authorized. The CLI
cannot label standalone actions as agent-authored.

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

The provider loop, multi-step tool protocol, exact encounter lifecycle,
projection-bound invocation, deferred activation, later-turn history,
agent-authored tool invention, and interrupted-step recovery are exercised
against AI SDK's real loop and provider serializers. One capped live OpenRouter
request verified authentication, exact model selection, request retention, and
usage accounting; it did not exercise a live remote tool round-trip.

The next structural frontier is the bounded active carrier. Complete provider
history is still replayed indefinitely, so completed imperatives, current
consequence, protocol history, and audit-only material have no authoritative
active/inert distinction. Full history should remain in the ledger while a
digest-bound, subject-owned and eventually revisable compiler determines the
bounded position presented to later inference. External-effect commit and
scheduling remain deliberately downstream of that identity boundary.
