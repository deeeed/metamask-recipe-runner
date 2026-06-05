import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  FarmslotHarnessBrowserExtensionModule,
  FarmslotHarnessCdpModule,
  FarmslotHarnessModule,
  FarmslotHarnessReactNativeBridgeModule,
  FarmslotProtocolModule,
  MetaMaskRecipeAdapter,
} from './types.ts';

export const runnerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RECIPE_RUNTIME_DIR = 'temp/recipe/runtime';
export const DEFAULT_RECIPE_HARNESS_ROOT = 'temp/recipe/harness';

export function recipeRuntimeDir() {
  return process.env.RECIPE_RUNTIME_DIR || DEFAULT_RECIPE_RUNTIME_DIR;
}

export function recipeHarnessRoot() {
  return process.env.RECIPE_HARNESS_ROOT || DEFAULT_RECIPE_HARNESS_ROOT;
}

export function recipeRuntimePath(projectRoot: string, ...segments: string[]) {
  return path.join(projectRoot, recipeRuntimeDir(), ...segments);
}

export function recipeHarnessPath(projectRoot: string, ...segments: string[]) {
  return path.join(projectRoot, recipeHarnessRoot(), ...segments);
}

export function walletFixturePath(projectRoot: string) {
  return recipeRuntimePath(projectRoot, 'wallet-fixture.json');
}

export function extensionIdPath(projectRoot: string) {
  return recipeRuntimePath(projectRoot, 'extension.id');
}

export function recipeWatchLogCandidates() {
  return [
    path.join(recipeRuntimeDir(), 'webpack.log'),
    path.join(recipeRuntimeDir(), 'recipe-harness-webpack.log'),
  ];
}

export function resolveLocalFarmslotRoot() {
  const candidates = [
    process.env.FARMSLOT_ROOT,
    readConfiguredFarmslotRoot(),
    findFarmslotRoot(runnerDir),
    findFarmslotRoot(process.cwd()),
  ].filter(Boolean);
  const root = candidates[0];
  return root ? path.resolve(root) : undefined;
}

export function resolveRequiredLocalFarmslotRoot(reason: string) {
  const root = resolveLocalFarmslotRoot();
  if (!root) {
    throw new Error(
      `${reason} requires a local Farmslot checkout. Set FARMSLOT_ROOT or create .farmslot-root for this dev-only path.`,
    );
  }
  return root;
}

function readConfiguredFarmslotRoot() {
  const configPath = path.join(runnerDir, '.farmslot-root');
  if (!fs.existsSync(configPath)) return undefined;
  const value = fs.readFileSync(configPath, 'utf8').trim();
  return value || undefined;
}

function findFarmslotRoot(start) {
  let dir = path.resolve(start);
  while (dir !== path.dirname(dir)) {
    if (isFarmslotRoot(dir)) return dir;
    const sibling = path.join(dir, 'farmslot');
    if (isFarmslotRoot(sibling)) return sibling;
    dir = path.dirname(dir);
  }
  return undefined;
}

function isFarmslotRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, 'packages/recipe-harness/package.json')) &&
    fs.existsSync(path.join(candidate, 'packages/protocol/package.json'))
  );
}

export function assertAdapter(adapter: unknown): asserts adapter is MetaMaskRecipeAdapter {
  if (adapter !== 'mobile' && adapter !== 'extension') {
    throw new Error('Adapter must be mobile or extension.');
  }
}

export function manifestPath(adapter: MetaMaskRecipeAdapter) {
  assertAdapter(adapter);
  return path.join(runnerDir, 'manifests', `${adapter}.action-manifest.json`);
}

export function recipePath(name: string) {
  return path.join(runnerDir, 'recipes', name);
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function importFarmslotHarness(): Promise<FarmslotHarnessModule> {
  return importFarmslotPackage(
    '@farmslot/recipe-harness',
    'packages/recipe-harness/src/index.ts',
  ) as Promise<FarmslotHarnessModule>;
}

export async function importFarmslotHarnessRuntimeCdp(): Promise<FarmslotHarnessCdpModule> {
  return importFarmslotPackage(
    '@farmslot/recipe-harness/runtime/cdp',
    'packages/recipe-harness/src/runtime/cdp.ts',
  ) as Promise<FarmslotHarnessCdpModule>;
}

export async function importFarmslotHarnessRuntimeBrowserExtension(): Promise<FarmslotHarnessBrowserExtensionModule> {
  return importFarmslotPackage(
    '@farmslot/recipe-harness/runtime/browser-extension',
    'packages/recipe-harness/src/runtime/browser-extension.ts',
  ) as Promise<FarmslotHarnessBrowserExtensionModule>;
}

export async function importFarmslotHarnessRuntimeReactNativeBridge(): Promise<FarmslotHarnessReactNativeBridgeModule> {
  return importFarmslotPackage(
    '@farmslot/recipe-harness/runtime/react-native-bridge',
    'packages/recipe-harness/src/runtime/react-native-bridge.ts',
  ) as Promise<FarmslotHarnessReactNativeBridgeModule>;
}

export async function importFarmslotProtocol(): Promise<FarmslotProtocolModule> {
  return importFarmslotPackage(
    '@farmslot/protocol',
    'packages/protocol/src/index.ts',
  ) as Promise<FarmslotProtocolModule>;
}

async function importFarmslotPackage(packageName: string, localSourceEntry: string) {
  try {
    return await import(packageName);
  } catch (error) {
    if (!isMissingPackageError(error, packageName)) throw error;
  }

  const root = resolveLocalFarmslotRoot();
  if (!root) {
    throw new Error(
      `${packageName} is not installed. Install @farmslot/* packages normally, or set FARMSLOT_ROOT/use npm run dev:link-farmslot while co-developing Farmslot locally.`,
    );
  }
  return import(pathToFileURL(path.join(root, localSourceEntry)).href);
}

function isMissingPackageError(error: unknown, packageName: string) {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(packageName);
}
