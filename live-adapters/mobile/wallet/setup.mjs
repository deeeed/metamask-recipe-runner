import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeCommand, bridgeEnv, runAdapter } from '../platform/bridge.mjs';
import { walletFixturePath } from '../../../src/paths.ts';

async function fixtureProfile(projectRoot) {
  const candidates = [
    walletFixturePath(projectRoot),
  ];
  for (const candidate of candidates) {
    try {
      const fixture = JSON.parse(await readFile(candidate, 'utf8'));
      if (
        typeof fixture.password !== 'string' ||
        fixture.password.length === 0
      ) {
        throw new Error(
          `Mobile wallet fixture ${path.relative(projectRoot, candidate)} is missing password.`,
        );
      }
      if (!Array.isArray(fixture.accounts) || fixture.accounts.length === 0) {
        throw new Error(
          `Mobile wallet fixture ${path.relative(projectRoot, candidate)} must define at least one account.`,
        );
      }
      const expectedEvmAccounts = validateFixtureAccounts(
        fixture.accounts,
        path.relative(projectRoot, candidate),
      );
      return {
        absolutePath: candidate,
        path: path.relative(projectRoot, candidate),
        password: fixture.password,
        accounts: fixture.accounts.length,
        expectedEvmAccounts,
        hasPassword: true,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('No wallet fixture found for Mobile setup.');
}

function validateFixtureAccounts(accounts, fixturePath) {
  return accounts.reduce((total, account, index) => {
    if (!account || typeof account !== 'object') {
      throw new Error(`${fixturePath} accounts[${index}] must be an object.`);
    }
    if (account.type !== 'mnemonic' && account.type !== 'privateKey') {
      throw new Error(
        `${fixturePath} accounts[${index}].type must be mnemonic or privateKey.`,
      );
    }
    if (typeof account.value !== 'string' || account.value.length === 0) {
      throw new Error(
        `${fixturePath} accounts[${index}].value must be a non-empty string.`,
      );
    }
    if (account.type === 'mnemonic')
      return total + mnemonicAccountCount(account, fixturePath, index);
    return total + 1;
  }, 0);
}

function mnemonicAccountCount(account, fixturePath, index) {
  const raw = account.count ?? account.numberOfAccounts ?? 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error(
      `${fixturePath} accounts[${index}] mnemonic count must be an integer from 1 through 100.`,
    );
  }
  return count;
}

function selectedStatus(status, input) {
  if (!Array.isArray(status)) {
    return status && typeof status === 'object' ? status : null;
  }
  const preferredDevices = [
    input.node?.ios_simulator,
    input.node?.simulator,
    input.node?.android_device,
    input.node?.adb_serial,
    process.env.IOS_SIMULATOR,
    process.env.ANDROID_DEVICE,
    process.env.ADB_SERIAL,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const preferredDevice of preferredDevices) {
    const match = status.find((entry) => entry?.deviceName === preferredDevice);
    if (match) return match;
  }
  return (
    status.find((entry) => entry?.account) ??
    status.find((entry) => entry && typeof entry === 'object') ??
    null
  );
}

function hasSelectedAccount(status, input) {
  return Boolean(selectedStatus(status, input)?.account);
}

function setupWalletScript() {
  if (process.env.METAMASK_RECIPE_MOBILE_SETUP_WALLET_SCRIPT) {
    return process.env.METAMASK_RECIPE_MOBILE_SETUP_WALLET_SCRIPT;
  }
  return fileURLToPath(new URL('../bridge-runtime/setup-wallet.sh', import.meta.url));
}

function runSetupWallet(input, fixture) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(
      input.node?.setup_timeout_ms ?? input.node?.timeout_ms ?? 120000,
    );
    const child = spawn(
      'bash',
      [setupWalletScript(), '--fixture', fixture.absolutePath],
      {
        cwd: input.context.projectRoot,
        env: { ...bridgeEnv(input), CDP_TIMEOUT: String(timeoutMs), APP_ROOT: input.context.projectRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!child.killed) child.kill('SIGKILL');
            }, 1000);
            reject(
              new Error(
                `Mobile setup-wallet.sh timed out after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs)
        : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitCode !== 0) {
        reject(
          new Error(
            `Mobile setup-wallet.sh exited ${exitCode}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function verifiedStatus(input, password) {
  const before = await bridgeCommand(input, ['status']);
  if (hasSelectedAccount(before, input))
    return { status: before, unlockedDuringSetup: false };

  await bridgeCommand(input, ['unlock', String(password)]);
  const after = await bridgeCommand(input, ['status']);
  if (!hasSelectedAccount(after, input)) {
    throw new Error(
      `Mobile wallet setup did not expose a selected account after unlock; status=${JSON.stringify(after)}`,
    );
  }
  return { status: after, unlockedDuringSetup: true };
}

runAdapter(async (input) => {
  const fixture = await fixtureProfile(input.context.projectRoot);
  const setupResult = await runSetupWallet(input, fixture);
  const runtime = await verifiedStatus(input, fixture.password);
  return {
    action: input.action,
    setup: 'preseeded-mobile-fixture-verified',
    fixture: {
      path: fixture.path,
      accounts: fixture.accounts,
      expectedEvmAccounts: fixture.expectedEvmAccounts,
      hasPassword: fixture.hasPassword,
    },
    runtimeState: selectedStatus(runtime.status, input),
    unlockedDuringSetup: runtime.unlockedDuringSetup,
    setupWalletProof: summarizeSetupOutput(setupResult.stdout),
    proofPath: 'mobile-fixture-profile',
  };
});

function summarizeSetupOutput(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .filter((line) =>
      /^(Fixture OK|=== Wallet Ready ===|Route:|Unlocked:|Accounts:|Selected:)/.test(
        line,
      ),
    );
}
