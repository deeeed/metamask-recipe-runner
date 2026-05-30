import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { compatibilityMode, fixtureSummary, repoShape } from './doctor.ts';
import { runLiveAdapterScript } from './live-adapter-contract.ts';
import { withExtensionPage } from '../live-adapters/extension/platform/cdp.mjs';
import { bridgeCommand, evalSync, simulatorScreenshot } from '../live-adapters/mobile/platform/bridge.mjs';
import type {
  ActionAdapter,
  ActionExecutionContext,
  ActionResult,
  UiActionTransport,
} from '@farmslot/recipe-harness';
import type { MetaMaskRecipeAdapter } from './types.ts';

type ActionNode = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MetaMaskUiActionInput {
  action: string;
  nodeId?: string;
  node: ActionNode;
}

type ActionExecutor = (
  node: ActionNode,
  context: ActionExecutionContext,
) => Promise<ActionResult> | ActionResult;

function simpleAdapter(action: string, executor: ActionExecutor): ActionAdapter {
  return {
    action,
    async execute(node, context) {
      return executor(node, context);
    },
  };
}

const LIVE_ONLY_PERPS_ACTIONS = new Set([
  'metamask.perps.navigate',
  'metamask.perps.read_positions',
  'metamask.perps.ensure_positions',
  'metamask.perps.assert_positions',
  'metamask.perps.place_order',
  'metamask.perps.close_positions',
  'metamask.perps.read_orders',
  'metamask.perps.close_orders',
  'metamask.perps.ensure_orders',
  'metamask.perps.assert_orders',
  'metamask.perps.start_state',
  'metamask.perps.teardown_state',
  'metamask.perps.assert_debug_banner',
]);
const LIVE_ONLY_WALLET_ACTIONS = new Set([
  'metamask.wallet.setup',
  'metamask.wallet.ensure_unlocked',
  'metamask.wallet.select_account',
  'metamask.wallet.navigate',
  'metamask.wallet.read_state',
]);
const LIVE_ONLY_APP_ACTIONS = new Set(['ui.navigate']);

function requiresLiveAdapter(action: string) {
  return (
    LIVE_ONLY_PERPS_ACTIONS.has(action) ||
    LIVE_ONLY_WALLET_ACTIONS.has(action) ||
    LIVE_ONLY_APP_ACTIONS.has(action)
  );
}

function liveRuntimeConfigured(platform: MetaMaskRecipeAdapter, node: ActionNode) {
  if (platform === 'mobile') return true;
  return Boolean(node.cdp_port ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT);
}

async function runLiveFirst(
  platform: MetaMaskRecipeAdapter,
  action: string,
  node: ActionNode,
  context: ActionExecutionContext,
): Promise<ActionResult | null> {
  if (node.allow_static_placeholder === true) {
    throw new Error(
      `${action} refused allow_static_placeholder. MetaMask runner proof runs must use live adapters and real artifacts.`,
    );
  }
  if (!requiresLiveAdapter(action) && !liveRuntimeConfigured(platform, node)) return null;
  const live = await runLiveAdapterScript({ platform, action, node, context });
  if (!live) return null;
  const liveResult = isRecord(live.result) ? live.result : { result: live.result };
  const output = { ...liveResult, liveAdapter: live.script };
  return {
    output,
    artifacts:
      isRecord(live.result) && Array.isArray(live.result.artifacts)
        ? live.result.artifacts
        : undefined,
  };
}

async function semanticResult(
  platform: MetaMaskRecipeAdapter,
  action: string,
  node: ActionNode,
  context: ActionExecutionContext,
): Promise<ActionResult> {
  const live = await runLiveFirst(platform, action, node, context);
  if (live) return live;
  if (requiresLiveAdapter(action)) {
    const expected = `live-adapters/${platform}/${action.replace(/^metamask[.]/u, '').replaceAll('.', '/')}.mjs`;
    throw new Error(
      `${action} requires a live ${platform} adapter that drives a real supported app/API path; ` +
        `no adapter script was found or no live runtime is configured (for example ${expected}). Static placeholders are refused to avoid fabricated proof. ` +
        'Set METAMASK_RECIPE_LIVE_ADAPTER_DIR or add a runner live-adapters script.',
    );
  }
  const output = { platform, action, redacted: true };
  if (action === 'metamask.wallet.fixture_status') return { output: fixtureSummary(context.projectRoot) };
  return {
    output: {
      ...output,
      requested: Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'action')),
      note: 'static semantic adapter; live proof must use a real supported app/API path',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalScalarText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`${label} must be a string, number, or boolean.`);
}

function scalarText(value: unknown, label: string, fallback: string): string {
  return optionalScalarText(value, label) ?? fallback;
}

function firstScalarText(
  record: Record<string, unknown>,
  keys: string[],
  label: string,
  fallback?: string,
): string {
  for (const key of keys) {
    const value = optionalScalarText(record[key], `${label}.${key}`);
    if (value !== undefined) return value;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`${label} requires one of: ${keys.join(', ')}.`);
}

function traceText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function probeHttpJson(url: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          resolve({ reachable: false, statusCode: response.statusCode ?? null, error: `HTTP ${response.statusCode ?? 'unknown'}` });
          return;
        }
        try {
          resolve({ reachable: true, statusCode: response.statusCode, json: JSON.parse(body) });
        } catch (error) {
          resolve({
            reachable: true,
            statusCode: response.statusCode,
            json: null,
            parseError: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on('error', (error) => {
      resolve({ reachable: false, statusCode: null, error: error.message });
    });
  });
}

function createMetaMaskSemanticAdapters(platform: MetaMaskRecipeAdapter): ActionAdapter[] {
  const walletActions = [
    'metamask.wallet.fixture_status',
    'metamask.wallet.setup',
    'metamask.wallet.ensure_unlocked',
    'metamask.wallet.select_account',
    'metamask.wallet.navigate',
    'metamask.wallet.read_state',
  ];
  const actions = [
    ...walletActions,
    'metamask.perps.navigate',
    'metamask.perps.read_positions',
    'metamask.perps.ensure_positions',
    'metamask.perps.assert_positions',
    'metamask.perps.place_order',
    'metamask.perps.close_positions',
    'metamask.perps.read_orders',
    'metamask.perps.close_orders',
    'metamask.perps.ensure_orders',
    'metamask.perps.assert_orders',
    'metamask.perps.start_state',
    'metamask.perps.teardown_state',
    'metamask.perps.assert_debug_banner',
  ];
  return actions.map((action) => simpleAdapter(action, async (node, context) => semanticResult(platform, action, node, context)));
}

function uiInputFor(context: ActionExecutionContext, input: MetaMaskUiActionInput) {
  return {
    action: input.action,
    node: input.node,
    context: {
      nodeId: context.nodeId,
      projectRoot: context.projectRoot,
      artifactsDir: context.artifactsDir,
    },
  };
}


function mobileProbeOutput(status: unknown, input: MetaMaskUiActionInput, projectRoot: string) {
  const entries = Array.isArray(status) ? status : [status];
  const preferredDevices = [
    input.node?.ios_simulator,
    input.node?.simulator,
    input.node?.android_device,
    input.node?.adb_serial,
    process.env.IOS_SIMULATOR,
    process.env.ANDROID_DEVICE,
    process.env.ADB_SERIAL,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const selected = entries.find((entry) => {
    if (!isRecord(entry)) return false;
    return typeof entry.deviceName === 'string' && preferredDevices.includes(entry.deviceName);
  }) ?? entries.find((entry) => isRecord(entry) && isRecord(entry.route)) ?? null;
  const route = isRecord(selected) && isRecord(selected.route) ? selected.route : null;
  return {
    reachable: Boolean(selected),
    bridge: mobileBridgePath(projectRoot),
    targetCount: entries.filter((entry) => isRecord(entry)).length,
    deviceName: isRecord(selected) && typeof selected.deviceName === 'string' ? selected.deviceName : null,
    routeName: route && typeof route.name === 'string' ? route.name : null,
    accountPresent: isRecord(selected) && isRecord(selected.account),
  };
}

function mobileBridgePath(projectRoot: string): string {
  const injected = '.agent/recipe-harness/mobile/cdp-bridge.js';
  return existsSync(path.join(projectRoot, injected)) ? injected : 'scripts/perps/agentic/cdp-bridge.js';
}

async function waitForMobileTarget(input: ReturnType<typeof uiInputFor>, payload: ActionNode) {
  const timeoutMs = Number(payload.timeout_ms ?? payload.timeoutMs ?? 10000);
  const deadline = Date.now() + timeoutMs;
  const testId = firstScalarText(payload, ['test_id', 'testID'], 'Mobile ui.wait_for');
  const expected = scalarText(payload.expected, 'ui.wait_for.expected', 'present').toLowerCase();
  const expectedText = optionalScalarText(payload.text, 'ui.wait_for.text');
  const textMatch = scalarText(payload.text_match ?? payload.textMatch, 'ui.wait_for.text_match', 'contains').toLowerCase();
  const textExpression = `(function(){
    const api = globalThis.__AGENTIC__;
    if (!api?.getTextByTestId) return null;
    return api.getTextByTestId(${JSON.stringify(testId)});
  })()`;
  const expression = `Boolean(globalThis.__AGENTIC__?.findFiberByTestId?.(${JSON.stringify(testId)}))`;
  let lastValue: unknown = null;
  let lastText: unknown = null;
  const expectsAbsent = expected === 'absent' || expected === 'hidden' || expected === 'not_present';
  while (Date.now() <= deadline) {
    lastValue = await evalSync(input, expression);
    const present = Boolean(lastValue);
    if (expectsAbsent && !present) {
      return { matched: true, testId, expected, present };
    }
    if (!expectsAbsent && present) {
      if (!expectedText) {
        return { matched: true, testId, expected, present };
      }
      lastText = await evalSync(input, textExpression);
      const text = traceText(lastText);
      const textMatched = textMatch === 'exact' ? text === expectedText : text.includes(expectedText);
      if (textMatched) {
        return { matched: true, testId, expected, present, text, textMatch };
      }
    }
    await sleep(250);
  }
  const textReason = expectedText ? ` and text ${textMatch} ${JSON.stringify(expectedText)}; last text=${JSON.stringify(lastText)}` : '';
  throw new Error(`Timed out waiting for mobile testID ${testId} to be ${expected}${textReason}; last present=${Boolean(lastValue)}.`);
}

interface MobileBridgeCommand {
  command: string;
  payload: ActionNode;
}

type MobileBridgeHandler = (
  payload: ActionNode,
  context: ActionExecutionContext,
) => Promise<unknown>;

const MOBILE_BRIDGE_HANDLERS: Record<string, MobileBridgeHandler> = {
  screenshot: handleMobileScreenshot,
  status: handleMobileStatus,
  navigate: handleMobileNavigate,
  press: handleMobilePress,
  setInput: handleMobileSetInput,
  scroll: handleMobileScroll,
  waitFor: handleMobileWaitFor,
  hud: handleMobileHud,
};

function createMetaMaskMobileBridge() {
  return {
    async send(command: MobileBridgeCommand, context: ActionExecutionContext) {
      const handler = MOBILE_BRIDGE_HANDLERS[command.command];
      if (!handler) {
        throw new Error(`React Native bridge command ${command.command} is not implemented by the MetaMask runner transport.`);
      }
      return handler(command.payload, context);
    },
  };
}

function mobileUiInput(context: ActionExecutionContext, command: string, payload: ActionNode) {
  return uiInputFor(context, { action: `ui.${command}`, node: payload });
}

async function handleMobileScreenshot(payload: ActionNode, context: ActionExecutionContext) {
  const input = mobileUiInput(context, 'screenshot', payload);
  const relPath = scalarText(payload.path, 'ui.screenshot.path', `screenshots/${context.nodeId}.png`);
  const artifact = await simulatorScreenshot(input, relPath);
  context.registerArtifact(artifact);
  return { captured: true, path: artifact.path, artifact };
}

async function handleMobileStatus(payload: ActionNode, context: ActionExecutionContext) {
  return bridgeCommand(mobileUiInput(context, 'status', payload), ['status']);
}

async function handleMobileNavigate(payload: ActionNode, context: ActionExecutionContext) {
  const live = await runLiveAdapterScript({ platform: 'mobile', action: 'ui.navigate', node: payload, context });
  if (!live) throw new Error('ui.navigate requires live-adapters/mobile/ui/navigate.mjs.');
  return isRecord(live.result) ? { ...live.result, liveAdapter: live.script } : live.result;
}

async function handleMobilePress(payload: ActionNode, context: ActionExecutionContext) {
  const target = firstScalarText(payload, ['test_id', 'testID', 'selector', 'text'], 'ui.press');
  return bridgeCommand(mobileUiInput(context, 'press', payload), ['press-test-id', target]);
}


async function handleMobileSetInput(payload: ActionNode, context: ActionExecutionContext) {
  const input = mobileUiInput(context, 'set_input', payload);
  const testId = firstScalarText(payload, ['test_id', 'testID'], 'ui.set_input');
  const value = scalarText(payload.value ?? payload.text, 'ui.set_input.value', '');
  const result = await bridgeCommand(input, ['set-input', testId, value]);
  if (isRecord(result) && result.ok === false) {
    throw new Error(`ui.set_input failed for mobile testID ${testId}: ${traceText(result.error ?? result)}`);
  }
  return isRecord(result) ? result : { result, testId, value };
}

async function handleMobileScroll(payload: ActionNode, context: ActionExecutionContext) {
  const input = mobileUiInput(context, 'scroll', payload);
  const testId = optionalScalarText(payload.test_id ?? payload.testID, 'ui.scroll.test_id');
  const offset = scalarText(payload.offset ?? payload.delta_y ?? payload.deltaY, 'ui.scroll.offset', '600');
  const args = testId
    ? ['scroll-view', '--test-id', testId, '--offset', offset, animatedFlag(payload)]
    : ['scroll-view', '--offset', offset, animatedFlag(payload)];
  const result = await bridgeCommand(input, args);
  return {
    ...(isRecord(result) ? result : { result }),
    intoView: payload.scroll_into_view === true || payload.into_view === true,
  };
}

async function handleMobileWaitFor(payload: ActionNode, context: ActionExecutionContext) {
  return waitForMobileTarget(mobileUiInput(context, 'waitFor', payload), payload);
}

async function handleMobileHud(payload: ActionNode, context: ActionExecutionContext) {
  const input = mobileUiInput(context, 'hud', payload);
  if (payload.clear === true) return bridgeCommand(input, ['hide-step']);
  const hud = mobileHudPayload(payload, context);
  const result = await bridgeCommand(input, ['show-step', hud.displayId || hud.nodeId, hud.description]);
  return { hud: true, nodeId: hud.nodeId, status: hud.status, result };
}

function animatedFlag(payload: ActionNode): string {
  return payload.animated === true ? '--animated' : '--no-animated';
}

function mobileHudPayload(payload: ActionNode, context: ActionExecutionContext) {
  const nodeId = scalarText(payload.node_id ?? payload.nodeId, 'app.hud.node_id', context.nodeId);
  const status = scalarText(payload.status, 'app.hud.status', 'running');
  const subIntent = scalarText(payload.sub_intent ?? payload.subIntent, 'app.hud.sub_intent', '');
  const text = scalarText(payload.intent ?? payload.text ?? payload.detail, 'app.hud.intent', 'Executing recipe step');
  const detail = scalarText(payload.detail, 'app.hud.detail', '');
  const error = scalarText(payload.error, 'app.hud.error', '');
  const progressText = mobileHudProgressText(payload.progress);
  const display = isRecord(payload.display) ? payload.display : {};
  const parts = mobileHudDescriptionParts({
    text,
    detail,
    error,
    subIntent,
    nodeId,
    proofTarget: payload.proofTarget ?? payload.proof_target,
    showDebug: display.showDebug === true,
    showDetail: display.showDetail === true,
    showSubflow: display.showSubflow === true,
  });
  return {
    nodeId,
    status,
    displayId: [mobileHudStatusLabel(status), progressText].filter(Boolean).join(' '),
    description: parts.join('\n'),
  };
}

function mobileHudProgressText(progress: unknown): string {
  if (!isRecord(progress)) return '';
  if (typeof progress.current !== 'number' || typeof progress.total !== 'number') return '';
  return `${progress.current}/${progress.total}`;
}

function mobileHudStatusLabel(status: string): string {
  if (status === 'fail') return 'fail';
  if (status === 'pass') return 'pass';
  return 'run';
}

function mobileHudDescriptionParts(input: {
  text: string;
  detail: string;
  error: string;
  subIntent: string;
  nodeId: string;
  proofTarget: unknown;
  showDebug: boolean;
  showDetail: boolean;
  showSubflow: boolean;
}): string[] {
  const parts = [
    input.text,
    hudLine(input.showSubflow && input.subIntent !== input.text && input.subIntent !== input.detail, 'subflow', input.subIntent),
    hudLine(input.showDetail && input.detail !== input.text && input.detail !== input.subIntent, 'detail', input.detail),
    hudLine(Boolean(input.error), 'error', input.error),
    hudLine(input.showDebug, 'debug node', input.nodeId),
    hudLine(input.showDebug, 'debug proof', traceText(input.proofTarget)),
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return [...new Set(parts)];
}

function hudLine(enabled: boolean, label: string, value: string): string | null {
  return enabled && value ? `${label}: ${value}` : null;
}

export function createMetaMaskUiTransport(
  platform: MetaMaskRecipeAdapter,
  harness: {
    createReactNativeCdpBridgeUiTransport: (options: unknown) => UiActionTransport;
    createCdpWebUiTransport: (options: unknown) => UiActionTransport;
  },
): UiActionTransport {
  const base =
    platform === 'mobile'
      ? harness.createReactNativeCdpBridgeUiTransport({ bridge: createMetaMaskMobileBridge() })
      : harness.createCdpWebUiTransport({
          async withPage(input: { action: string; node: ActionNode; context: ActionExecutionContext }, callback: (page: unknown) => Promise<unknown>) {
            return withExtensionPage(
              {
                action: input.action,
                node: input.node,
                context: {
                  nodeId: input.context.nodeId,
                  projectRoot: input.context.projectRoot,
                  artifactsDir: input.context.artifactsDir,
                },
              },
              callback,
            );
          },
        });
  return {
    async execute(action, node, context) {
      if (action === 'ui.navigate') {
        const live = await runLiveFirst(platform, action, node, context);
        if (live) return live.output;
        throw new Error(`ui.navigate requires live-adapters/${platform}/ui/navigate.mjs.`);
      }
      return base.execute(action, node, context);
    },
  };
}

export function createMetaMaskAdapters(adapter: MetaMaskRecipeAdapter): ActionAdapter[] {
  const platform = adapter;
  const adapters = [
    simpleAdapter('app.status', async (_node, context) => ({
      output: {
        platform,
        projectRoot: context.projectRoot,
        compatibilityMode: compatibilityMode(adapter, context.projectRoot),
        shape: repoShape(context.projectRoot),
      },
    })),
    simpleAdapter('cdp.target', async (node, context) => {
      const cdpPort = node.cdp_port ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT ?? null;
      const metroPort = node.metro_port ?? node.watcher_port ?? process.env.WATCHER_PORT ?? null;
      const timeoutMs = Number(node.probe_timeout_ms ?? node.cdp_timeout_ms ?? node.timeout_ms ?? process.env.CDP_TIMEOUT ?? 10000);
      const required = node.require_reachable === true || node.required === true;
      if (platform === 'mobile' && required) {
        const uiInput: MetaMaskUiActionInput = { action: 'cdp.target', nodeId: context.nodeId, node };
        const status = await bridgeCommand(uiInputFor(context, uiInput), ['status']);
        const probe = mobileProbeOutput(status, uiInput, context.projectRoot);
        if (!probe.reachable) {
          throw new Error('cdp.target required a reachable mobile React Native bridge, but bridge status did not expose a selected app route.');
        }
        return {
          output: {
            platform,
            transport: 'react-native-debug-bridge',
            cdpPort,
            metroPort,
            timeoutMs,
            ...probe,
          },
        };
      }
      const targetPort = platform === 'mobile' ? metroPort ?? cdpPort : cdpPort;
      const url = targetProbeUrl(platform, targetPort);
      const probe = url ? await probeHttpJson(url, timeoutMs) : { reachable: null, statusCode: null, error: 'no port declared' };
      if (required && !probe.reachable) {
        throw new Error(`cdp.target required a reachable ${platform} runtime at ${url ?? '<no port>'}: ${traceText(probe.error) || 'not reachable'}`);
      }
      return {
        output: {
          platform,
          transport: platform === 'mobile' ? 'react-native-debug-bridge' : 'chrome-extension-cdp',
          cdpPort,
          metroPort,
          probeUrl: url,
          timeoutMs,
          ...probe,
        },
      };
    }),
    ...createMetaMaskSemanticAdapters(platform),
  ];
  return adapters;
}

function targetProbeUrl(platform: MetaMaskRecipeAdapter, targetPort: unknown): string | null {
  if (!targetPort) return null;
  const pathSuffix = platform === 'mobile' ? 'json/list' : 'json/version';
  return `http://127.0.0.1:${traceText(targetPort)}/${pathSuffix}`;
}
