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
and bounded effects are intentionally revisable. Event format 3 intentionally
does not replay earlier ledgers because delivery, carrier, and activation changed
meaning.

The authorized embodiment depth is Node.js and local append-only files. No
database, service boundary, plugin process, or platform-specific native code is
introduced.

## Causal map

```text
world-authored Delta
  -> kernel admission and durable event
  -> durable Sounding offer (Delta remains pending)
  -> inference accepts the exact projection and acknowledges its Deltas
  -> active carrier supplies bounded current selection state
  -> subject authors a complete tool-owned candidate frontier
  -> selection receipt authorizes only the exact selected candidate
  -> invocation executes the manifest digest bound to that Sounding
  -> agent-authored tool revision is staged inside that inference
  -> agent-authored carrier transition preserves rule identity and evolves state
  -> successful inference completion atomically activates staged successors
  -> later Sounding projects the changed actions and carrier root
  -> durable observable emission receipt
  -> complete AI SDK messages remain audit history, not active context
```

The ledger is the only state authority. Current subject state, pending Deltas,
Sounding lifecycle, active carrier components, tool geometry, selections, and
emissions are replayed from it.
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

The active carrier is a bounded set of generic components, not a fixed ontology
of motif, pursuit, or personhood. Each component separates stable rule identity
from evolving state identity; the carrier root composes their current digests.
The subject may stage a state transition or invent another bounded component.
Only successful inference completion merges it, and only the successor appears
in later Soundings. Older states remain in ledger history without appearing in
the active projection.

Selection geometry belongs to a tool manifest. The initial message tool requires
one actor-authored candidate per available action. `select_tool_action` records
the exact frontier, active carrier root, projected tool digest, and selected ID.
Its receipt is single-use and authorizes only that selected action and input.
The selector does not generate candidates or decide which candidate wins.

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

Normal completed conversation is not replayed to later inference. The ledger
retains it for audit; only the current Sounding and bounded recovery protocol
from an immediately interrupted inference enter the next active prompt.

An `inference_started` event is durable before the provider call begins. If a
process disappears, the next runtime explicitly closes that orphan as a failed
inference, adds an interruption observation to retained history, and only then
opens another Sounding. It never silently rewinds a tool effect or leaves the
subject permanently locked in an inference that no longer exists.

## Next risk frontier

The provider loop, multi-step tool protocol, exact encounter lifecycle,
projection-bound invocation, deferred activation, active-carrier identity,
selected-only effect authorization, tool invention, and interrupted-step
recovery are exercised against AI SDK's real loop and provider serializers. A
paired fixture holds the tool geometry and actor-authored candidates exact while
carrier retention changes selection from `send` to `ask`; unselected and reused
receipts cannot emit. One earlier capped live OpenRouter request verified
authentication, exact model selection, request retention, and usage accounting;
live remote selection and carrier revision remain outside the evidence horizon.

The next structural frontier is correction lineage. Carrier and tool changes are
still promoted by successful inference completion rather than later world
consequence. A Delta must bind an exact selection/invocation receipt, make the
result active without replaying conversation, and support a later correction or
rollback whose changed selection can be tested against erasure. Real external
effect commit and scheduling remain downstream of that consequence boundary.
