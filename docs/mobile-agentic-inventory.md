# Mobile scripts/perps/agentic Inventory

PR2 invariant: Farmslot recipe protocol v1 is the single recipe schema and `@farmslot/recipe-harness` is the single graph executor. Product-local Mobile files may remain only as bridge code, product hooks, or tiny wrappers delegating to the v1 overlay.

| Path | Current role | PR2 owner decision |
|---|---|---|
| `scripts/perps/agentic/lib/registry.js` | Action registry for product-local harness | deleted/replaced by v1 manifest + runner adapters |
| `scripts/perps/agentic/lib/workflow.js` | Product-local graph executor | deleted/replaced by `@farmslot/recipe-harness` |
| `scripts/perps/agentic/schemas/flow.schema.json` | Product-local flow schema | deleted/replaced by Farmslot recipe protocol v1 |
| `scripts/perps/agentic/validate-flow-schema.js` | Product-local schema validator | deleted/replaced by Farmslot manifest/recipe validation |
| `scripts/perps/agentic/validate-recipe.js` | Product-local recipe validator | wrapper only if needed; delegate to v1 validation |
| `scripts/perps/agentic/lib/catalog.js` | Action catalog | replaced by action manifest descriptions/examples |
| `scripts/perps/agentic/lib/assert.js` | Assertion helpers | migrate into runner adapters or base harness actions |
| `scripts/perps/agentic/lib/cdp-eval.js` | RN/debug eval helper | bridge/helper only; no graph execution ownership |
| `scripts/perps/agentic/lib/app-lifecycle.js` | App lifecycle helper | runner adapter helper |
| `scripts/perps/agentic/lib/target-discovery.js` | RN/CDP target discovery | runner adapter helper |
| `scripts/perps/agentic/lib/ws-client.js` | RN/CDP websocket client | runner adapter helper |
| `app/core/AgenticService/` | In-app bridge/HUD | bridge/product hook, injectable when safe |
| `app/core/NavigationService/NavigationService.ts` | Bridge install point | bridge/product hook, backup/restore required |
| `app/components/Nav/App/App.tsx` | HUD mount point | bridge/product hook, backup/restore required |

## v1 runner live-adapter mapping

The runner now provides Mobile live adapters under grouped `live-adapters/mobile/{platform,ui,wallet,perps}/` modules. These adapters call the existing Mobile CDP bridge as a transport/helper only; they do not call `validate-recipe.js`, `lib/workflow.js`, `lib/registry.js`, or the product-local schema validator.

| v1 action | Product bridge/API used | Notes |
|---|---|---|
| `ui.navigate` with raw route/hash values for Perps/home | `cdp-bridge.js navigate PerpsHomeView` | Raw navigation transport only; the agent supplies route/hash params and graph execution remains in Farmslot v1. |
| `ui.navigate` with raw route/hash values for a market | `cdp-bridge.js navigate PerpsMarketDetails` | Passes raw React Navigation params such as `{ market: { symbol } }`, or the matching extension hash. |
| `metamask.perps.read_positions` | `Engine.context.PerpsController.getPositions()` | Read-only live position proof with selector params. |
| `metamask.perps.read_orders` | `Engine.context.PerpsController.getOpenOrders()` | Read-only live order proof with selector params. |
| `metamask.perps.assert_positions` | `getPositions()` polling | Read-only assertion over the selected position set. |
| `metamask.perps.close_positions` | `PerpsController.closePositions({ symbols })` | Primitive bulk close over selected positions. |
| `metamask.perps.close_orders` | `PerpsController.cancelOrders({ symbols })` | Primitive bulk cancel over selected orders. |
| `metamask.perps.ensure_positions`, `metamask.perps.ensure_orders` | compose read/close/place/assert primitives | Higher-level idempotent wrappers; not separate one-off cases. |
| `metamask.perps.place_order` | `PerpsController.placeOrder(...)` | Supported product API path; no Redux/DOM/local-storage mutation. |
| `ui.press`, `ui.scroll`, `ui.wait_for` | Farmslot `createStandardUiAdapters({ transport })` -> Farmslot React Native base transport -> Mobile bridge commands (`press-test-id`, `scroll-view`, fiber/eval wait) | Official action semantics live in Farmslot; Mobile only supplies runtime bridge binding. |
| `ui.screenshot` | `xcrun simctl io <simulator> screenshot` on iOS; `adb exec-out screencap -p` on Android | Real simulator/device screenshot artifact. |

Task-specific visual styling proof does not belong in `metamask.perps.*`; use `ui.wait_for` for reusable testID/text presence and attach screenshots or task-local validation artifacts for ticket-specific color/order claims.

Remaining product-local files can stay in the Mobile PR as bridge/dev utilities during migration, but recipe graph execution must enter through `.agent/recipe-harness/mobile/runner/bin/metamask-recipe` for PR2 proof.
