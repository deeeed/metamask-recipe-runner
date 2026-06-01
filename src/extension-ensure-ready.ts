import path from 'node:path';

import { resolveExtensionId } from './extension-id.ts';

/**
 * "Drive the extension to a ready state" — the single source of truth for the
 * open-home + collapse-to-one-tab + verify-healthy logic that farmslot's
 * launch-browser.sh and reopen-browser.sh (and preflight's post-freeze reopen)
 * each hand-rolled. They left duplicate home tabs, which trips
 * runtime-health's "exactly one home page" contract and makes agents see a
 * broken-looking runtime.
 *
 * Guarantees, given a live CDP port:
 *  - the extension id is resolved deterministically (resolveExtensionId),
 *  - exactly ONE chrome-extension home.html page target is open (opened if none,
 *    extras closed if several),
 *  - the runtime is verified healthy (checkExtensionRuntimeHealth).
 *
 * Pure-ish: it only opens/closes tabs to converge on the single-tab invariant;
 * it does not rebuild or relaunch. Unlocking the wallet remains with the host
 * launcher for now (a future increment can fold ensure_unlocked in here too).
 */

export interface EnsureReadyResult {
  schemaVersion: 1;
  adapter: 'extension';
  target: string;
  cdpPort: number;
  extensionId: string | null;
  opened: boolean;
  homeTabs: { before: number; closed: number; after: number };
  ready: boolean;
  reasonCode: string;
  health: { status: 'PASS' | 'FAIL' | 'unknown'; findings: string[] };
}

interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonList(port: number): Promise<CdpTarget[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const value = await res.json();
    return Array.isArray(value) ? (value as CdpTarget[]) : [];
  } catch {
    return [];
  }
}

async function closeTab(port: number, id: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(4000) });
  } catch {
    // best-effort; a tab that won't close is surfaced by the final health check
  }
}

async function openHome(port: number, extensionId: string): Promise<boolean> {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/home.html`)}`;
  try {
    let res = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(8000) });
    if (res.status === 404 || res.status === 405) res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

function homePages(targets: CdpTarget[], extensionId: string): CdpTarget[] {
  const prefix = `chrome-extension://${extensionId}`;
  return targets.filter(
    (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(prefix) && t.url.includes('/home.html') && t.id,
  );
}

export async function ensureExtensionReady(
  target: string,
  options: { cdpPort: number },
): Promise<EnsureReadyResult> {
  const resolved = path.resolve(target);
  const { cdpPort } = options;
  const base = (extra: Partial<EnsureReadyResult>): EnsureReadyResult => ({
    schemaVersion: 1,
    adapter: 'extension',
    target: resolved,
    cdpPort,
    extensionId: null,
    opened: false,
    homeTabs: { before: 0, closed: 0, after: 0 },
    ready: false,
    reasonCode: 'unknown',
    health: { status: 'unknown', findings: [] },
    ...extra,
  });

  const { extensionId } = await resolveExtensionId(resolved, { cdpPort });
  if (!extensionId) return base({ reasonCode: 'no-extension-id' });

  const homes = homePages(await jsonList(cdpPort), extensionId);
  const before = homes.length;

  // Converge on exactly one home tab.
  //  - 0 tabs  → open one.
  //  - 1 tab   → keep it (cheap; the health check below validates it).
  //  - >1 tabs → close ALL and open one fresh. /json/list alone can't tell a
  //    healthy tab from a chrome-error one (a crashed page still lists its
  //    intended url), so keeping the first could discard the good tab and keep a
  //    broken one. A fresh tab is deterministically clean.
  let opened = false;
  let closed = 0;
  if (homes.length > 1) {
    for (const h of homes) {
      await closeTab(cdpPort, String(h.id));
      closed += 1;
    }
    await sleep(500);
    opened = await openHome(cdpPort, extensionId);
    await sleep(1500);
  } else if (homes.length === 0) {
    opened = await openHome(cdpPort, extensionId);
    await sleep(1500);
  }

  const after = homePages(await jsonList(cdpPort), extensionId).length;

  // Verify with the single health source. Lazy import: extension-runtime.ts
  // loads the farmslot harness at module scope, so it must not be pulled into
  // any no-CDP path.
  let health: EnsureReadyResult['health'] = { status: 'unknown', findings: [] };
  try {
    const { checkExtensionRuntimeHealth } = await import('./extension-runtime.ts');
    const report = await checkExtensionRuntimeHealth(resolved, cdpPort);
    health = { status: report.status, findings: report.findings };
  } catch (error) {
    health = { status: 'FAIL', findings: [error instanceof Error ? error.message : String(error)] };
  }

  const ready = health.status === 'PASS' && after === 1;
  return base({
    extensionId,
    opened,
    homeTabs: { before, closed, after },
    ready,
    reasonCode: ready ? 'ready' : after !== 1 ? 'tab-count' : 'unhealthy',
    health,
  });
}
