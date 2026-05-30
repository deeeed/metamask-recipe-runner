import type { RecipeActionManifestDocument, RecipeCompatibilityResult } from '@farmslot/protocol';

export type MetaMaskRecipeAdapter = 'mobile' | 'extension';

export interface CreateMetaMaskRunnerOptions {
  actionManifest?: RecipeActionManifestDocument;
}

export type FarmslotHarnessModule = typeof import('@farmslot/recipe-harness');
export type FarmslotProtocolModule = typeof import('@farmslot/protocol');

export interface MetaMaskDoctorReport {
  schemaVersion: 1;
  protocolVersion: 'v1';
  runner_protocol_version: 1;
  status: 'pass' | 'fail';
  checks: Array<{ id: string; status: 'pass' | 'fail'; message: string }>;
  adapter: MetaMaskRecipeAdapter;
  target: string;
  compatibilityMode:
    | 'bridge present'
    | 'bridge injectable'
    | 'product-local harness present'
    | 'unsupported/no bridge';
  runner: {
    name: '@metamask/recipe-runner';
    runnerDir: string;
    actionManifestPath: string;
    harnessPackage: '@farmslot/recipe-harness';
  };
  shape: Record<string, unknown>;
  fixture: Record<string, unknown>;
  manifestValidation: RecipeCompatibilityResult['summary'] | Record<string, unknown>;
}
