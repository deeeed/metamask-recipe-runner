import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Deterministic runtime-readiness decision for the MetaMask Extension.
 *
 * WHY THIS EXISTS — the deterministic layer for agents.
 * AI agents repeatedly burned tokens flailing when the extension runtime was
 * not ready: a poisoned webpack cache (ENOENT on a deduped module) made every
 * rebuild fail; a stale dist rendered the home page but threw on Perps; a dead
 * browser left CDP empty. Each agent guessed a different recovery and often did
 * a full rebuild when a relaunch would do. This module replaces guessing with a
 * single, side-effect-free answer: given a checkout (and optionally a live CDP
 * port), it returns the ONE cheapest action that makes the runtime ready —
 * `install` < `build` (optionally `clean`) < `relaunch` < `ready` — plus the
 * machine-consumable `actions[]` a host runs. The host (farmslot preflight, the
 * recipe-harness skill, or a standalone run) executes; the runner only decides.
 *
 * This is the single source of truth for "what does the extension runtime need"
 * so the skill stops hand-rolling dist-freshness/build-health probes and the
 * three layers can no longer disagree on the same checkout.
 *
 * SIGNALS (pure file/git, plus an optional live CDP probe):
 *  - deps:         install markers present + content fingerprint vs recorded baseline
 *  - webpackCache: cache present + superset fingerprint vs recorded baseline (poisoning)
 *  - buildLog:     webpack watch log → ok | building | errors (incl. stale-cache ENOENT)
 *  - dist:         manifest git-id vs HEAD + uncommitted source → fresh | stale | unknown
 *  - cdp:          live extension health (ONLY when --cdp-port is passed)
 *
 * The deps/cache fingerprints use farmslot preflight's exact algorithm so the
 * runner is the reference spec a future preflight migration can defer to.
 * checkExtensionRuntimeHealth is imported LAZILY (it loads the farmslot harness
 * at module scope and FAILs without a live CDP) so the no-browser decision path
 * never touches it.
 */

export type ReadinessDecision =
  | 'install'
  | 'build'
  | 'relaunch'
  | 'ready'
  | 'blocked'
  | 'unknown';

export interface RuntimeDecisionAction {
  /** Stable id a host branches on, e.g. 'yarn-install', 'clear-webpack-cache'. */
  id: string;
  /** Argv to exec (host runs verbatim — never a shell string to re-parse). */
  argv?: string[];
  /** Working directory for argv. */
  cwd?: string;
  /** Filesystem paths (relative to target) a host should remove. */
  paths?: string[];
}

export interface RuntimeDecisionReport {
  schemaVersion: 1;
  adapter: 'extension';
  target: string;
  decision: ReadinessDecision;
  /** true only when the build must clear the webpack cache first. */
  clean: boolean;
  reasonCode: string;
  reasons: string[];
  checks: {
    deps: DepsCheck;
    webpackCache: WebpackCacheCheck;
    buildLog: BuildLogCheck;
    dist: DistCheck;
    cdp: CdpCheck;
  };
  actions: RuntimeDecisionAction[];
}

export interface RuntimeDecisionOptions {
  cdpPort?: number;
  /** Override the webpack watch-log path probed for build health. */
  watchLog?: string;
  /** Record the current deps/cache fingerprints as the new baseline and return. */
  record?: boolean;
}

interface DepsCheck {
  installed: boolean;
  status: 'current' | 'stale' | 'missing';
  hasBaseline: boolean;
}

interface WebpackCacheCheck {
  cachePresent: boolean;
  status: 'current' | 'stale' | 'no-cache';
  hasBaseline: boolean;
}

interface BuildLogCheck {
  status: 'ok' | 'building' | 'errors' | 'no-watch';
  reason?: 'stale-cache' | 'build-error';
  excerpt?: string;
}

interface DistCheck {
  status: 'fresh' | 'stale' | 'unknown' | 'no-build';
  distGitId?: string;
  head?: string;
  reason?: 'commit-mismatch' | 'uncommitted-source';
  modified?: string[];
}

interface CdpCheck {
  status: 'pass' | 'fail' | 'skipped';
  findings?: string[];
}

// ── fingerprint inputs (farmslot preflight parity) ────────────────────────────
const DEPS_INPUTS = ['package.json', 'yarn.lock', '.yarnrc.yml', '.tool-versions'];
const INSTALL_MARKERS = ['node_modules/.yarn-state.yml', '.yarn/install-state.gz'];
const WEBPACK_DIRECT_INPUTS = ['package.json', 'yarn.lock', '.yarnrc.yml', '.tool-versions'];
const WEBPACK_RECURSIVE_INPUTS = ['development/webpack'];
const WEBPACK_CACHE_DIR = 'node_modules/.cache/webpack';
const WATCH_LOG_CANDIDATES = ['temp/runtime/webpack.log', 'temp/runtime/recipe-harness-webpack.log'];

// ── git helpers ───────────────────────────────────────────────────────────────
function git(target: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', target, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function gitRaw(target: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', target, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

// ── content fingerprints (preflight algorithm) ───────────────────────────────
function addFile(hash: crypto.Hash, target: string, rel: string): void {
  const abs = path.join(target, rel);
  const stat = fs.statSync(abs);
  hash.update(rel);
  hash.update(String(stat.size));
  hash.update(fs.readFileSync(abs));
}

function walk(hash: crypto.Hash, target: string, relDir: string): void {
  const absDir = path.join(target, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const name of fs.readdirSync(absDir).sort()) {
    const rel = path.join(relDir, name);
    const stat = fs.statSync(path.join(target, rel));
    if (stat.isDirectory()) walk(hash, target, rel);
    else if (stat.isFile() && /\.(c?m?[jt]sx?|json)$/u.test(rel)) addFile(hash, target, rel);
  }
}

function depsFingerprint(target: string): string {
  const hash = crypto.createHash('sha256');
  for (const rel of DEPS_INPUTS) {
    if (!fs.existsSync(path.join(target, rel))) continue;
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(target, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Webpack-cache fingerprint — farmslot preflight parity: content hash of the
 * direct inputs + a recursive walk of development/webpack, pinned to gitHead.
 * Node binary/version are intentionally captured via .tool-versions content
 * (a direct input) rather than the runner's own process.version, because the
 * runner is not the build process and its Node may differ from the host's.
 */
function webpackFingerprint(target: string): { gitHead: string; fingerprint: string } {
  const hash = crypto.createHash('sha256');
  for (const rel of WEBPACK_DIRECT_INPUTS) {
    if (fs.existsSync(path.join(target, rel))) addFile(hash, target, rel);
  }
  for (const dir of WEBPACK_RECURSIVE_INPUTS) walk(hash, target, dir);
  return { gitHead: git(target, ['rev-parse', 'HEAD']) ?? 'unknown', fingerprint: hash.digest('hex') };
}

// ── per-checkout baseline store (machine-local; never written into the repo) ──
function stateDir(target: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(target)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'metamask-recipe-decision', key);
}

function readBaseline(target: string, name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(target), name), 'utf8'));
  } catch {
    return null;
  }
}

function writeBaseline(target: string, name: string, value: Record<string, unknown>): void {
  const dir = stateDir(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

// ── signal: dependency install state ─────────────────────────────────────────
function newestMtime(target: string, rels: string[]): number {
  let newest = 0;
  for (const rel of rels) {
    const abs = path.join(target, rel);
    if (fs.existsSync(abs)) newest = Math.max(newest, fs.statSync(abs).mtimeMs);
  }
  return newest;
}

function depsCheck(target: string): DepsCheck {
  const inputs = DEPS_INPUTS.filter((rel) => fs.existsSync(path.join(target, rel)));
  const installed = inputs.length > 0 && INSTALL_MARKERS.some((rel) => fs.existsSync(path.join(target, rel)));
  if (!installed) return { installed: false, status: 'missing', hasBaseline: false };
  const baseline = readBaseline(target, 'deps-state.json');
  if (!baseline) {
    // Cold start (no recorded baseline). Fall back to mtime: if a lock/manifest
    // input is newer than the install markers, deps drifted since the install.
    // Once `--record` writes a baseline, the precise content hash takes over.
    const drift = newestMtime(target, inputs) > newestMtime(target, INSTALL_MARKERS);
    return { installed: true, status: drift ? 'stale' : 'current', hasBaseline: false };
  }
  const status = baseline.fingerprint === depsFingerprint(target) ? 'current' : 'stale';
  return { installed: true, status, hasBaseline: true };
}

// ── signal: webpack cache (poisoning) ────────────────────────────────────────
function webpackCacheCheck(target: string): WebpackCacheCheck {
  const cachePresent = fs.existsSync(path.join(target, WEBPACK_CACHE_DIR));
  if (!cachePresent) return { cachePresent: false, status: 'no-cache', hasBaseline: false };
  const baseline = readBaseline(target, 'webpack-cache-state.json');
  if (!baseline) {
    // Cold start (no recorded baseline). Fall back to mtime: a cache poisoned by
    // a post-install dedup (ENOENT on a removed nested module) is older than the
    // install markers. This subsumes the skill's former inline mtime self-heal,
    // so the cache-clear decision lives in one place. `--record` then upgrades
    // this to the precise content fingerprint.
    const cacheMtime = fs.statSync(path.join(target, WEBPACK_CACHE_DIR)).mtimeMs;
    const poisoned = newestMtime(target, ['yarn.lock', ...INSTALL_MARKERS]) > cacheMtime;
    return { cachePresent: true, status: poisoned ? 'stale' : 'current', hasBaseline: false };
  }
  const current = webpackFingerprint(target);
  const status =
    baseline.fingerprint === current.fingerprint && baseline.gitHead === current.gitHead
      ? 'current'
      : 'stale';
  return { cachePresent: true, status, hasBaseline: true };
}

// ── signal: webpack watch-log health (port of skill build_health_json) ───────
function buildLogCheck(target: string, watchLog?: string): BuildLogCheck {
  const candidates = (
    watchLog
      ? [path.isAbsolute(watchLog) ? watchLog : path.join(target, watchLog)]
      : WATCH_LOG_CANDIDATES.map((rel) => path.join(target, rel))
  ).filter((file) => fs.existsSync(file));
  if (!candidates.length) return { status: 'no-watch' };
  const newestFirst = [...candidates].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const lines = fs.readFileSync(newestFirst[0], 'utf8').split('\n');
  const ERR = /Module build failed|^ERROR in |compiled with [1-9]\d* error/u;
  const OK = /compiled successfully|compiled with \d+ warning|MetaMask .* compiled|Bundle end: service worker|Bundle end:.*app-init/iu;
  let lastErr = -1;
  let lastOk = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (ERR.test(lines[i])) lastErr = i;
    if (OK.test(lines[i])) lastOk = i;
  }
  if (lastErr > lastOk) {
    const excerpt = lines.slice(lastErr, lastErr + 3).join(' | ').slice(0, 400);
    const staleCache = /ENOENT/u.test(excerpt) && /node_modules/u.test(excerpt);
    return { status: 'errors', reason: staleCache ? 'stale-cache' : 'build-error', excerpt };
  }
  if (lastOk >= 0) return { status: 'ok' };
  return { status: 'building' };
}

// Tracked source (ui/app/shared/development) changed since the build. -z gives
// NUL-separated unquoted paths; mtime is unreliable here (checkout/rsync rewrite it).
function uncommittedSource(target: string): string[] {
  const dirs = ['ui', 'app', 'shared', 'development'].filter((d) => fs.existsSync(path.join(target, d)));
  if (!dirs.length) return [];
  const SRC = /\.(ts|tsx|js|jsx|cjs|mjs|json|scss|css)$/iu;
  const records = gitRaw(target, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--', ...dirs])
    .split('\0')
    .filter(Boolean);
  const dirty: string[] = [];
  for (const record of records) {
    const file = /^.. /u.test(record) ? record.slice(3) : record;
    if (SRC.test(file)) dirty.push(file);
  }
  return dirty;
}

// ── signal: dist freshness (port of skill dist_freshness_json) ───────────────
function distCheck(target: string): DistCheck {
  const manifestPath = path.join(target, 'dist/chrome/manifest.json');
  if (!fs.existsSync(manifestPath)) return { status: 'no-build' };
  let manifest: { description?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { status: 'no-build' };
  }
  const description = typeof manifest.description === 'string' ? manifest.description : '';
  const match = /from git id:\s*([0-9a-f]{7,40})/iu.exec(description);
  const head = (git(target, ['rev-parse', 'HEAD']) ?? '').toLowerCase();
  const headShort = head ? head.slice(0, 8) : undefined;
  if (!match) return { status: 'unknown', head: headShort };
  const distGitId = match[1].toLowerCase();
  const distShort = distGitId.slice(0, 8);
  if (!head) return { status: 'unknown', distGitId: distShort };
  // startsWith compares on the stamped id's length (manifest stamps 8; format allows 7-40).
  if (!head.startsWith(distGitId)) {
    return { status: 'stale', reason: 'commit-mismatch', distGitId: distShort, head: headShort };
  }
  const dirty = uncommittedSource(target);
  if (dirty.length) {
    return { status: 'stale', reason: 'uncommitted-source', distGitId: distShort, head: headShort, modified: dirty.slice(0, 10) };
  }
  return { status: 'fresh', distGitId: distShort, head: headShort };
}

// ── signal: live CDP health (lazy — only when a port is given) ────────────────
async function cdpCheck(target: string, cdpPort?: number): Promise<CdpCheck> {
  if (!cdpPort) return { status: 'skipped' };
  try {
    // Lazy import: extension-runtime.ts loads the farmslot harness at module
    // scope, so it must never be pulled into the no-browser decision path.
    const { checkExtensionRuntimeHealth } = await import('./extension-runtime.ts');
    const report = await checkExtensionRuntimeHealth(target, cdpPort);
    return report.status === 'PASS'
      ? { status: 'pass' }
      : { status: 'fail', findings: report.findings };
  } catch (error) {
    return { status: 'fail', findings: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Snapshot current fingerprints as the new baseline (host calls after install/build). */
export function recordReadinessBaseline(target: string): void {
  writeBaseline(target, 'deps-state.json', { fingerprint: depsFingerprint(target) });
  const cache = webpackFingerprint(target);
  writeBaseline(target, 'webpack-cache-state.json', cache);
}

interface DecisionCore {
  decision: ReadinessDecision;
  clean?: boolean;
  reasonCode: string;
  reasons: string[];
  actions: RuntimeDecisionAction[];
}

/**
 * Compute the cheapest action that makes the extension runtime ready. Pure —
 * no process is started, no file in the repo is mutated (baselines live in the
 * OS temp dir). Exit/branch on `report.decision`; never re-parse webpack logs.
 */
export async function decideExtensionReadiness(
  target: string,
  options: RuntimeDecisionOptions = {},
): Promise<RuntimeDecisionReport> {
  const resolved = path.resolve(target);
  if (options.record) recordReadinessBaseline(resolved);

  const deps = depsCheck(resolved);
  const webpackCache = webpackCacheCheck(resolved);
  const buildLog = buildLogCheck(resolved, options.watchLog);
  const dist = distCheck(resolved);
  const cdp = await cdpCheck(resolved, options.cdpPort);
  const checks = { deps, webpackCache, buildLog, dist, cdp };

  const install: RuntimeDecisionAction[] = [{ id: 'yarn-install', argv: ['yarn', 'install', '--immutable'], cwd: resolved }];
  const relaunch: RuntimeDecisionAction[] = [{ id: 'relaunch-browser' }];
  const cacheStale = buildLog.reason === 'stale-cache';

  // Cheapest-first precedence as a flat table (not an if/else ladder): the first
  // matching rule wins, so exactly one action is ever advised.
  const rules: Array<{ when: boolean } & DecisionCore> = [
    { when: deps.status === 'missing', decision: 'install', reasonCode: 'deps-missing',
      reasons: ['Dependencies are not installed (no yarn install-state markers).'], actions: install },
    { when: deps.status === 'stale', decision: 'install', reasonCode: 'deps-stale',
      reasons: ['package.json/yarn.lock changed since the recorded install.'], actions: install },
    { when: buildLog.status === 'errors', decision: 'build', clean: cacheStale,
      reasonCode: cacheStale ? 'webpack-cache-stale' : 'build-errors',
      reasons: [cacheStale
        ? 'Webpack is failing on a poisoned cache (ENOENT on a deduped module).'
        : 'Webpack build has errors; fix the source/build before validating.',
        ...(buildLog.excerpt ? [buildLog.excerpt] : [])],
      actions: buildAction(resolved, cacheStale) },
    { when: webpackCache.status === 'stale', decision: 'build', clean: true, reasonCode: 'webpack-cache-stale',
      reasons: ['Webpack build inputs changed since the cache was recorded; clear cache and rebuild.'],
      actions: buildAction(resolved, true) },
    { when: dist.status === 'no-build', decision: 'build', reasonCode: 'dist-missing',
      reasons: ['No dist/chrome build present.'], actions: buildAction(resolved, false) },
    { when: dist.status === 'stale', decision: 'build', reasonCode: 'dist-stale',
      reasons: [dist.reason === 'uncommitted-source'
        ? `Uncommitted source since the build (${dist.modified?.length ?? 0} file(s)); rebuild.`
        : `dist git id ${dist.distGitId} != HEAD ${dist.head}; rebuild.`],
      actions: buildAction(resolved, false) },
    { when: cdp.status === 'pass', decision: 'ready', reasonCode: 'healthy',
      reasons: ['Build is fresh and the extension runtime is healthy over CDP.'], actions: [] },
    { when: cdp.status === 'fail', decision: 'relaunch', reasonCode: 'runtime-unhealthy',
      reasons: ['Build is fresh but the live extension is unhealthy; relaunch the browser.',
        ...(cdp.findings?.slice(0, 3) ?? [])], actions: relaunch },
  ];

  // Fallback: build looks ready but no --cdp-port was given, so liveness is unverified.
  const fallback: DecisionCore = {
    decision: 'relaunch', reasonCode: 'cdp-unknown',
    reasons: ['Build is fresh; browser liveness unverified (pass --cdp-port to confirm `ready`).'],
    actions: relaunch,
  };
  const core = rules.find((rule) => rule.when) ?? fallback;

  return {
    schemaVersion: 1, adapter: 'extension', target: resolved,
    decision: core.decision, clean: core.clean ?? false, reasonCode: core.reasonCode,
    reasons: core.reasons, checks, actions: core.actions,
  };
}

function buildAction(target: string, clean: boolean): RuntimeDecisionAction[] {
  const actions: RuntimeDecisionAction[] = [];
  if (clean) actions.push({ id: 'clear-webpack-cache', paths: [WEBPACK_CACHE_DIR] });
  actions.push({ id: 'start-webpack-watch', argv: ['yarn', 'start'], cwd: target });
  return actions;
}
