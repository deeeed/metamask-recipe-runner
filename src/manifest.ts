import path from 'node:path';

import type { RecipeActionManifestDocument, RecipeValidationResult } from '@farmslot/protocol';

import { manifestPath, readJson, importFarmslotProtocol } from './paths.ts';
import type { MetaMaskRecipeAdapter } from './types.ts';

export function loadMetaMaskMobileActionManifest(): RecipeActionManifestDocument {
  return asActionManifest(readJson(manifestPath('mobile')));
}

export function loadMetaMaskExtensionActionManifest(): RecipeActionManifestDocument {
  return asActionManifest(readJson(manifestPath('extension')));
}

export function loadActionManifest(
  adapter: MetaMaskRecipeAdapter,
  overridePath?: string,
): RecipeActionManifestDocument {
  if (overridePath) return asActionManifest(readJson(path.resolve(overridePath)));
  return adapter === 'mobile'
    ? loadMetaMaskMobileActionManifest()
    : loadMetaMaskExtensionActionManifest();
}

export async function validateManifest(
  manifest: RecipeActionManifestDocument,
): Promise<RecipeValidationResult> {
  const { validateRecipeActionManifestDocument } = await importFarmslotProtocol();
  const result = validateRecipeActionManifestDocument(manifest);
  if (result.status === 'invalid') {
    throw new Error(
      `Manifest invalid: ${result.findings
        .map((finding) => `${finding.code} ${finding.path}`)
        .join(', ')}`,
    );
  }
  return result;
}

function asActionManifest(value: unknown): RecipeActionManifestDocument {
  return value as RecipeActionManifestDocument;
}
