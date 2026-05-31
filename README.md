# MetaMask Recipe Runner

MetaMask-specific runner package for Farmslot Recipe Protocol v1. Canonical protocol spec: Farmslot `docs/RECIPE-PROTOCOL-V1.md` (resolved through `FARMSLOT_ROOT`, `.farmslot-root`, installed `@farmslot/*` packages, or a sibling Farmslot checkout).

This project owns the MetaMask action catalog, manifests, and live adapters for
MetaMask Mobile and Extension recipe validation. It intentionally stays outside
`metamask-skills`: skills are thin UX wrappers that resolve this project, install
it into `.agent/recipe-harness/<adapter>/runner/`, and call `bin/metamask-recipe`.

## Boundary

The shared action surface is a durable capability contract, not a checklist of
one ticket's acceptance criteria. Add `metamask.*` actions only for
parameterized product/domain operations that will be reused across many recipes,
such as navigation, start-state convergence, read/assert state, placing orders,
closing selected positions, or cancelling selected orders.

Do not add shared actions for ticket IDs, POCs, exact test IDs, one-off copy,
banner/style/placement assertions, or other task-local proof details. For those
cases, keep the recipe small and use:

- official `ui.*` actions for visible user interaction and presence checks;
- screenshot `claims` and artifacts for visual/copy/layout proof;
- task-local composed flows in the task artifact when a helper is useful only
  for that task;
- safe direct read/controller calls for setup or assertions when the visible UI
  path is not the acceptance criterion.

## HUD intent contract

The Recipe v1 HUD is the agent-to-human communication channel during live runs and proof recordings. It must be easy to understand at a glance:

- `intent` says what the agent is trying to do now, e.g. `Open a small ETH long position`.
- Do not use `intent` for action names, domains, node ids, selectors, test ids, or generic labels like `ui`, `wallet`, `perps`, `setup`, or `run`.
- The default HUD shows one line: status/progress plus the current intent.
- A second intent is allowed only for composed subflows via explicit `sub_intent`/`subIntent` and `display.showSubflow: true`.
- `detail` is optional trace/review metadata and is hidden from the default HUD. Use `display.showDetail: true` only when a project deliberately wants that extra line.
- Node id, action name, proof target, and flow/domain are trace/debug metadata and require `display.showDebug: true` to be visible.

## Proof interaction contract

The action manifest is the executable contract. A Recipe Protocol v1 official action
is callable only when this runner advertises it in
`supported_official_actions`; unsupported official actions stay absent until they
are implemented and proven on both Mobile and Extension.

Use the smallest layer that proves the claim:

- Use `metamask.*` domain actions for setup, teardown, idempotent start state,
  read/assert checks, and supported product/controller API operations where the
  visual path would add repetitive setup noise.
- Use official `ui.*` actions for the interaction window that must be visible in
  human proof: pressing buttons, entering input, keypad taps, scrolling an item
  into view, screenshots, and future drag/swipe gestures.
- Never use direct controller/CDP calls to fake a user-visible acceptance
  criterion. If the claim is “the UI lets a user do X”, the proof recipe must
  drive X through `ui.*` and then assert/capture the result.
- `ui.gesture` is not in the MetaMask manifests yet. Drag/swipe recipes must wait
  until the runner exposes it and action-validation proves it on Mobile and
  Extension.

The current action-validation recipes exercise every manifest-declared action and
specifically include both generic `ui.scroll` and the `scroll_into_view` variant
before screenshot proof.

- Farmslot owns the protocol schema, graph execution, trace/summary/artifact
  package writing, and generic `ui.*`/CDP/React Native transports.
- This runner owns MetaMask project semantics: `metamask.wallet.*`,
  `metamask.perps.*`, action manifests, and platform live-adapter bindings.
- Skills own user-facing install/verify/cook/doctor flows only.

## Required environment

Set `FARMSLOT_ROOT` when running directly unless `.farmslot-root` was written by
`/recipe-harness install`:

```bash
FARMSLOT_ROOT=/path/to/farmslot bin/metamask-recipe manifest --adapter mobile --json
```

Skills discover this runner through `METAMASK_RECIPE_RUNNER_SOURCE` or a sibling
checkout named `metamask-recipe-runner` next to `metamask-skills`.

## Commands

```bash
bin/metamask-recipe manifest --adapter mobile --json
bin/metamask-recipe manifest --adapter extension --json
bin/metamask-recipe doctor --adapter mobile --target /path/to/metamask-mobile --json
bin/metamask-recipe run recipes/smoke.mobile.recipe.json --adapter mobile --target /path/to/metamask-mobile --artifacts-dir /tmp/mm-smoke --json
bin/metamask-recipe self-test --artifacts-dir /tmp/metamask-runner-self-test --json
```

## Local editor setup

This repo imports the real Farmslot package names (`@farmslot/protocol` and
`@farmslot/recipe-harness`). Do not commit relative `../../farmslot` TypeScript
paths or local type shims. For local Cursor/TypeScript server resolution before
those packages are installed from a registry, create untracked symlinks:

```bash
FARMSLOT_ROOT=/path/to/farmslot npm run setup:local-types
```

The check script also resolves Farmslot through `FARMSLOT_ROOT` or a sibling
checkout and writes only an ignored `.tmp/tsconfig.check.json`.


## Recipe quality follow-up: composed start states

The current runner proves v1 action execution. Recipe v1 should not be treated as production-complete until the runner also publishes reusable flow catalogs for setup/start-state composition. The intended model is:

```text
metamask.wallet.ensure_unlocked
metamask.perps.close_positions({ mode: "all" })
metamask.perps.close_orders({ mode: "all" })
metamask.perps.ensure_positions({ state: "none", mode: "all" })
metamask.perps.ensure_orders({ state: "none", mode: "all" })
metamask.perps.start_state({ network, provider, page, market, positions, orders })
```

`close_positions` and `close_orders` are primitive bulk operations: selector params decide whether they close one market, several markets, or everything returned by the product. `ensure_*` flows are idempotent convergence wrappers: inspect current state, call the primitive operations only when needed, prove postconditions, and fail if the requested baseline cannot be reached. For Perps, `start_state` should own starting page, mainnet/testnet, provider selection such as Hyperliquid, optional selected market, and optional position/order preconditions. See `docs/perps-flow-catalog.md`.

Proof recipes should then record only the AC-specific interaction while setup remains visible in `trace.json`/`summary.json`.

## Validation

```bash
npm run check
FARMSLOT_ROOT=/path/to/farmslot npm run self-test
```

For proof-capable actions, run the action-validation recipes on live Mobile and
Extension targets, then validate the output:

```bash
node scripts/validate-action-e2e-artifacts.mjs <artifacts-dir> manifests/mobile.action-manifest.json mobile
node scripts/validate-action-e2e-artifacts.mjs <artifacts-dir> manifests/extension.action-manifest.json extension
```

## TypeScript package surface

The public runner surface is TypeScript (`src/*.ts`) and exports typed factory, manifest, and doctor contracts from `src/index.ts`. The executable wrapper still invokes Farmslot's `tsx` so installed runners work on Node versions that do not execute `.ts` files directly. Live adapters remain small `.mjs` scripts because they are copied into target checkouts and executed as standalone Node programs.
