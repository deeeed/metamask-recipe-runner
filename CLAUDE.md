# MetaMask Recipe Runner — Agent Instructions

This repo implements MetaMask domain support for Farmslot Recipe Protocol v1.

Canonical protocol source of truth:

- Farmslot `docs/RECIPE-PROTOCOL-V1.md`
- Architecture decision: Farmslot `docs/adr/034-recipe-protocol-v1.md`

Consume Farmslot through installed `@farmslot/*` packages by default. Use `FARMSLOT_ROOT`, `.farmslot-root`, or a sibling checkout only as an explicit local-development override. Never hardcode a developer-specific absolute path.

## Hard rules

1. **Do not redefine Recipe Protocol v1 here.** This repo may document MetaMask-specific examples and adapter details, but field names, graph semantics, trace shape, artifact manifest shape, validation rules, and action/flow manifest rules come from the canonical Farmslot spec.
2. **Parameterize before multiplying.** Prefer one typed action/flow over duplicate positive/negative, route-specific, provider-specific, or market-specific variants.
   - Prefer `assert_positions({ state, market, side?, notional? })` over separate `assert_position` / `assert_no_position` families.
   - Prefer `ensure_position({ state, market, side?, notional? })` over `ensure_position({ state: "none" })` + `ensure_long_position` + `ensure_short_position` families.
   - Prefer `navigate({ page, market?, side? })` over one action per destination.
3. **Shared Mobile/Extension interface.** Wallet and Perps capabilities should use the same parameterized interface across Mobile and Extension when possible. If one platform lacks support, document it as `unsupported`/`planned` in a capability profile; do not invent a different vocabulary or advertise an unimplemented action as supported.
4. **Flow catalogs stay small.** Add a new `metamask.*` flow only when it represents a new reusable domain concept. Presets should usually be docs/examples or thin aliases, not catalog growth.
5. **Every `ensure_*` flow must prove a postcondition.** It may inspect current state and do only required transitions, but success must be machine-checkable in trace/output.
6. **No proof fabrication.** Never mutate DOM, React/Redux/MobX state, local storage, controller internals, or app state during proof to manufacture a result. Setup-time fixture seeding before proof is allowed when trace makes it explicit.
7. **Farmslot owns generic mechanics.** Generic `ui.*`, CDP/RN transports, graph execution, trace, summary, artifact manifest, and protocol validation belong in Farmslot packages, not duplicated in this runner.
8. **Skills stay thin.** `metamask-skills` should resolve/install/invoke this runner; it must not contain a second runner, copied harness, task-specific recipes, or graph executor.
9. **Task recipes stay task-local.** Do not commit TAT-specific or one-off proof recipes into the reusable runner catalog unless they are converted into reusable domain examples.
10. **Fail explicitly.** Do not swallow adapter errors or return success from placeholders. Unsupported or unvalidated actions/flows should be absent from manifests/catalogs.
11. **Shared actions are durable capabilities, not task checklists.** Never add ticket/ADR/POC/debug-specific action names, default test IDs, exact copy, styling, or placement assertions to shared manifests or live adapters. Use official `ui.*` actions, screenshot claims, task-local flows/artifacts, or safe direct read/controller calls instead. Keep `metamask.*` for parameterized domain operations useful across many tasks.

## Review checklist

Before claiming a runner change is ready:

- Does every manifest/catalog addition follow `RECIPE-PROTOCOL-V1.md`?
- Could an existing parameterized action/flow cover this instead of a new name?
- Is every `metamask.*` addition a durable domain capability rather than one task's acceptance criteria?
- Does every new `ensure_*` flow have typed params and a postcondition?
- Does every proof-capable flow produce trace/evidence that proves the claim without setup noise?
- Are generic capabilities left in Farmslot instead of reimplemented here?
- Are action-validation and at least one real Mobile/Extension proof updated when behavior changes?
