import { execSync } from 'node:child_process';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';
import type { ActionAdapter, RecipeRunner } from '@farmslot/recipe-harness';

import { createMetaMaskAdapters, createMetaMaskUiTransport } from './adapters.ts';
import { loadMetaMaskExtensionActionManifest, loadMetaMaskMobileActionManifest } from './manifest.ts';
import { importFarmslotHarness, importFarmslotHarnessRuntimeCdp, importFarmslotHarnessRuntimeReactNativeBridge, runnerDir } from './paths.ts';
import type { CreateMetaMaskRunnerOptions, MetaMaskRecipeAdapter } from './types.ts';

export async function createMetaMaskMobileRunner(
  options: CreateMetaMaskRunnerOptions = {},
): Promise<RecipeRunner> {
  return createMetaMaskRunner(
    'mobile',
    options.actionManifest ?? loadMetaMaskMobileActionManifest(),
  );
}

export async function createMetaMaskExtensionRunner(
  options: CreateMetaMaskRunnerOptions = {},
): Promise<RecipeRunner> {
  return createMetaMaskRunner(
    'extension',
    options.actionManifest ?? loadMetaMaskExtensionActionManifest(),
  );
}

export async function createMetaMaskRunner(
  adapter: MetaMaskRecipeAdapter,
  actionManifest: RecipeActionManifestDocument,
): Promise<RecipeRunner> {
  const {
    createRecipeRunner,
    createStandardCoreAdapters,
    createStandardUiAdapters,
  } = await importFarmslotHarness();
  const { createCdpWebUiTransport } = await importFarmslotHarnessRuntimeCdp();
  const { createReactNativeBridgeUiTransport } = await importFarmslotHarnessRuntimeReactNativeBridge();
  const actions = [
    ...actionManifest.supported_official_actions,
    ...(actionManifest.custom_actions ?? []).map((entry: { name: string }) => entry.name),
  ];
  const declaredActions = new Set(actions);
  const core = createStandardCoreAdapters({ actions });
  const projectOwnedOfficialActions = new Set(['app.status']);
  const ui = createStandardUiAdapters({
    actions: actions.filter((action) => !projectOwnedOfficialActions.has(action)),
    transport: createMetaMaskUiTransport(adapter, {
      createCdpWebUiTransport,
      createReactNativeBridgeUiTransport,
    }),
  });
  const existing = new Set([...core, ...ui].map((entry) => entry.action));
  const custom: ActionAdapter[] = createMetaMaskAdapters(adapter).filter(
    (entry) => declaredActions.has(entry.action) && !existing.has(entry.action),
  );
  const autoHudDisabled = process.env.METAMASK_RECIPE_AUTO_HUD === '0' || process.env.METAMASK_RECIPE_AUTO_HUD === 'false';
  return createRecipeRunner({
    actionManifest,
    adapters: [...core, ...ui, ...custom],
    logger: console,
    runner: runnerProvenance(),
    hud: autoHudDisabled
      ? false
      : {
          enabled: true,
          display: {
            layout: 'docked-bottom',
            position: 'bottom',
            showTitle: false,
            showDebug: false,
            maxDetailLines: 2,
          },
        },
  });
}

function runnerProvenance() {
  return {
    source: runnerDir,
    git_ref: runnerGitRef(),
    name: '@metamask/recipe-runner',
  };
}

function runnerGitRef(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: runnerDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Standalone packaged runners may be copied without a .git directory; keep
    // artifact packages valid while source/ref still identifies the runner.
    return 'unknown';
  }
}
