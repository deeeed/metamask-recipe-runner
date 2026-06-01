import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDoctorReport } from './doctor.ts';
import { ensureExtensionReady } from './extension-ensure-ready.ts';
import { resolveExtensionId } from './extension-id.ts';
import { decideExtensionReadiness } from './extension-runtime-decision.ts';
// NOTE: extension-runtime.ts loads the farmslot harness at module scope, so it
// is imported LAZILY (dynamic import) only inside the handlers that drive a live
// runtime. Static-import it here and every command — manifest, doctor,
// runtime-decision (no --cdp-port) — would fail to load on a checkout without
// farmslot built. Keep this lazy.
import { loadActionManifest, validateManifest } from './manifest.ts';
import { assertAdapter, manifestPath, recipePath, runnerDir } from './paths.ts';
// runner.ts → adapters.ts → live-adapters/extension/platform/cdp.mjs does a
// top-level `await importFarmslotHarness()`, so it is imported LAZILY inside
// runRecipe only. Keeping it static would load the farmslot harness for every
// command (manifest, doctor, runtime-decision), defeating their independence.
import type { RecipeRunResult } from '@farmslot/recipe-harness';
import type { MetaMaskRecipeAdapter } from './types.ts';

type CliOptionValue = string | boolean;
type CliOptions = Record<string, CliOptionValue>;

interface ParsedArgs {
  positional: string[];
  options: CliOptions;
}

interface RuntimeOptions {
  cdpPort?: string;
  launchExistingDist?: boolean;
  skipExtensionRuntimePrepare?: boolean;
  slot?: string;
  validationRuntimeDir?: string;
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<number>> = {
  manifest: handleManifest,
  doctor: handleDoctor,
  'runtime-health': handleRuntimeHealth,
  'runtime-decision': handleRuntimeDecision,
  'resolve-extension': handleResolveExtension,
  'ensure-ready': handleEnsureReady,
  run: handleRun,
  'self-test': handleSelfTest,
};

function usage() {
  console.error(`Usage:
  metamask-recipe manifest --adapter <mobile|extension> [--json]
  metamask-recipe doctor --adapter <mobile|extension> --target <repo> [--json]
  metamask-recipe runtime-health --adapter extension --target <repo> --cdp-port <port> [--json]
  metamask-recipe runtime-decision --adapter extension --target <repo> [--cdp-port <port>] [--watch-log <path>] [--record] [--json]
  metamask-recipe resolve-extension --adapter extension --target <repo> [--cdp-port <port>] [--json]
  metamask-recipe ensure-ready --adapter extension --target <repo> --cdp-port <port> [--json]
  metamask-recipe run <recipe.json> --adapter <mobile|extension> --artifacts-dir <dir> [--project-root <repo>] [--action-manifest <path>] [--cdp-port <port>] [--slot <slot-id>] [--launch-existing-dist] [--json]
  metamask-recipe self-test [--artifacts-dir <dir>] [--json]
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: CliOptions = {};
  const booleanOptions = new Set(['json', 'launchExistingDist', 'record']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = normalizeOptionKey(arg.slice(2));
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
    options[key] = argv[i + 1];
    i += 1;
  }
  return { positional, options };
}

function normalizeOptionKey(key: string): string {
  return key.replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}

function optionString(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`--${key} requires a value.`);
  return value;
}

function optionFlag(options: CliOptions, key: string): boolean {
  const value = options[key];
  return value === true;
}

function requiredOption(options: CliOptions, key: string, message: string): string {
  const value = optionString(options, key);
  if (!value) throw new Error(message);
  return value;
}

function adapterOption(options: CliOptions): MetaMaskRecipeAdapter {
  const adapter = optionString(options, 'adapter');
  assertAdapter(adapter);
  return adapter;
}

function targetPath(options: CliOptions): string {
  return path.resolve(optionString(options, 'target') ?? optionString(options, 'projectRoot') ?? process.cwd());
}

function actionManifestPathOption(options: CliOptions, adapter: MetaMaskRecipeAdapter): string {
  const configured = optionString(options, 'actionManifest');
  return configured ? path.resolve(configured) : manifestPath(adapter);
}

async function runRecipe(
  adapter: MetaMaskRecipeAdapter,
  recipe: string,
  artifactsDir: string,
  projectRoot: string,
  actionManifestPath?: string,
  runtimeOptions: RuntimeOptions = {},
): Promise<RecipeRunResult> {
  const previousCdpPort = process.env.CDP_PORT;
  const previousRecipeCdpPort = process.env.RECIPE_CDP_PORT;
  const previousExtensionAutolaunch = process.env.METAMASK_RECIPE_EXTENSION_AUTOLAUNCH;
  if (runtimeOptions.cdpPort) {
    process.env.CDP_PORT = runtimeOptions.cdpPort;
    process.env.RECIPE_CDP_PORT = runtimeOptions.cdpPort;
  }
  if (runtimeOptions.launchExistingDist) {
    process.env.METAMASK_RECIPE_EXTENSION_AUTOLAUNCH = '1';
  }
  try {
    await prepareRuntimeIfNeeded(adapter, projectRoot, runtimeOptions);
    const manifest = loadActionManifest(adapter, actionManifestPath);
    await validateManifest(manifest);
    const { createMetaMaskRunner } = await import('./runner.ts');
    const runner = await createMetaMaskRunner(adapter, manifest);
    return await runner.run({
      recipePath: path.resolve(recipe),
      artifactsDir: path.resolve(artifactsDir),
      projectRoot,
    });
  } finally {
    restoreEnv('CDP_PORT', previousCdpPort);
    restoreEnv('RECIPE_CDP_PORT', previousRecipeCdpPort);
    restoreEnv('METAMASK_RECIPE_EXTENSION_AUTOLAUNCH', previousExtensionAutolaunch);
  }
}

async function prepareRuntimeIfNeeded(
  adapter: MetaMaskRecipeAdapter,
  projectRoot: string,
  runtimeOptions: RuntimeOptions,
): Promise<void> {
  if (adapter !== 'extension' || runtimeOptions.skipExtensionRuntimePrepare === true) return;
  const { prepareExtensionRuntime } = await import('./extension-runtime.ts');
  await prepareExtensionRuntime({
    projectRoot,
    cdpPort: runtimeOptions.cdpPort,
    slot: runtimeOptions.slot,
    launchExistingDist: runtimeOptions.launchExistingDist === true,
    validationRuntimeDir: runtimeOptions.validationRuntimeDir,
  });
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function runSelfTest(options: CliOptions) {
  const root = optionString(options, 'artifactsDir')
    ? path.resolve(requiredOption(options, 'artifactsDir', 'self-test artifacts dir missing.'))
    : await mkdtemp(path.join(os.tmpdir(), 'metamask-recipe-runner-'));
  const previousAutoHud = process.env.METAMASK_RECIPE_AUTO_HUD;
  const runs = [];
  try {
    // Self-test is a package wiring check, not a live-device proof. Disable the
    // automatic HUD and extension launch so it remains safe in fresh checkouts.
    process.env.METAMASK_RECIPE_AUTO_HUD = '0';
    for (const adapter of ['mobile', 'extension'] as const) {
      const manifest = loadActionManifest(adapter);
      const manifestValidation = await validateManifest(manifest);
      const smokeRecipe = recipePath(
        adapter === 'mobile' ? 'smoke.mobile.recipe.json' : 'smoke.extension.recipe.json',
      );
      const artifactsDir = path.join(root, adapter);
      const result = await runRecipe(adapter, smokeRecipe, artifactsDir, runnerDir, undefined, {
        skipExtensionRuntimePrepare: true,
      });
      runs.push({ adapter, manifestValidation: manifestValidation.summary, artifactsDir, result });
    }
  } finally {
    restoreEnv('METAMASK_RECIPE_AUTO_HUD', previousAutoHud);
  }
  return {
    status: runs.every((run) => run.result.status === 'pass') ? 'pass' : 'fail',
    artifactsDir: root,
    runs,
  };
}

async function handleManifest({ options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  const actionManifestPath = actionManifestPathOption(options, adapter);
  const manifest = loadActionManifest(adapter, optionString(options, 'actionManifest'));
  await validateManifest(manifest);
  if (optionFlag(options, 'json')) console.log(JSON.stringify(manifest, null, 2));
  else console.log(actionManifestPath);
  return 0;
}

async function handleDoctor({ options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  const target = targetPath(options);
  const actionManifestPath = actionManifestPathOption(options, adapter);
  const manifest = loadActionManifest(adapter, optionString(options, 'actionManifest'));
  const manifestValidation = await validateManifest(manifest);
  const result = createDoctorReport(adapter, target, manifestValidation, actionManifestPath);
  if (optionFlag(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} ${adapter} ${result.compatibilityMode} manifest=${actionManifestPath}`);
  return result.status === 'pass' ? 0 : 1;
}

async function handleRuntimeHealth({ options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  if (adapter !== 'extension') throw new Error('runtime-health currently applies to the extension adapter.');
  const target = targetPath(options);
  const cdpPort = parsePort(
    optionString(options, 'cdpPort') ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT,
    'runtime-health requires --cdp-port <port>.',
  );
  const { checkExtensionRuntimeHealth, formatHealthFailure } = await import('./extension-runtime.ts');
  const report = await checkExtensionRuntimeHealth(target, cdpPort);
  if (optionFlag(options, 'json')) console.log(JSON.stringify(report, null, 2));
  else if (report.status === 'PASS') console.log(`PASS extension runtime cdp=${cdpPort} target=${report.targetUrl}`);
  else console.error(formatHealthFailure(report, target));
  return report.status === 'PASS' ? 0 : 1;
}

async function handleRuntimeDecision({ options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  const target = targetPath(options);
  if (adapter !== 'extension') {
    // Graceful unsupported (not a throw): a host always gets a parseable answer.
    const report = {
      schemaVersion: 1,
      adapter,
      target,
      decision: 'unknown',
      clean: false,
      reasonCode: 'adapter-unsupported',
      reasons: [`runtime-decision currently applies to the extension adapter, not ${adapter}.`],
      checks: {},
      actions: [],
    };
    if (optionFlag(options, 'json')) console.log(JSON.stringify(report, null, 2));
    else console.log(`unknown adapter-unsupported — ${report.reasons[0]}`);
    return 0;
  }
  const cdpPortRaw = optionString(options, 'cdpPort') ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT;
  const cdpPort = cdpPortRaw === undefined ? undefined : parsePort(cdpPortRaw, 'runtime-decision --cdp-port must be a port.');
  const report = await decideExtensionReadiness(target, {
    cdpPort,
    watchLog: optionString(options, 'watchLog'),
    record: optionFlag(options, 'record'),
  });
  if (optionFlag(options, 'json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.decision}${report.clean ? ' (clean)' : ''} ${report.reasonCode} — ${report.reasons[0] ?? ''}`);
  // Exit 0 whenever advice was computed (even install/build/relaunch); the host
  // branches on report.decision. Only invalid args / probe failure throw.
  return 0;
}

async function handleResolveExtension({ options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  if (adapter !== 'extension') throw new Error('resolve-extension currently applies to the extension adapter.');
  const target = targetPath(options);
  const cdpPortRaw = optionString(options, 'cdpPort') ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT;
  const cdpPort = cdpPortRaw === undefined ? undefined : parsePort(cdpPortRaw, 'resolve-extension --cdp-port must be a port.');
  const result = await resolveExtensionId(target, { cdpPort });
  if (optionFlag(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else if (result.extensionId) console.log(result.extensionId); // bare id: easy `$(... resolve-extension ...)` capture
  else console.error('Could not resolve a MetaMask extension id (no dist key and no single CDP extension).');
  return result.extensionId ? 0 : 1;
}

async function handleEnsureReady({ options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  if (adapter !== 'extension') throw new Error('ensure-ready currently applies to the extension adapter.');
  const target = targetPath(options);
  const cdpPort = parsePort(
    optionString(options, 'cdpPort') ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT,
    'ensure-ready requires --cdp-port <port>.',
  );
  const result = await ensureExtensionReady(target, { cdpPort });
  if (optionFlag(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.ready ? 'READY' : 'NOT-READY'} ${result.reasonCode} — id=${result.extensionId} homeTabs ${result.homeTabs.before}→${result.homeTabs.after} (closed ${result.homeTabs.closed})`);
  return result.ready ? 0 : 1;
}

async function handleRun({ positional, options }: ParsedArgs): Promise<number> {
  const adapter = adapterOption(options);
  const targetRecipe = positional[0];
  if (!targetRecipe) throw new Error('run requires <recipe.json>.');
  const artifactsDir = requiredOption(options, 'artifactsDir', 'run requires --artifacts-dir <dir>.');
  const result = await runRecipe(
    adapter,
    targetRecipe,
    artifactsDir,
    targetPath(options),
    optionString(options, 'actionManifest'),
    runtimeOptionsFromCli(options),
  );
  if (optionFlag(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`MetaMask recipe run: ${result.status}\nArtifacts: ${result.artifactManifestPath}`);
  return result.status === 'pass' ? 0 : 1;
}

async function handleSelfTest({ options }: ParsedArgs): Promise<number> {
  const result = await runSelfTest(options);
  if (optionFlag(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`MetaMask runner self-test: ${result.status}\nArtifacts: ${result.artifactsDir}`);
  return result.status === 'pass' ? 0 : 1;
}

function runtimeOptionsFromCli(options: CliOptions): RuntimeOptions {
  return {
    cdpPort: optionString(options, 'cdpPort'),
    launchExistingDist: optionFlag(options, 'launchExistingDist'),
    slot: optionString(options, 'slot'),
    validationRuntimeDir: optionString(options, 'validationRuntimeDir'),
  };
}

function parsePort(value: string | undefined, errorMessage: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error(errorMessage);
  return port;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === '-h' || command === '--help') {
    usage();
    return command ? 0 : 2;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return handler(parseArgs(argv.slice(1)));
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
