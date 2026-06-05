# Perps Flow Catalog

MetaMask Perps recipes use a small set of parameterized primitives plus higher-level `ensure_*` wrappers. Do not add one action per scenario. A new Perps capability should first try to extend selector params or flow params.

## Layers

| Layer | Examples | Responsibility |
|---|---|---|
| Read primitives | `metamask.perps.read_positions`, `metamask.perps.read_orders` | Return redacted live state for a selected subset. |
| Bulk mutation primitives | `metamask.perps.close_positions`, `metamask.perps.close_orders`, `metamask.perps.place_order` | Perform one real product operation over a parameterized selection. |
| Assertion wrappers | `metamask.perps.assert_positions`, `metamask.perps.assert_orders` | Read live state and fail when selected state does not match expectation. |
| Ensure wrappers | `metamask.perps.ensure_positions`, `metamask.perps.ensure_orders` | Compose read/mutate/assert to create idempotent start states. |
| Domain setup/teardown | `metamask.perps.start_state`, `metamask.perps.teardown_state` | Compose wallet/provider/network/page/position/order setup before a proof window. |

## Selection contract

Position/order operations accept the same selector shape:

```json
{
  "action": "metamask.perps.close_positions",
  "mode": "matching",
  "markets": ["BTC", "ETH"],
  "side": "long",
  "timeout_ms": 30000
}
```

- `mode: "matching"` selects `market`/`symbol` or `markets`/`symbols`.
- `mode: "all"` selects every live position/order returned by the product.
- `side` narrows selection when the product returns side information.
- `selector` can carry the same fields when a nested shape is easier for flow composition.

## Examples

Close every live Perps position before a proof window:

```json
{ "action": "metamask.perps.close_positions", "mode": "all" }
```

Cancel only BTC open orders:

```json
{ "action": "metamask.perps.close_orders", "market": "BTC" }
```

Higher-level clean start state:

```json
{
  "action": "metamask.perps.ensure_positions",
  "state": "none",
  "mode": "all"
}
```

Provider/network setup belongs in a configurable start-state contract such as `metamask.perps.start_state`, not in duplicate primitive actions:

```json
{
  "flow": "metamask.perps.start_state",
  "params": {
    "provider": "hyperliquid",
    "network": "testnet",
    "page": "market",
    "market": "BTC",
    "positions": { "state": "none", "mode": "all" },
    "orders": { "state": "none", "mode": "all" }
  }
}
```

## Position update operations

Perps needs more than open/close. When TP/SL, margin, or leverage update coverage is added, prefer one parameterized position-update primitive instead of one adapter file per feature. The primitive should accept a position selector, a small set of update operations, and explicit assertions over the resulting position/order state.

That future primitive should compose controller-backed product APIs when that is the supported app path. It must not mutate React/Redux/MobX/DOM/local storage directly.

## Direct controller usage

When a recipe genuinely needs direct controller access and there is no reusable UI-equivalent flow, the agent should call the product controller directly through the platform bridge/CDP capability documented for that project.

The runner should help by documenting discoverable controller capabilities, not by hiding them behind another action vocabulary. For each direct controller capability, document:

- controller/API path;
- supported params;
- whether it changes state;
- required preconditions;
- expected postcondition assertion;
- redaction rules for trace output.

Example documentation shape:

```json
{
  "capability": "PerpsController.setTpSl",
  "access": "direct-controller",
  "params": {
    "market": "BTC",
    "takeProfit": { "price": "72000" },
    "stopLoss": { "price": "65000" }
  },
  "postcondition": {
    "action": "metamask.perps.assert_orders",
    "market": "BTC",
    "state": "present"
  }
}
```

State-changing direct controller calls must still be followed by a read/assert step or by an `ensure_*` wrapper that proves the final state.

## Limiting live-adapter file count

Perps should converge to one domain dispatcher per platform, not one new file for every controller operation. The runner can still expose many manifest actions, but implementation should route through a small domain module:

```text
live-adapters/mobile/perps/perps.mjs       # shared Mobile Perps operation catalog
live-adapters/extension/perps/perps.mjs    # shared Extension Perps operation catalog
```

Runner resolution supports a domain dispatcher fallback such as `live-adapters/<platform>/perps/perps.mjs` when an action-specific file is absent. That keeps discoverability in the manifest while avoiding a growing pile of tiny wrapper files.

## Rule of thumb for adding adapter files

Add a named adapter/flow when it represents a reusable product workflow that normally has a UI path and would otherwise waste proof-video time on repetitive setup. Examples: unlock wallet, navigate to Perps, ensure provider/network, open a market, create a baseline position, close selected positions, cancel selected orders, or prepare an order form.

Do not add a new adapter file only because a controller exposes another method. For direct controller operations, document the real controller capability and params so the agent can call the product API directly when appropriate.

| Need | Preferred shape | Why |
|---|---|---|
| Faster setup for a visual proof with a matching UI/user workflow | named flow or semantic adapter, e.g. `ensure_positions`, `close_positions` | Keeps proof videos focused while still using supported app/API paths. |
| Direct product capability with many variants | documented direct controller capability + required postcondition | Avoids one file per controller method and avoids a useless wrapper vocabulary. |
| Ticket-specific visual claim | task-local recipe assertion/evidence | Avoids polluting the domain API with one-off checks. |
| Repeated domain baseline across teams | catalog flow such as `start_state` | Creates a stable starting contract for many recipes. |

Direct controller capabilities must still be discoverable in docs/manifest metadata. The metadata should describe the real controller/API path, required params, examples, postconditions, and whether the operation is state-changing. The agent should be able to infer valid direct calls without reverse-engineering app internals first.

## Preconditions vs prestate

Existing Mobile recipes use pre-conditions such as `wallet.unlocked`, `perps.feature_enabled`, `perps.ready_to_trade`, `perps.sufficient_balance`, `perps.open_position`, `perps.open_position_tpsl`, `perps.open_limit_order`, `perps.not_in_watchlist`, and `perps.trading_flag`.

Recipe v1 should keep the same concept, but split it into two different responsibilities:

| Concept | Mutates state? | Purpose | Examples |
|---|---:|---|---|
| `preconditions` / `requires` | No | Fast fail with actionable reason when the target cannot support the recipe. | `wallet.unlocked`, `perps.feature_enabled`, `perps.trading_flag` |
| `prestate` / `startState` | Yes, when needed | Converge the app to a configurable baseline before the proof window. | unlock, select account, choose network/provider, close positions/orders, open market |

A precondition should not repair state. It answers “is this environment eligible?” A prestate answers “make the environment look like this before the proof starts.”

## Recommended Perps base prestate

Most Perps recipes should inherit from a configurable base prestate instead of repeating setup inline:

```json
{
  "flow": "metamask.perps.start_state",
  "params": {
    "wallet": { "state": "unlocked", "account": "default" },
    "featureFlags": { "perps": true, "trading": true },
    "provider": "hyperliquid",
    "network": "testnet",
    "readyToTrade": true,
    "balance": { "minWithdrawableUsd": "1" },
    "page": "market",
    "market": "BTC",
    "positions": { "state": "none", "mode": "matching", "markets": ["BTC"] },
    "orders": { "state": "none", "mode": "matching", "markets": ["BTC"] },
    "hud": { "enabled": true, "proofSafe": true }
  }
}
```

This flow should compose smaller actions/flows:

1. `metamask.wallet.ensure_unlocked`
2. `metamask.wallet.select_account` when requested
3. provider/network/testnet setup for Hyperliquid or another provider
4. read-only gates for feature/trading readiness
5. `metamask.perps.ensure_orders` for order baseline
6. `metamask.perps.ensure_positions` for position baseline
7. `ui.navigate` with a manifest-discoverable `page` alias, or raw route/hash fallback
8. `app.hud` when visual proof should show context and it will not obscure the claim

## Base prestate profiles

The runner should publish named profiles as examples, but keep them parameterized:

| Profile | Intended use | Default params |
|---|---|---|
| `perps.clean_market_testnet` | Most visual AC proofs from a clean market screen | Hyperliquid testnet, wallet unlocked, ready to trade, selected market, no selected positions/orders |
| `perps.open_position_testnet` | TP/SL, margin, close-position proofs | Hyperliquid testnet, selected market, one open position, optional side/notional/leverage |
| `perps.open_order_testnet` | Limit-order edit/cancel proofs | Hyperliquid testnet, selected market, one open order |
| `perps.provider_mainnet_readonly` | Read-only balance/provider proofs | Hyperliquid mainnet, no cleanup mutation unless explicitly requested |

Profiles are shortcuts, not separate hardcoded actions. A recipe should be able to override provider, network, market, account, positions, orders, balance, page, and HUD behavior.

## Recipe v1 shape

Recommended shape for a proof recipe:

```json
{
  "preconditions": [
    "wallet.unlocked",
    "perps.feature_enabled",
    "perps.trading_flag"
  ],
  "startState": {
    "action": "metamask.perps.start_state",
    "intent": "Converge Perps to a clean BTC testnet baseline before proof",
    "params": {
      "profile": "perps.clean_market_testnet",
      "market": "BTC",
      "positions": { "state": "none", "market": "BTC" },
      "orders": { "state": "none", "market": "BTC" }
    },
    "record": "trace_only"
  },
  "proof": {
    "nodes": {
      "ac-specific-step": {
        "action": "ui.press",
        "intent": "Perform the AC-specific Perps interaction through the UI",
        "test_id": "example",
        "record": "proof_window"
      }
    }
  }
}
```

The prestate runs before the proof window and remains visible in `trace.json`/`summary.json`; the proof window only records the AC-specific behavior. This preserves review speed without hiding setup from the agent or reviewer.
