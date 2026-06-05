import fs from 'node:fs';
import path from 'node:path';

import { manifestPath, readJson, recipeHarnessRoot, recipeRuntimeDir, runnerDir } from './paths.ts';
import type { MetaMaskDoctorReport, MetaMaskRecipeAdapter } from './types.ts';

export function repoShape(target: string): Record<string, unknown> {
  const exists = (rel) => fs.existsSync(path.join(target, rel));
  const packageInfo = readPackageInfo(target);
  const extensionProject =
    packageInfo.name === 'metamask-crx' ||
    (exists('app/manifest') && exists('app/scripts') && exists('ui'));
  const mobileProject =
    packageInfo.name === 'metamask' && exists('app/core') && (exists('ios') || exists('android'));
  return {
    packageName: packageInfo.name,
    packageJsonStatus: packageInfo.status,
    packageJsonError: packageInfo.error,
    extensionProject,
    mobileProject,
    agenticService: exists('app/core/AgenticService/AgenticService.ts'),
    mobileProductHarness: false,
    mobileBridgeScript: true,
    extensionRuntime: exists(`${recipeHarnessRoot()}/extension`),
    injectedHarness: exists(`${recipeHarnessRoot()}/mobile`) || exists(`${recipeHarnessRoot()}/extension`),
    walletFixture:
      exists(`${recipeRuntimeDir()}/wallet-fixture.json`),
  };
}

export function compatibilityMode(adapter: MetaMaskRecipeAdapter, target: string) {
  const shape = repoShape(target);
  if (adapter === 'mobile') {
    if (shape.injectedHarness && shape.agenticService) return 'runner bridge with injected app bridge';
    if (shape.agenticService) return 'runner bridge with app bridge';
    return 'runner bridge available; app bridge not installed';
  }
  if (!shape.extensionProject) return 'unsupported/no bridge';
  if (shape.extensionRuntime || shape.injectedHarness) return 'bridge present';
  return 'bridge injectable';
}

function readPackageInfo(target: string) {
  const packageJsonPath = path.join(target, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { status: 'missing', name: null, error: null };
  }
  try {
    const data = readJsonObject(packageJsonPath);
    return {
      status: 'valid',
      name: typeof data.name === 'string' ? data.name : null,
      error: null,
    };
  } catch (error) {
    return {
      status: 'invalid',
      name: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fixtureSummary(target: string): Record<string, unknown> {
  const candidates = [
    `${recipeRuntimeDir()}/wallet-fixture.json`,
  ];
  const rel = candidates.find((candidate) => fs.existsSync(path.join(target, candidate)));
  if (!rel) return { status: 'missing', path: null };
  try {
    const data = readJsonObject(path.join(target, rel));
    return {
      status: Array.isArray(data.accounts) && data.accounts.length > 0 ? 'ready' : 'incomplete',
      path: rel,
      accountCount: Array.isArray(data.accounts) ? data.accounts.length : 0,
      hasPassword: typeof data.password === 'string' && data.password.length > 0,
    };
  } catch (error) {
    return { status: 'invalid', path: rel, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createDoctorReport(
  adapter: MetaMaskRecipeAdapter,
  target: string,
  manifestValidation: { summary?: { errors?: number } & Record<string, unknown> },
  actionManifestPath = manifestPath(adapter),
): MetaMaskDoctorReport {
  const mode = compatibilityMode(adapter, target);
  const manifestErrors = Number(manifestValidation.summary?.errors ?? 0);
  const status = manifestErrors > 0 ? 'fail' : 'pass';
  const checks = [
    {
      id: 'manifest',
      status: manifestErrors === 0 ? 'pass' : 'fail',
      message: manifestErrors === 0 ? 'Action manifest is valid Recipe v1.' : `Action manifest has ${manifestErrors} validation error(s).`,
    },
    {
      id: 'bridge',
      status: mode === 'unsupported/no bridge' ? 'fail' : 'pass',
      message: mode === 'unsupported/no bridge' ? `No ${adapter} bridge is available for this checkout.` : `${adapter} compatibility mode: ${mode}.`,
    },
  ] as const;
  return {
    schemaVersion: 1,
    protocolVersion: 'v1',
    runner_protocol_version: 1,
    status,
    checks: [...checks],
    adapter,
    target,
    runner: {
      name: '@metamask/recipe-runner',
      runnerDir,
      actionManifestPath,
      harnessPackage: '@farmslot/recipe-harness',
    },
    compatibilityMode: mode,
    shape: repoShape(target),
    fixture: fixtureSummary(target),
    manifestValidation: manifestValidation.summary,
  };
}

function readJsonObject(file: string): Record<string, unknown> {
  const value = readJson(file);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected JSON object in ${file}`);
  }
  return value as Record<string, unknown>;
}
