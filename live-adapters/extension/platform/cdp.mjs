import { constants, access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { importFarmslotHarness } from '../../../src/paths.ts';

// Resolve the Farmslot harness through normal package dependencies by default.
// Local Farmslot source is only a dev override handled by src/paths.ts.
const {
  CdpSession,
  CdpWebPage,
  dataTestId,
  extensionIdFromTarget,
  jsonGet,
  retryJsonGet,
  sleep,
} = await importFarmslotHarness();

export { dataTestId };

async function canAccess(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function cdpPort(input) {
  const raw = input.node?.cdp_port ?? process.env.CDP_PORT ?? process.env.RECIPE_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Extension live adapter requires node.cdp_port, CDP_PORT, or RECIPE_CDP_PORT.');
  }
  return port;
}

function extensionTarget(targets, extensionId = null) {
  return (Array.isArray(targets) ? targets : []).find((target) => {
    if (target?.type !== 'page') return false;
    if (!String(target?.url ?? '').startsWith('chrome-extension://')) return false;
    if (!String(target.url).includes('/home.html')) return false;
    if (extensionId && extensionIdFromTarget(target) !== extensionId) return false;
    return Boolean(target.webSocketDebuggerUrl);
  }) ?? null;
}


function resolveRelativeArtifactPath(artifactsDir, relPath) {
  const relative = relPath || 'screenshots/extension-page.png';
  if (path.isAbsolute(relative) || relative.split(/[\/]+/).includes('..')) {
    throw new Error(`Refusing Extension screenshot artifact path outside artifacts dir: ${relative}`);
  }
  const normalized = path.normalize(relative);
  const absolute = path.resolve(artifactsDir, normalized);
  const artifactsRoot = path.resolve(artifactsDir);
  if (absolute !== artifactsRoot && !absolute.startsWith(`${artifactsRoot}${path.sep}`)) {
    throw new Error(`Refusing Extension screenshot artifact path outside artifacts dir: ${relative}`);
  }
  return { relative: normalized, absolute };
}

function isCaptureScreenshotFailure(error) {
  const message = String(error?.message ?? error);
  return message.includes('Page.captureScreenshot') || message.includes('captureScreenshot');
}


async function captureDomRasterFallback(page, context, relPath, metadata, cause) {
  const { relative, absolute } = resolveRelativeArtifactPath(context.artifactsDir, relPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  // Use a fresh CDP session for the fallback. A timed-out Page.captureScreenshot
  // can leave the original session with an in-flight command, which makes a
  // subsequent Runtime.evaluate fallback unreliable even though the page is
  // still controllable.
  const session = await CdpSession.connect(page.target.webSocketDebuggerUrl);
  try {
    await session.call('Runtime.enable');
    const result = await session.call('Runtime.evaluate', {
      expression: `(() => new Promise((resolve, reject) => {
        try {
          const width = Math.max(320, Math.min(900, window.innerWidth || document.documentElement.clientWidth || 500));
          const height = Math.max(500, Math.min(1200, window.innerHeight || document.documentElement.clientHeight || 700));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context2d = canvas.getContext('2d');
          if (!context2d) throw new Error('DOM raster canvas context unavailable.');

          const transparent = (color) => !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
          const htmlStyle = getComputedStyle(document.documentElement);
          const bodyStyle = document.body ? getComputedStyle(document.body) : htmlStyle;
          context2d.fillStyle = transparent(bodyStyle.backgroundColor)
            ? (transparent(htmlStyle.backgroundColor) ? '#000' : htmlStyle.backgroundColor)
            : bodyStyle.backgroundColor;
          context2d.fillRect(0, 0, width, height);

          const elements = Array.from(document.querySelectorAll('body, body *'));
          const visibleEntries = [];
          for (const element of elements) {
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.right < 0 || rect.bottom < 0 || rect.left > width || rect.top > height) continue;
            visibleEntries.push({ element, style, rect });
          }

          const clampRect = (rect) => ({
            x: Math.max(0, rect.left),
            y: Math.max(0, rect.top),
            width: Math.min(width, rect.right) - Math.max(0, rect.left),
            height: Math.min(height, rect.bottom) - Math.max(0, rect.top),
          });

          for (const entry of visibleEntries) {
            const { style, rect } = entry;
            const box = clampRect(rect);
            if (box.width <= 0 || box.height <= 0) continue;
            if (!transparent(style.backgroundColor)) {
              context2d.globalAlpha = Math.max(0, Math.min(1, Number(style.opacity) || 1));
              context2d.fillStyle = style.backgroundColor;
              context2d.fillRect(box.x, box.y, box.width, box.height);
              context2d.globalAlpha = 1;
            }
            const borderColor = style.borderTopColor;
            const borderWidth = Number.parseFloat(style.borderTopWidth || '0');
            if (borderWidth > 0 && !transparent(borderColor)) {
              context2d.strokeStyle = borderColor;
              context2d.lineWidth = Math.min(borderWidth, 4);
              context2d.strokeRect(box.x, box.y, box.width, box.height);
            }
          }

          const directText = (element) => Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || '')
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim();
          const elementText = (element) => {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              return element.value || element.placeholder || element.getAttribute('aria-label') || '';
            }
            const tag = element.tagName.toLowerCase();
            const direct = directText(element);
            if (direct) return direct;
            if (tag === 'button' || element.getAttribute('role') === 'button' || element.dataset?.testid) {
              return (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
            }
            return element.getAttribute('aria-label') || '';
          };
          const drawText = (text, box, style) => {
            if (!text || box.width < 6 || box.height < 6) return;
            const fontSize = Math.max(8, Math.min(28, Number.parseFloat(style.fontSize || '12') || 12));
            context2d.font = [style.fontStyle, style.fontWeight, fontSize + 'px', style.fontFamily || 'sans-serif'].filter(Boolean).join(' ');
            context2d.fillStyle = transparent(style.color) ? '#fff' : style.color;
            context2d.textBaseline = 'top';
            const words = text.split(/\\s+/).filter(Boolean);
            const lineHeight = Math.ceil(fontSize * 1.25);
            let line = '';
            let y = box.y + Math.max(2, Math.min(8, box.height * 0.12));
            const x = box.x + Math.max(2, Math.min(10, box.width * 0.04));
            const maxWidth = Math.max(12, box.width - (x - box.x) * 2);
            const maxY = box.y + box.height - lineHeight;
            for (const word of words) {
              const candidate = line ? line + ' ' + word : word;
              if (context2d.measureText(candidate).width > maxWidth && line) {
                context2d.fillText(line, x, y, maxWidth);
                y += lineHeight;
                line = word;
                if (y > maxY) break;
              } else {
                line = candidate;
              }
            }
            if (line && y <= maxY + 1) context2d.fillText(line, x, y, maxWidth);
          };

          for (const entry of visibleEntries) {
            const box = clampRect(entry.rect);
            const text = elementText(entry.element);
            if (!text) continue;
            drawText(text, box, entry.style);
          }

          resolve({ data: canvas.toDataURL('image/png'), width, height });
        } catch (error) {
          reject(error);
        }
      }))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'DOM raster screenshot fallback failed.',
      );
    }
    const dataUrl = result.result?.value?.data;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('DOM raster screenshot fallback did not return PNG data.');
    }
    await writeFile(absolute, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    return {
      path: relative,
      type: 'screenshot',
      nodeId: context.nodeId,
      label: metadata?.label ?? `${context.nodeId} screenshot`,
      category: metadata?.category ?? 'evidence',
      metadata: {
        fallback: 'extension-dom-raster',
        cdpFailure: String(cause?.message ?? cause),
        width: result.result.value.width,
        height: result.result.value.height,
      },
    };
  } finally {
    session.close();
  }
}

async function captureMacScreenFallback(context, relPath, metadata, cause) {
  if (process.platform !== 'darwin') throw cause;
  const { relative, absolute } = resolveRelativeArtifactPath(context.artifactsDir, relPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const result = await runProcess('screencapture', ['-x', absolute], {
    cwd: context.projectRoot,
    env: process.env,
    timeoutMs: Number(metadata?.timeoutMs ?? 30000),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `CDP Page.captureScreenshot failed (${String(cause?.message ?? cause)}), and macOS screencapture fallback failed: ${result.stderr || result.stdout}`,
    );
  }
  return {
    path: relative,
    type: 'screenshot',
    nodeId: context.nodeId,
    label: metadata?.label ?? `${context.nodeId} screenshot`,
    category: metadata?.category ?? 'evidence',
    metadata: {
      fallback: 'macos-screencapture',
      cdpFailure: String(cause?.message ?? cause),
    },
  };
}

function autolaunchEnabled(input) {
  return input.node?.launch_existing_dist === true ||
    input.node?.autolaunch === true ||
    process.env.METAMASK_RECIPE_EXTENSION_AUTOLAUNCH === '1' ||
    process.env.METAMASK_RECIPE_EXTENSION_LAUNCH_EXISTING_DIST === '1';
}

function projectRequire(projectRoot) {
  return createRequire(path.join(projectRoot, 'package.json'));
}

function resolveChromeBinary(projectRoot) {
  if (process.env.RECIPE_HARNESS_CHROME_BIN) return process.env.RECIPE_HARNESS_CHROME_BIN;
  const requireFromProject = projectRequire(projectRoot);
  for (const packageName of ['@playwright/test', 'playwright']) {
    try {
      const { chromium } = requireFromProject(packageName);
      const executable = chromium.executablePath();
      if (executable) return executable;
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
  }
  throw new Error('Extension autolaunch requires RECIPE_HARNESS_CHROME_BIN or Playwright installed in the target checkout.');
}

async function execNodeScript(script, args, options) {
  const result = await runProcess(process.execPath, [script, ...args], options);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: node ${script} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function findWalletFixture(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'temp/runtime/wallet-fixture.json'),
    path.join(projectRoot, '.agent/wallet-fixture.json'),
    path.join(projectRoot, 'scripts/perps/agentic/wallet-fixture.json'),
  ];
  for (const candidate of candidates) {
    if (await canAccess(candidate)) return candidate;
  }
  return null;
}

async function launchExistingDistRuntime(input, port) {
  const projectRoot = input.context.projectRoot;
  const artifactsDir = input.context.artifactsDir;
  const distDir = path.resolve(projectRoot, input.node?.dist_dir || process.env.METAMASK_RECIPE_EXTENSION_DIST_DIR || 'dist/chrome');
  const distManifest = path.join(distDir, 'manifest.json');
  if (!(await canAccess(distManifest))) {
    throw new Error(`Extension autolaunch requires an existing built dist with manifest.json: ${distManifest}`);
  }

  const runtimeRoot = path.join(artifactsDir, 'extension-runtime');
  const runtimeDist = path.join(runtimeRoot, 'runtime-dist');
  const profileDir = path.resolve(process.env.METAMASK_RECIPE_EXTENSION_PROFILE_DIR || path.join(runtimeRoot, 'chrome-profile'));
  const logsDir = path.join(runtimeRoot, 'logs');
  await mkdir(logsDir, { recursive: true });
  await rm(runtimeDist, { recursive: true, force: true });
  await mkdir(runtimeDist, { recursive: true });
  await cp(distDir, runtimeDist, { recursive: true, force: true, filter: (source) => !source.endsWith(`${path.sep}_metadata`) });
  await mkdir(profileDir, { recursive: true });

  const fixtureScript = path.join(projectRoot, '.agent/recipe-harness/extension/scripts/wallet-fixture-state.cjs');
  const fixture = await findWalletFixture(projectRoot);
  const extensionIdFile = path.join(projectRoot, 'temp/runtime/extension.id');
  const fixtureState = path.join(runtimeRoot, 'fixture-state.json');
  let fixtureSeeded = false;
  if (fixture && await canAccess(fixtureScript)) {
    await execNodeScript(fixtureScript, ['generate', '--target', projectRoot, '--fixture', fixture, '--out', fixtureState], { cwd: projectRoot });
    await execNodeScript(fixtureScript, ['prefill-profile', '--target', projectRoot, '--state', fixtureState, '--profile', profileDir, '--extension-dir', runtimeDist, '--extension-id-file', extensionIdFile], { cwd: projectRoot });
    fixtureSeeded = true;
  }

  const chrome = resolveChromeBinary(projectRoot);
  const stdoutFd = openSync(path.join(logsDir, 'chrome.log'), 'a');
  const stderrFd = openSync(path.join(logsDir, 'chrome.log'), 'a');
  let child;
  try {
    child = spawn(chrome, [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--disable-first-run-ui',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-extensions-file-access-check',
      '--disable-extensions-content-verification',
      '--disable-features=ExtensionContentVerification,DisableLoadExtensionCommandLineSwitch',
      `--disable-extensions-except=${runtimeDist}`,
      `--load-extension=${runtimeDist}`,
      'chrome://extensions/',
    ], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        BUNDLED_DEBUGPY_PATH: undefined,
        PYTHONHOME: undefined,
        PYTHONPATH: undefined,
        DYLD_LIBRARY_PATH: undefined,
        DYLD_FALLBACK_LIBRARY_PATH: undefined,
        DYLD_INSERT_LIBRARIES: undefined,
      },
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  child.unref();
  await writeFile(path.join(logsDir, 'chrome.pid'), `${child.pid}\n`);
  await retryJsonGet(`http://127.0.0.1:${port}/json/version`, 45000);

  let fixtureValidation = null;
  if (fixtureSeeded) {
    fixtureValidation = path.join(logsDir, 'fixture-account-parity.json');
    await execNodeScript(
      fixtureScript,
      [
        'seed-cdp',
        '--target',
        projectRoot,
        '--fixture',
        fixture,
        '--state',
        fixtureState,
        '--cdp-port',
        String(port),
        '--extension-dir',
        runtimeDist,
        '--extension-id-file',
        extensionIdFile,
        '--out',
        fixtureValidation,
      ],
      { cwd: projectRoot },
    );
  }

  await writeFile(path.join(runtimeRoot, 'runtime.json'), `${JSON.stringify({
    port,
    pid: child.pid,
    projectRoot,
    distDir,
    runtimeDist,
    profileDir,
    fixtureSeeded,
    fixtureValidation,
    launchedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { launched: true, pid: child.pid, runtimeRoot, fixtureSeeded };
}

async function extensionIdFromFile(projectRoot) {
  const extensionIdFile = path.join(projectRoot, 'temp/runtime/extension.id');
  if (!(await canAccess(extensionIdFile))) return null;
  const id = (await readFile(extensionIdFile, 'utf8')).trim();
  return /^[a-z]{32}$/u.test(id) ? id : null;
}

function extensionIdFromAnyTarget(targets) {
  for (const target of Array.isArray(targets) ? targets : []) {
    try {
      return extensionIdFromTarget(target);
    } catch (error) {
      if (String(error?.message ?? '').startsWith('Could not derive extension ID')) continue;
      throw error;
    }
  }
  return null;
}

async function openExtensionHomePage(port, extensionId) {
  const url = `chrome-extension://${extensionId}/home.html`;
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(endpoint, { method: 'PUT' });
  if (response.status === 405 || response.status === 404) {
    response = await fetch(endpoint);
  }
  if (!response.ok) {
    throw new Error(`Failed to open extension home page ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function ensureExtensionTarget(input, port) {
  let launch = null;
  try {
    const targets = await jsonGet(`http://127.0.0.1:${port}/json/list`);
    const expectedExtensionId = await extensionIdFromFile(input.context.projectRoot);
    const target =
      (expectedExtensionId ? extensionTarget(Array.isArray(targets) ? targets : [], expectedExtensionId) : null) ??
      extensionTarget(Array.isArray(targets) ? targets : []);
    if (target?.webSocketDebuggerUrl) return { target, launch };
  } catch (error) {
    if (!autolaunchEnabled(input)) throw error;
  }
  if (!autolaunchEnabled(input)) {
    throw new Error(`No extension page target found on CDP port ${port}. Launch the extension runtime first, or set METAMASK_RECIPE_EXTENSION_AUTOLAUNCH=1 to launch an existing dist/chrome.`);
  }
  launch = await launchExistingDistRuntime(input, port);
  let targets = await retryJsonGet(`http://127.0.0.1:${port}/json/list`, 45000);
  const expectedExtensionId = await extensionIdFromFile(input.context.projectRoot);
  let target = expectedExtensionId ? extensionTarget(Array.isArray(targets) ? targets : [], expectedExtensionId) : null;
  if (!target?.webSocketDebuggerUrl) {
    const extensionId =
      expectedExtensionId ??
      extensionIdFromAnyTarget(Array.isArray(targets) ? targets : []);
    if (!extensionId) {
      throw new Error(`Autolaunch started Chrome on CDP port ${port}, but no extension ID could be derived from CDP targets or temp/runtime/extension.id.`);
    }
    await openExtensionHomePage(port, extensionId);
    targets = await retryJsonGet(`http://127.0.0.1:${port}/json/list`, 15000);
    target = extensionTarget(Array.isArray(targets) ? targets : [], extensionId);
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`Autolaunch started Chrome on CDP port ${port}, but no extension page target was found.`);
  }
  return { target, launch };
}

export async function loadInput() {
  const inputPath = process.argv[2] || process.env.METAMASK_RECIPE_ADAPTER_INPUT;
  if (!inputPath) throw new Error('Missing live adapter input path.');
  return JSON.parse(await readFile(inputPath, 'utf8'));
}

export async function writeOutput(input, output) {
  await writeFile(input.outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

export async function withExtensionPage(input, callback) {
  const port = cdpPort(input);
  const { target, launch } = await ensureExtensionTarget(input, port);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    const extensionId = extensionIdFromTarget(target);
    const origin = `chrome-extension://${extensionId}`;
    const page = new ExtensionPage(session, origin, target, port);
    await session.call('Runtime.enable');
    await session.call('Page.enable');
    const result = await callback(page);
    return { ...result, cdpPort: port, targetUrl: target.url, runtimeLaunch: launch };
  } finally {
    session.close();
  }
}

export class ExtensionPage extends CdpWebPage {
  constructor(session, origin, target, port) {
    super(session);
    this.origin = origin;
    this.target = target;
    this.port = port;
  }

  async navigateHash(hash) {
    const normalizedHash = String(hash || '').startsWith('#') ? hash : `#${hash || '/'}`;
    const href = `${this.origin}/home.html${normalizedHash}`;
    return this.navigate(href);
  }

  async readPositions() {
    return this.evaluate(`(async () => {
      const request = globalThis.stateHooks?.submitRequestToBackground;
      const manager = globalThis.stateHooks?.getPerpsStreamManager?.();
      const cached = manager?.positions?.cache;
      if (typeof request === 'function') {
        const result = await Promise.race([
          request('perpsGetPositions', []).then((positions) => ({ ok: true, positions })),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 5000)),
        ]);
        if (result.ok && Array.isArray(result.positions)) {
          return { available: true, source: 'background-perpsGetPositions', positions: result.positions };
        }
      }
      return {
        available: Array.isArray(cached),
        source: 'perps-stream-manager-cache',
        initialized: Boolean(manager?.isInitialized?.()),
        connected: Boolean(manager?.positions?.isConnected),
        positions: Array.isArray(cached) ? cached : [],
      };
    })()`);
  }

  async screenshot(contextOrInput, relPath, metadata = {}) {
    if (contextOrInput?.context) {
      const options = {
        label: contextOrInput.node?.description || `${contextOrInput.action} screenshot`,
        category: 'evidence',
        timeoutMs: contextOrInput.node?.timeout_ms,
        ...metadata,
      };
      if (contextOrInput.node?.screenshot_mode === 'dom_raster' || process.env.METAMASK_RECIPE_EXTENSION_SCREENSHOT_MODE === 'dom-raster') {
        return captureDomRasterFallback(
          this,
          contextOrInput.context,
          relPath,
          options,
          new Error('Page.captureScreenshot skipped for requested DOM raster capture.'),
        );
      }
      try {
        return await super.screenshot(contextOrInput.context, relPath, options);
      } catch (error) {
        if (!isCaptureScreenshotFailure(error)) throw error;
        try {
          return await captureDomRasterFallback(this, contextOrInput.context, relPath, options, error);
        } catch (fallbackError) {
          if (!isCaptureScreenshotFailure(fallbackError)) {
            return captureMacScreenFallback(contextOrInput.context, relPath, options, fallbackError);
          }
          return captureMacScreenFallback(contextOrInput.context, relPath, options, error);
        }
      }
    }
    if (process.env.METAMASK_RECIPE_EXTENSION_SCREENSHOT_MODE === 'dom-raster') {
      return captureDomRasterFallback(
        this,
        contextOrInput,
        relPath,
        metadata,
        new Error('Page.captureScreenshot skipped for requested DOM raster capture.'),
      );
    }
    try {
      return await super.screenshot(contextOrInput, relPath, metadata);
    } catch (error) {
      if (!isCaptureScreenshotFailure(error)) throw error;
      try {
        return await captureDomRasterFallback(this, contextOrInput, relPath, metadata, error);
      } catch (fallbackError) {
        if (!isCaptureScreenshotFailure(fallbackError)) {
          return captureMacScreenFallback(contextOrInput, relPath, metadata, fallbackError);
        }
        return captureMacScreenFallback(contextOrInput, relPath, metadata, error);
      }
    }
  }
}

export function marketSymbol(input) {
  return normalizeMarketSymbol(input.node?.market ?? input.node?.symbol ?? 'BTC');
}

export function normalizeMarketSymbol(rawSymbol) {
  const raw = String(rawSymbol);
  if (raw.includes(':')) {
    const [source, ...symbolParts] = raw.split(':');
    return `${source.toLowerCase()}:${symbolParts.join(':').toUpperCase()}`;
  }
  return raw.toUpperCase();
}

export async function runAdapter(callback) {
  const input = await loadInput();
  const output = await callback(input);
  await writeOutput(input, output);
}
