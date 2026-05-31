import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { importFarmslotHarness, resolveLocalFarmslotRoot, resolveRequiredLocalFarmslotRoot, runnerDir } from './paths.ts';

// Runtime health uses package dependencies. Launching a canonical Farmslot browser
// remains a dev-only path because it needs pool/project scripts from a checkout.
const { CdpSession, extensionIdFromTarget, jsonGet, sleep } = await importFarmslotHarness();

export interface ExtensionRuntimeOptions {
  projectRoot: string;
  cdpPort?: string | number;
  slot?: string;
  launchExistingDist?: boolean;
  validationRuntimeDir?: string;
  healthTimeoutMs?: number;
}

export interface ExtensionRuntimeLaunchResult {
  launched: boolean;
  slotId?: string;
  cdpPort: number;
  runtimeDir?: string;
  stdout?: string;
}

export interface ExtensionRuntimeHealthReport {
  status: 'PASS' | 'FAIL';
  cdpPort: number;
  targetUrl?: string;
  extensionId?: string;
  extensionPageTargets: number;
  findings: string[];
  details: Record<string, unknown>;
}

interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export async function prepareExtensionRuntime(
  options: ExtensionRuntimeOptions,
): Promise<{ launch: ExtensionRuntimeLaunchResult | null; health: ExtensionRuntimeHealthReport }> {
  const projectRoot = path.resolve(options.projectRoot);
  const slot = resolveExtensionSlot(projectRoot, options.slot);
  const cdpPort = resolveCdpPort(options.cdpPort, slot);
  let launch: ExtensionRuntimeLaunchResult | null = null;
  if (options.launchExistingDist) {
    if (!slot) {
      throw new Error(
        `Cannot launch canonical Extension runtime for ${projectRoot}: no Farmslot slot maps to this repo. ` +
          'Pass --slot <slot-id> or add the checkout to pool/*.json.',
      );
    }
    launch = await launchFarmslotValidationBrowser({
      projectRoot,
      cdpPort,
      slotId: slot.id,
      validationRuntimeDir:
        options.validationRuntimeDir ?? `temp/.recipe-validation-${cdpPort}`,
    });
  }
  const health = await assertHealthyExtensionRuntime({
    projectRoot,
    cdpPort,
    timeoutMs: options.healthTimeoutMs,
  });
  return { launch, health };
}

export async function assertHealthyExtensionRuntime(options: {
  projectRoot: string;
  cdpPort: number;
  timeoutMs?: number;
}): Promise<ExtensionRuntimeHealthReport> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastReport: ExtensionRuntimeHealthReport | null = null;
  while (Date.now() <= deadline) {
    lastReport = await checkExtensionRuntimeHealth(options.projectRoot, options.cdpPort);
    if (lastReport.status === 'PASS') return lastReport;
    await sleep(500);
  }
  const report = lastReport ?? failReport(options.cdpPort, ['CDP runtime was not probed.'], {});
  throw new Error(formatHealthFailure(report, options.projectRoot));
}

export async function checkExtensionRuntimeHealth(
  projectRoot: string,
  cdpPort: number,
): Promise<ExtensionRuntimeHealthReport> {
  const findings: string[] = [];
  let targets: CdpTarget[] = [];
  try {
    await jsonGet(`http://127.0.0.1:${cdpPort}/json/version`);
    const rawTargets = await jsonGet(`http://127.0.0.1:${cdpPort}/json/list`);
    targets = Array.isArray(rawTargets) ? rawTargets as CdpTarget[] : [];
  } catch (error) {
    return failReport(cdpPort, [`CDP is not reachable on port ${cdpPort}: ${messageOf(error)}`], {});
  }

  const extensionTargets = targets.filter((target) =>
    target.type === 'page' &&
    String(target.url ?? '').startsWith('chrome-extension://') &&
    String(target.url ?? '').includes('/home.html') &&
    Boolean(target.webSocketDebuggerUrl),
  );
  if (extensionTargets.length !== 1) {
    findings.push(`Expected exactly one MetaMask extension home page target, found ${extensionTargets.length}.`);
  }
  const target = extensionTargets[0];
  if (!target?.webSocketDebuggerUrl) {
    return failReport(cdpPort, findings, {
      targetUrls: targets.map((entry) => entry.url).filter(Boolean),
    });
  }
  if (String(target.url ?? '').startsWith('chrome-error://')) {
    findings.push(`Extension target resolved to chrome-error page: ${target.url}`);
  }

  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    await session.call('Runtime.enable');
    await session.call('Page.enable');
    const runtime = await evaluateHealth(session);
    if (runtime.href && !String(runtime.href).startsWith('chrome-extension://')) {
      findings.push(`Extension page href is not an extension URL: ${runtime.href}`);
    }
    if (runtime.backgroundUnresponsive === true) {
      findings.push('Extension UI reports background connection unresponsive.');
    }
    if (runtime.hasSubmitRequest !== true) {
      findings.push('stateHooks.submitRequestToBackground is unavailable.');
    }
    if (runtime.hasStore !== true) {
      findings.push('stateHooks.store is unavailable.');
    }
    if (runtime.hasPerpsStreamManager !== true) {
      findings.push('stateHooks.getPerpsStreamManager is unavailable.');
    }
    if (runtime.backgroundProbeOk !== true) {
      findings.push(`Perps background read probe failed: ${runtime.backgroundProbeError ?? 'unknown error'}.`);
    }
    const extensionId = safeExtensionId(target);
    return {
      status: findings.length === 0 ? 'PASS' : 'FAIL',
      cdpPort,
      targetUrl: target.url,
      extensionId,
      extensionPageTargets: extensionTargets.length,
      findings,
      details: {
        projectRoot,
        targetUrls: targets.map((entry) => entry.url).filter(Boolean),
        runtime,
      },
    };
  } finally {
    session.close();
  }
}

function failReport(
  cdpPort: number,
  findings: string[],
  details: Record<string, unknown>,
): ExtensionRuntimeHealthReport {
  return {
    status: 'FAIL',
    cdpPort,
    extensionPageTargets: 0,
    findings,
    details,
  };
}

async function evaluateHealth(session: any): Promise<Record<string, unknown>> {
  const result = await session.call('Runtime.evaluate', {
    expression: `(() => {
      const hooks = globalThis.stateHooks || {};
      const bodyText = document.body?.innerText || '';
      const storeState = hooks.store?.getState?.() || {};
      const manager = hooks.getPerpsStreamManager?.();
      const accountCache = manager?.account?.cache;
      return Promise.race([
        (async () => {
          let backgroundProbeOk = false;
          let backgroundProbeError = null;
          if (typeof hooks.submitRequestToBackground === 'function') {
            try {
              const accountState = await hooks.submitRequestToBackground('perpsGetAccountState', []);
              backgroundProbeOk = Boolean(accountState && typeof accountState === 'object');
              if (!backgroundProbeOk) backgroundProbeError = 'perpsGetAccountState returned an empty result';
            } catch (error) {
              backgroundProbeError = String(error?.message || error);
            }
          } else {
            backgroundProbeError = 'submitRequestToBackground is not a function';
          }
          return {
            href: location.href,
            title: document.title,
            hookKeys: Object.keys(hooks),
            hasSubmitRequest: typeof hooks.submitRequestToBackground === 'function',
            hasStore: Boolean(hooks.store),
            hasPerpsStreamManager: typeof hooks.getPerpsStreamManager === 'function',
            backgroundUnresponsive: bodyText.includes('Background connection unresponsive') || bodyText.includes('MetaMask had trouble starting'),
            activeProvider: storeState.metamask?.activeProvider || null,
            isTestnet: Boolean(storeState.metamask?.isTestnet),
            perpsManagerInitialized: Boolean(manager?.isInitialized?.()),
            positionsCacheIsArray: Array.isArray(manager?.positions?.cache),
            ordersCacheIsArray: Array.isArray(manager?.orders?.cache),
            accountCachePresent: Boolean(accountCache && typeof accountCache === 'object'),
            backgroundProbeOk,
            backgroundProbeError,
          };
        })(),
        new Promise((resolve) => setTimeout(() => resolve({
          href: location.href,
          title: document.title,
          hookKeys: Object.keys(hooks),
          hasSubmitRequest: typeof hooks.submitRequestToBackground === 'function',
          hasStore: Boolean(hooks.store),
          hasPerpsStreamManager: typeof hooks.getPerpsStreamManager === 'function',
          backgroundUnresponsive: bodyText.includes('Background connection unresponsive') || bodyText.includes('MetaMask had trouble starting'),
          backgroundProbeOk: false,
          backgroundProbeError: 'perpsGetAccountState timed out after 5000ms',
        }), 5000)),
      ]);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Extension runtime health evaluation failed.',
    );
  }
  return result.result?.value ?? {};
}

export function formatHealthFailure(report: ExtensionRuntimeHealthReport, projectRoot: string): string {
  return [
    `Extension runtime health check failed for ${projectRoot} on CDP port ${report.cdpPort}.`,
    ...report.findings.map((finding) => `- ${finding}`),
    'Use the canonical Farmslot validation launcher, for example:',
    `  bin/metamask-recipe run <recipe.json> --adapter extension --target ${projectRoot} --slot <slot-id> --cdp-port ${report.cdpPort} --launch-existing-dist --artifacts-dir <artifacts-dir>`,
    `Health details: ${JSON.stringify(report.details)}`,
  ].join('\n');
}

function resolveCdpPort(rawPort: string | number | undefined, slot: ResolvedSlot | null): number {
  const raw = rawPort ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT ?? slot?.cdpPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Extension runtime requires --cdp-port, CDP_PORT, RECIPE_CDP_PORT, or a Farmslot slot with resources.browser.cdp_port.');
  }
  return port;
}

interface ResolvedSlot {
  id: string;
  repo: string;
  cdpPort?: number;
}

function resolveExtensionSlot(projectRoot: string, requestedSlot?: string): ResolvedSlot | null {
  const farmslotRoot = resolveLocalFarmslotRoot();
  if (!farmslotRoot) {
    if (requestedSlot) throw new Error('Extension slot lookup requires a local Farmslot checkout when --slot is provided.');
    return null;
  }
  const poolsDir = path.join(farmslotRoot, 'pool');
  if (!fs.existsSync(poolsDir)) return null;
  for (const file of fs.readdirSync(poolsDir)) {
    if (!file.endsWith('.json')) continue;
    const pool = JSON.parse(fs.readFileSync(path.join(poolsDir, file), 'utf8')) as { slots?: unknown[] };
    for (const rawSlot of pool.slots ?? []) {
      if (!rawSlot || typeof rawSlot !== 'object') continue;
      const slot = rawSlot as Record<string, any>;
      if (requestedSlot && slot.id !== requestedSlot) continue;
      if (!requestedSlot && path.resolve(String(slot.repo ?? '')) !== projectRoot) continue;
      return {
        id: String(slot.id),
        repo: path.resolve(String(slot.repo)),
        cdpPort: Number(slot.resources?.browser?.cdp_port || slot.resources?.browser?.cdpPort || undefined) || undefined,
      };
    }
  }
  return null;
}

async function launchFarmslotValidationBrowser(options: {
  projectRoot: string;
  cdpPort: number;
  slotId: string;
  validationRuntimeDir: string;
}): Promise<ExtensionRuntimeLaunchResult> {
  const farmslotRoot = resolveRequiredLocalFarmslotRoot('Extension validation browser launch');
  const script = path.join(farmslotRoot, 'projects/metamask-extension-farm/setup/launch-validation-browser.sh');
  if (!fs.existsSync(script)) {
    throw new Error(`Canonical Extension validation launcher not found: ${script}`);
  }
  await killCdpPort(options.cdpPort);
  const result = await runProcess('bash', [
    script,
    options.slotId,
    '--cdp-port',
    String(options.cdpPort),
    '--runtime-dir',
    options.validationRuntimeDir,
    '--no-landing',
  ], {
    cwd: farmslotRoot,
    env: process.env,
    timeoutMs: 180_000,
  });
  if (result.timedOut) {
    throw new Error(`Canonical Extension validation launcher timed out after 180000ms.\n${result.stdout}\n${result.stderr}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Canonical Extension validation launcher failed with exit ${result.exitCode}.\n${result.stdout}\n${result.stderr}`);
  }
  return {
    launched: true,
    slotId: options.slotId,
    cdpPort: options.cdpPort,
    runtimeDir: options.validationRuntimeDir,
    stdout: result.stdout,
  };
}

function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 1000);
          resolve({ exitCode: null, stdout, stderr, timedOut: true });
        }, options.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr, timedOut: false });
    });
  });
}

async function killCdpPort(cdpPort: number): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  await runProcess('bash', ['-lc', `lsof -ti tcp:${cdpPort} -sTCP:LISTEN | xargs -r kill -TERM || true; sleep 1; lsof -ti tcp:${cdpPort} -sTCP:LISTEN | xargs -r kill -KILL || true`], {
    cwd: runnerDir,
    env: process.env,
    timeoutMs: 10_000,
  });
}

function safeExtensionId(target: CdpTarget): string | undefined {
  try {
    return extensionIdFromTarget(target);
  } catch (_error) {
    // Non-extension CDP targets are expected while scanning all browser tabs.
    // Treat them as unmatched targets instead of failing runtime discovery.
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
