# Extension runtime commands

The single source of truth for resolving / deciding / verifying the MetaMask
**extension** runtime. Both the recipe-harness skill and farmslot defer to these
commands — do not re-implement extension-id resolution, build/cache decisions, or
"is it ready" checks anywhere else.

All commands take `--adapter extension --target <repo>`; pass `--json` for machine
output. Run via the installed wrapper (`<harness>/extension/runner/bin/metamask-recipe`)
or this repo's `bin/metamask-recipe`.

## `resolve-extension`

```
metamask-recipe resolve-extension --adapter extension --target <repo> [--cdp-port <port>] [--json]
```

Returns this build's extension id, derived **deterministically** from the loaded
dist's manifest `key` (Chrome's unpacked-id algorithm) — never from
`serviceWorkers()[0]` (which can return a Chrome component extension). Non-JSON
prints the bare id for `$(...)` capture. `--cdp-port` only adds `verified` (is the
id present in the live browser); it never changes the answer.

`{ extensionId, source: 'manifest-key'|'cdp-target'|'none', verified }`

## `runtime-decision`

```
metamask-recipe runtime-decision --adapter extension --target <repo> [--cdp-port <port>] [--watch-log <path>] [--record] [--json]
```

The deterministic "what does the runtime need next" answer. **Branch on `.decision`,
never re-parse webpack logs.** Cheapest-first precedence:

`install` (deps missing/stale) → `build` (`clean:true` if webpack cache poisoned or
build errored; else dist missing/stale/source-dirty) → `relaunch` (build fresh, CDP
down or unhealthy) → `ready` (CDP healthy). Without `--cdp-port` the highest answer is
`relaunch` (liveness unverified).

Signals: deps install-state, webpack-cache fingerprint (farmslot preflight's exact
algorithm: content hash of package.json/yarn.lock/.yarnrc.yml/.tool-versions +
`development/webpack` walk + gitHead; cold-start mtime fallback), build-log health,
dist git-id freshness, live CDP health. `--record` snapshots the deps/cache baseline
after a confirmed-good build (run it post-install/post-build so staleness detection is
precise next time). Exit 0 whenever advice was computed.

`{ decision, clean, reasonCode, reasons[], checks{deps,webpackCache,buildLog,dist,cdp}, actions[] }`

## `ensure-ready`

```
metamask-recipe ensure-ready --adapter extension --target <repo> --cdp-port <port> [--json]
```

Drives the live browser to exactly **one healthy** `home.html` tab (opens one if none,
closes extras) and verifies via `runtime-health`. This is the single source for the
"one home tab + healthy" invariant that `runtime-health` requires — use it after any
launch/reopen instead of hand-closing tabs. Exit 0 when ready.

`{ extensionId, opened, homeTabs:{before,closed,after}, ready, reasonCode, health }`

## `runtime-health`

```
metamask-recipe runtime-health --adapter extension --target <repo> --cdp-port <port> [--json]
```

Read-only liveness probe of the running extension (exactly one home page + background
reachable). Does not open/close tabs. `PASS`/`FAIL`.

## The deterministic loop (autonomous agents)

Slots run **`watch=off`** (no background watcher), so the agent rebuilds explicitly:

```
edit source → runtime-decision (→ build) → one-shot rebuild → ensure-ready → ready
```

The host runs the rebuild (farmslot: `refresh-build.sh`; standalone: a one-shot
`yarn start`-then-stop). The runner only decides and verifies.
