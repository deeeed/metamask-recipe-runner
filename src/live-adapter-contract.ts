import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { resolveRequiredLocalFarmslotRoot, runnerDir } from './paths.ts';

function actionFileStem(action: string) {
  return String(action).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function actionParts(action: string) {
  const parts = String(action).split('.').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'metamask') {
    return { family: parts[1], localName: parts.slice(2).join('.') };
  }
  if (parts.length >= 2) {
    return { family: parts[0], localName: parts.slice(1).join('.') };
  }
  return { family: 'actions', localName: String(action) };
}

function candidateStems(action: string) {
  const stem = actionFileStem(action);
  const { localName } = actionParts(action);
  const localStem = actionFileStem(localName);
  const stems = [stem];
  if (localStem && localStem !== stem) stems.push(localStem);
  return stems;
}

function candidateFamilies(action: string) {
  const { family } = actionParts(action);
  const families = [family];
  return [...new Set(families)];
}

function candidatePaths(platform: string, action: string) {
  const stems = candidateStems(action);
  const families = candidateFamilies(action);
  const roots = [
    process.env.METAMASK_RECIPE_LIVE_ADAPTER_DIR,
    path.join(runnerDir, 'live-adapters'),
  ].filter(Boolean);
  const files = [];
  for (const root of roots) {
    for (const family of families) {
      for (const candidateStem of stems) {
        pushCandidateFiles(files, root, platform, family, candidateStem);
      }
      pushDomainDispatcherFiles(files, root, platform, family);
    }
    for (const candidateStem of stems) {
      pushFlatCandidateFiles(files, root, platform, candidateStem);
    }
  }
  return files;
}

function pushCandidateFiles(files: string[], root: string, platform: string, family: string, stem: string) {
  for (const extension of ['mjs', 'js', 'sh']) {
    files.push(path.join(root, platform, family, `${stem}.${extension}`));
    files.push(path.join(root, 'shared', family, `${stem}.${extension}`));
  }
}


function pushDomainDispatcherFiles(files: string[], root: string, platform: string, family: string) {
  for (const extension of ['mjs', 'js', 'sh']) {
    files.push(path.join(root, platform, family, `${family}.${extension}`));
    files.push(path.join(root, 'shared', family, `${family}.${extension}`));
  }
}

function pushFlatCandidateFiles(files: string[], root: string, platform: string, stem: string) {
  for (const extension of ['mjs', 'js', 'sh']) {
    files.push(path.join(root, platform, `${stem}.${extension}`));
    files.push(path.join(root, 'shared', `${stem}.${extension}`));
  }
}

async function firstExecutablePath(paths: string[]) {
  for (const file of paths) {
    try {
      await access(file);
      return file;
    } catch (error) {
      // Try the next candidate path. Missing optional live adapters are reported by the caller.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
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

function commandFor(file: string) {
  if (file.endsWith('.sh')) return { command: 'bash', args: [file] };
  if (file.endsWith('.mjs') || file.endsWith('.js')) {
    if (!importsSourceTypescript(file)) return { command: process.execPath, args: [file] };
  }
  const localTsx = path.join(runnerDir, 'node_modules/.bin/tsx');
  const tsxBin =
    process.env.TSX_BIN ||
    (existsSync(localTsx)
      ? localTsx
      : path.join(
          resolveRequiredLocalFarmslotRoot('TypeScript live adapter execution'),
          'node_modules/.bin/tsx',
        ));
  return { command: tsxBin, args: [file] };
}

function importsSourceTypescript(file: string): boolean {
  return importsSourceTypescriptFrom(file, new Set());
}

function importsSourceTypescriptFrom(file: string, visited: Set<string>): boolean {
  const absolute = path.resolve(file);
  if (visited.has(absolute)) return false;
  visited.add(absolute);
  const source = readFileSync(file, 'utf8');
  const importPattern = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? '';
    if (specifier.endsWith('.ts')) return true;
    if (!specifier.startsWith('.')) continue;
    if (!specifier.endsWith('.mjs') && !specifier.endsWith('.js')) continue;
    if (importsSourceTypescriptFrom(path.resolve(path.dirname(absolute), specifier), visited)) {
      return true;
    }
  }
  return false;
}

export async function resolveLiveAdapter(platform: string, action: string) {
  return firstExecutablePath(candidatePaths(platform, action));
}

export async function runLiveAdapterScript({ platform, action, node, context }: { platform: string; action: string; node: Record<string, any>; context: any }) {
  const script = await resolveLiveAdapter(platform, action);
  if (!script) return null;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'metamask-recipe-live-adapter-'));
  const inputPath = path.join(tempDir, 'input.json');
  const outputPath = path.join(tempDir, 'output.json');
  const input = {
    schemaVersion: 1,
    platform,
    action,
    node,
    context: {
      nodeId: context.nodeId,
      projectRoot: context.projectRoot,
      artifactsDir: context.artifactsDir,
    },
    outputPath,
  };
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const command = commandFor(script);
  const result = await runProcess(command.command, [...command.args, inputPath], {
    cwd: context.projectRoot,
    env: {
      ...process.env,
      ...context.env,
      METAMASK_RECIPE_ADAPTER_INPUT: inputPath,
      METAMASK_RECIPE_ADAPTER_OUTPUT: outputPath,
    },
    timeoutMs: Number(node.live_adapter_timeout_ms ?? node.timeout_ms ?? 60000),
  });
  try {
    if (result.timedOut) {
      throw new Error(`Live adapter ${script} timed out after ${Number(node.live_adapter_timeout_ms ?? node.timeout_ms ?? 60000)}ms.`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`Live adapter ${script} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch (_error) {
      const stdout = result.stdout.trim();
      if (!stdout) throw new Error(`Live adapter ${script} did not write JSON output.`);
      parsed = JSON.parse(stdout);
    }
    return { script, result: parsed };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
