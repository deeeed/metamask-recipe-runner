import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Single source of truth for "which extension id is this MetaMask build".
 *
 * WHY THIS EXISTS. The id was resolved in three different, drifting places —
 * farmslot `launch-browser.sh` (Playwright candidate loop), `reopen-browser.sh`
 * (`serviceWorkers()[0]`, which grabs Chrome's *component* extensions and broke
 * recovery), and the harness CDP target selector. They disagreed. This module
 * makes the runner the one resolver both farmslot launchers defer to.
 *
 * The id is **deterministic**: Chrome derives an unpacked extension's id from
 * the `key` in its manifest (base64-decode → sha256 → first 16 bytes → each
 * nibble mapped to a-p). Since the browser is launched with `--load-extension`
 * pointing at exactly this dist, the computed id IS the loaded extension's id —
 * no service-worker/page guessing, robust even when the MV3 worker is idle.
 *
 * `--cdp-port` (optional) only *verifies* the computed id is actually present in
 * the running browser; it never changes the answer.
 */

export interface ResolveExtensionResult {
  adapter: 'extension';
  target: string;
  extensionId: string | null;
  source: 'manifest-key' | 'cdp-target' | 'none';
  verified: boolean | null;
}

const DIST_MANIFEST = 'dist/chrome/manifest.json';

/** Chrome's unpacked-extension id derivation from a manifest `key` (base64 DER). */
export function extensionIdFromKey(keyBase64: string): string {
  const der = Buffer.from(keyBase64, 'base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0xf));
  }
  return id;
}

function idFromDistManifest(target: string): string | null {
  const manifestPath = path.join(target, DIST_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { key?: unknown };
    return typeof manifest.key === 'string' && manifest.key.length > 0
      ? extensionIdFromKey(manifest.key)
      : null;
  } catch {
    return null;
  }
}

/** chrome-extension ids visible to CDP (page targets + service workers). */
async function cdpExtensionIds(cdpPort: number): Promise<string[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const targets = (await res.json()) as Array<{ url?: string }>;
    const ids = new Set<string>();
    for (const t of targets) {
      const m = /^chrome-extension:\/\/([^/]+)/u.exec(String(t.url ?? ''));
      if (m) ids.add(m[1]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

/**
 * Resolve the MetaMask extension id for a checkout. Pure file/crypto by default;
 * `--cdp-port` adds a presence check (and a fallback when the dist has no `key`).
 */
export async function resolveExtensionId(
  target: string,
  options: { cdpPort?: number } = {},
): Promise<ResolveExtensionResult> {
  const resolved = path.resolve(target);
  const fromKey = idFromDistManifest(resolved);
  let cdpIds: string[] | null = null;
  if (options.cdpPort) cdpIds = await cdpExtensionIds(options.cdpPort);

  if (fromKey) {
    return {
      adapter: 'extension',
      target: resolved,
      extensionId: fromKey,
      source: 'manifest-key',
      verified: cdpIds ? cdpIds.includes(fromKey) : null,
    };
  }
  // No `key` in the dist manifest (rare). Fall back to a live CDP id if exactly
  // one extension is loaded; otherwise we cannot disambiguate deterministically.
  if (cdpIds && cdpIds.length === 1) {
    return { adapter: 'extension', target: resolved, extensionId: cdpIds[0], source: 'cdp-target', verified: true };
  }
  return { adapter: 'extension', target: resolved, extensionId: null, source: 'none', verified: cdpIds ? false : null };
}
