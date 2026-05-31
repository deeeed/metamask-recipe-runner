#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const [,, artifactsDirArg, manifestArg, platformArg] = process.argv;
if (!artifactsDirArg || !manifestArg || !platformArg) {
  console.error('Usage: validate-action-e2e-artifacts.mjs <artifacts-dir> <action-manifest.json> <mobile|extension>');
  process.exit(2);
}

const artifactsDir = path.resolve(artifactsDirArg);
const manifest = JSON.parse(await readFile(path.resolve(manifestArg), 'utf8'));
const trace = JSON.parse(await readFile(path.join(artifactsDir, 'trace.json'), 'utf8'));
const summary = JSON.parse(await readFile(path.join(artifactsDir, 'summary.json'), 'utf8'));
const events = traceEvents(trace);
const byAction = new Map();
for (const event of events) {
  if (!event || typeof event.action !== 'string') continue;
  const list = byAction.get(event.action) ?? [];
  list.push(event);
  byAction.set(event.action, list);
}

const required = [
  ...(manifest.supported_official_actions ?? []),
  ...(manifest.custom_actions ?? []).map((entry) => entry.name),
];
const liveRequired = new Set([
  'ui.navigate',
  'ui.press',
  'ui.scroll',
  'ui.wait_for',
  'ui.screenshot',
  'app.hud',
  'metamask.wallet.setup',
  'metamask.wallet.ensure_unlocked',
  'metamask.wallet.select_account',
  'metamask.wallet.read_state',
  'metamask.perps.read_positions',
  'metamask.perps.assert_positions',
  'metamask.perps.ensure_positions',
  'metamask.perps.place_order',
  'metamask.perps.close_positions',
  'metamask.perps.read_orders',
  'metamask.perps.assert_orders',
  'metamask.perps.ensure_orders',
  'metamask.perps.close_orders',
  'metamask.perps.start_state',
  'metamask.perps.teardown_state',
]);
const failures = [];

if (summary.status !== 'pass') failures.push(`summary.status is ${summary.status}, expected pass`);

for (const action of required) {
  const matches = byAction.get(action) ?? [];
  if (matches.length === 0) {
    failures.push(`manifest action not exercised: ${action}`);
    continue;
  }
  if (!matches.some((event) => event.ok === true)) failures.push(`action did not pass: ${action}`);
  for (const event of matches) {
    const output = event.output ?? {};
    if (output.semantic === true || output.source === 'static-smoke' || output.skipped === true) {
      failures.push(`action produced placeholder/skipped output: ${action} node=${event.nodeId}`);
    }
  }
}

for (const action of liveRequired) {
  if (!required.includes(action)) continue;
  const matches = byAction.get(action) ?? [];
  if (action.startsWith('ui.')) continue;
  if (action === 'app.hud') {
    if (!matches.some((event) => event.output?.hud === true)) {
      failures.push('app.hud did not report hud=true');
    }
    continue;
  }
  if (!matches.some((event) => typeof event.output?.liveAdapter === 'string' && event.output.liveAdapter.length > 0)) {
    failures.push(`live action lacks liveAdapter proof: ${action}`);
  }
}

const cdp = firstOutput('cdp.target');
if (cdp?.reachable !== true) failures.push('cdp.target did not prove reachable=true');
const fixture = firstOutput('metamask.wallet.fixture_status');
if (fixture?.status !== 'ready') failures.push('wallet fixture_status did not report ready');
const status = firstOutput('app.status');
if (status?.compatibilityMode === 'unsupported/no bridge') failures.push('app.status did not report a supported compatibility mode');
const readState = firstOutput('metamask.wallet.read_state');
if (platformArg === 'mobile' && !readState?.account?.address) failures.push('mobile wallet.read_state missing account.address');
if (platformArg === 'extension' && !readState?.state?.href) failures.push('extension wallet.read_state missing state.href');
const readPositions = firstOutput('metamask.perps.read_positions');
if (typeof readPositions?.matchingCount !== 'number') failures.push('perps.read_positions missing numeric matchingCount');
const placeOrder = firstOutput('metamask.perps.place_order');
if (placeOrder?.submitted !== true) failures.push('perps.place_order missing submitted=true proof');
const closePositions = firstOutput('metamask.perps.close_positions');
const closeProof = closePositions?.close ?? closePositions;
const closeResults = closeProof?.results ?? closeProof?.closeResult?.results;
if (closeProof?.closed !== true || !Array.isArray(closeResults)) {
  failures.push('perps.close_positions did not prove it executed a real close operation');
}
const closedAssertion = (byAction.get('metamask.perps.assert_positions') ?? [])
  .find((event) => event.ok === true && event.nodeId === 'assert-closed')?.output;
if (closedAssertion?.expectedOpen !== false || closedAssertion?.matchingCount !== 0) {
  failures.push('post-close assert_positions did not prove matchingCount=0');
}

for (const event of byAction.get('ui.screenshot') ?? []) {
  if (event.output?.captured !== true) failures.push(`ui.screenshot node ${event.nodeId} did not report captured=true`);
  if (typeof event.output?.path === 'string') {
    try { await access(path.join(artifactsDir, event.output.path)); }
    catch { failures.push(`ui.screenshot artifact missing on disk: ${event.output.path}`); }
  }
}

if (required.includes('ui.scroll')) {
  const scrollIntoView = (byAction.get('ui.scroll') ?? []).find((event) =>
    event.nodeId === 'ui-scroll-into-view' && event.ok === true && event.output?.intoView === true,
  );
  if (!scrollIntoView) {
    failures.push('ui.scroll did not prove the scroll_into_view variant through ui-scroll-into-view');
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: 'fail', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'pass', actionsValidated: required.length, platform: platformArg, artifactsDir }, null, 2));

function firstOutput(action) {
  return (byAction.get(action) ?? []).find((event) => event.ok === true)?.output ?? null;
}

function traceEvents(traceValue) {
  if (Array.isArray(traceValue)) return traceValue;
  if (Array.isArray(traceValue?.events)) return traceValue.events;
  return [];
}
