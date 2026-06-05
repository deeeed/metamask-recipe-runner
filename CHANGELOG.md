# Changelog

## Unreleased

- Prepare pilot npm distribution as `@deeeed/metamask-recipe-runner`; intended to migrate to org ownership if ADR-58 is accepted.
- Add `mm-recipe` and `mme-recipe` human-friendly wrappers for Mobile and Extension recipe control.
- Keep `metamask-recipe` as the single package bin; `mm-recipe` and `mme-recipe` are repo/local convenience wrappers.
- Improve Extension Perps order placement by resolving market price from background market data, stream cache, or visible UI before submitting.
