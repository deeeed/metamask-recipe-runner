# Live Adapter Contract

The MetaMask runner implements Farmslot Recipe Protocol v1 (Farmslot `docs/RECIPE-PROTOCOL-V1.md`) through `@farmslot/recipe-harness`. Project-specific live behavior is supplied by manifest-declared action adapters.

Official `ui.*` semantics are implemented by Farmslot
`createStandardUiAdapters({ transport })` plus Farmslot CDP/React Native base
transports. The MetaMask runner supplies only tiny runtime bindings that point
those base transports at the Extension CDP page or Mobile React Native bridge.
MetaMask-specific actions remain separate manifest-declared live adapters.

For actions that must prove real product behavior, especially `metamask.perps.*`, static placeholders are refused by default. A live adapter script must exist in one of these locations. Domain-grouped paths are preferred so code ownership stays obvious:

```text
$METAMASK_RECIPE_LIVE_ADAPTER_DIR/<platform>/<domain>/<action-local-name>.mjs
$METAMASK_RECIPE_LIVE_ADAPTER_DIR/shared/<domain>/<action-local-name>.mjs
<runner>/live-adapters/<platform>/<domain>/<action-local-name>.mjs
<runner>/live-adapters/shared/<domain>/<action-local-name>.mjs
```

`.js` and `.sh` are also supported. Fully-qualified flat filenames are still searched after grouped paths, but new adapter code should use grouped modules. Do not add `ui.*` files here; official UI actions go through Farmslot base transports. Examples:

```text
live-adapters/extension/perps/ensure_positions.mjs
live-adapters/extension/perps/close_positions.mjs
live-adapters/extension/perps/close_orders.mjs
live-adapters/mobile/perps/place_order.mjs
live-adapters/mobile/wallet/ensure_unlocked.mjs
```

The runner invokes the script with one argument: a JSON input file path. The same path is also available as `METAMASK_RECIPE_ADAPTER_INPUT`. The script must write JSON to `outputPath` from the input document, or print JSON to stdout.

Input shape:

```json
{
  "schemaVersion": 1,
  "platform": "mobile|extension",
  "action": "metamask.perps.ensure_positions",
  "node": {},
  "context": {
    "nodeId": "ensure-clean",
    "projectRoot": "/path/to/product",
    "artifactsDir": "/path/to/artifacts"
  },
  "outputPath": "/tmp/.../output.json"
}
```

Output shape is action-specific, but must be redacted and suitable for `trace.json`. If the adapter captures evidence files, write them under `context.artifactsDir` and return relative artifact paths for the runner adapter to index in a follow-up implementation.

Proof rule: live adapters must drive real supported app/API paths. They must not write directly into UI state, DOM state, React/Redux/MobX state, local storage, controller internals, or any mid-recipe state that fabricates the proof condition.

## Controller/API calls vs visible UI proof

Recipe authors should choose the layer based on what must be proven:

| Need | Use | Rule |
|---|---|---|
| Fast reproducible setup/teardown before or after the proof window | `metamask.*` domain actions such as `start_state`, `ensure_positions`, `close_orders` | May use supported product/controller APIs, but must read/assert the final state. |
| Read-only state proof | `metamask.*.read_*` or `metamask.*.assert_*` | Must return redacted live state in trace output. |
| Human-visible acceptance criterion | official `ui.*` actions | Drive the actual visible path: press/tap, input/keypad, scroll into view, screenshot. Do not replace it with a controller call. |
| Ticket-specific visual detail | task-local recipe assertions/evidence | Do not add a reusable action only for one ticket. |

## Shared action-surface boundaries

The manifest is a durable capability contract, not a place to encode one
ticket's acceptance criteria. Do not add shared `metamask.*` actions for ticket
IDs, POCs, exact test IDs, exact copy, styling, placement, or other one-off UI
proof needs.

Use:

- official `ui.*` actions for reusable presence, input, scroll, and screenshot
  behavior;
- screenshot `claims` for visual, copy, and layout proof;
- task-local composed flows under the task artifact directory when a ticket
  needs a reusable helper for that ticket only;
- safe direct CDP/controller calls for read/assert or supported setup paths,
  never state fabrication.

Add or keep a shared action only when it represents a durable parameterized
domain capability useful across many tasks, such as `metamask.perps.start_state`,
`metamask.perps.place_order`, `metamask.perps.close_positions`, or
`metamask.perps.assert_positions`.

`ui.scroll` is part of the current executable contract and action-validation must
prove both normal scrolling and `scroll_into_view` before screenshot capture.
`ui.gesture` is intentionally not advertised yet; drag/swipe proof must wait
until Farmslot + this runner expose and validate that action on both platforms.



## Flow catalog follow-up

Action adapters fulfill one manifest-declared operation. Production recipes should also be able to call domain flow catalogs that compose these operations into idempotent `ensure_*` start states. These flows are owned by this runner/domain layer, not by Farmslot generic packages or skill glue.

For Perps, recipes should use the runner-provided `metamask.perps.start_state({ network, provider, page, market, positions, orders })` and `metamask.perps.teardown_state(...)` actions as the default reproducibility boundary. These actions compose primitive bulk operations such as `close_positions({ mode: "all" })` and `close_orders({ mode: "all" })` instead of multiplying one-off cleanup actions.

## Built-in Extension live adapters

The first Extension adapter set is bundled under `live-adapters/extension/` and talks directly to the Chrome extension page target over CDP. It does not execute a second recipe graph. The v1 runner still owns workflow traversal; each script only fulfills one manifest-declared action.

Runtime input:

```text
node.cdp_port | CDP_PORT | RECIPE_CDP_PORT
```

Optional autolaunch input for existing Extension builds:

```text
METAMASK_RECIPE_EXTENSION_AUTOLAUNCH=1
METAMASK_RECIPE_EXTENSION_LAUNCH_EXISTING_DIST=1
node.launch_existing_dist=true
```

When enabled, the adapter reuses the requested CDP port if a compatible extension target exists; otherwise it launches Chrome from the target checkout's existing `dist/chrome` without rebuilding the product. The runtime copy, profile, logs, and `runtime.json` are written under `context.artifactsDir/extension-runtime/`.

CLI equivalent:

```bash
metamask-recipe run <recipe.json> --adapter extension --cdp-port 6664 --launch-existing-dist --artifacts-dir <dir>
```

The CLI maps `--cdp-port` to `CDP_PORT`/`RECIPE_CDP_PORT` and maps `--launch-existing-dist` to `METAMASK_RECIPE_EXTENSION_AUTOLAUNCH=1` for the duration of the recipe run.

Currently implemented Extension actions:

```text
ui.navigate                  # extension: hash/path/url
metamask.perps.read_positions
metamask.perps.read_orders
metamask.perps.close_positions # primitive bulk close selected positions
metamask.perps.close_orders    # primitive bulk cancel selected orders
metamask.perps.place_order
metamask.perps.assert_positions
metamask.perps.assert_orders
metamask.perps.ensure_positions # high-level read/close/place/assert wrapper
metamask.perps.ensure_orders    # high-level read/cancel/assert wrapper
ui.press
ui.scroll
ui.wait_for
ui.screenshot
```

Navigation is intentionally raw transport, not a semantic shortcut. Use `ui.navigate` with the actual React Native route/params or extension hash/url the app exposes.

Task-specific UI styling checks, such as one ticket proving a banner color or placement, must not be implemented as reusable `metamask.perps.*` actions. Use official `ui.wait_for` for reusable presence/absence checks plus screenshot/task-local validation evidence for that ticket.

Read-only position checks use `stateHooks.submitRequestToBackground('perpsGetPositions', [{ skipCache: true }])`. State-changing actions prefer UI interaction through CDP mouse/keyboard events. Bulk cleanup primitives may call product background APIs such as `perpsClosePositions` or `perpsCancelOrders` when the UI control is unavailable; this is a supported app/API path, not direct state mutation. Adapters must not mutate Redux/React state, DOM state, local storage, or controller internals to fabricate proof.

## Built-in Mobile live adapters

The first Mobile adapter set is bundled under `live-adapters/mobile/` and delegates to the product-local React Native CDP bridge at `scripts/perps/agentic/cdp-bridge.js`. This intentionally uses only the bridge/helper layer from Mobile; the v1 runner remains the single recipe graph executor and Farmslot recipe protocol v1 remains the single recipe schema.

Runtime input:

```text
node.watcher_port | node.metro_port | node.cdp_port | WATCHER_PORT | CDP_PORT | RECIPE_CDP_PORT
node.simulator | node.ios_simulator | IOS_SIMULATOR
node.android_device | ANDROID_DEVICE
```

Currently implemented Mobile actions:

```text
ui.navigate                  # mobile: route/screen + params
metamask.perps.read_positions
metamask.perps.read_orders
metamask.perps.close_positions # primitive bulk close selected positions
metamask.perps.close_orders    # primitive bulk cancel selected orders
metamask.perps.place_order
metamask.perps.assert_positions
metamask.perps.assert_orders
metamask.perps.ensure_positions # high-level read/close/place/assert wrapper
metamask.perps.ensure_orders    # high-level read/cancel/assert wrapper
ui.press
ui.scroll
ui.wait_for
ui.screenshot
```

Navigation is intentionally raw transport, not a semantic shortcut. Use `ui.navigate` with the actual React Native route/params or extension hash/url the app exposes.

Read-only position checks use `Engine.context.PerpsController.getPositions()` through Hermes CDP. State-changing Perps actions use supported controller APIs (`placeOrder`, `closePositions`) through the same app bridge rather than mutating Redux/React/local storage. UI actions delegate to existing bridge capabilities such as `press-test-id` and `scroll-view`. Screenshot capture uses `xcrun simctl io <simulator> screenshot` for iOS simulator proof.
