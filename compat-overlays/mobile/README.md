# Mobile historical compatibility overlays

These patch files document temporary source overlays used by Recipe v1 historical
injection evals when an older MetaMask Mobile checkout cannot boot under the
current local Xcode/Hermes toolchain.

They are intentionally kept in the external runner repository, not Farmslot root
scripts, so a `/recipe-harness` skill can apply the same reversible overlay before
a historical rebuild and record the overlay path in validation evidence.

- `rn81-message-event-source.patch`: adds a read-only `MessageEvent.prototype.source`
  getter for React Native 0.81 historical checkouts whose bundled polyfill omits
  it while CDP websocket clients expect browser-compatible `MessageEvent` shape.
