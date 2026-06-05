import { readFile } from 'node:fs/promises';
import { bridgeCommand, runAdapter } from '../platform/bridge.mjs';
import { walletFixturePath } from '../../../src/paths.ts';

async function fixturePassword(projectRoot) {
  const candidates = [
    walletFixturePath(projectRoot),
  ];
  for (const candidate of candidates) {
    try {
      const fixture = JSON.parse(await readFile(candidate, 'utf8'));
      if (fixture.password) return fixture.password;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('No wallet fixture password found for Mobile unlock.');
}

function selectedAccount(status, input) {
  return selectedStatus(status, input)?.account ?? null;
}

function routeName(status, input) {
  const route = selectedStatus(status, input)?.route ?? null;
  return route && typeof route === 'object' ? String(route.name ?? '') : '';
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

async function status(input) {
  return bridgeCommand(input, ['status']);
}

async function waitForUnlocked(input, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await status(input);
    if (selectedAccount(last, input) && routeName(last, input) !== 'Login') return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Mobile wallet unlock; last status was ${JSON.stringify(last)}`);
}

runAdapter(async (input) => {
  const before = await status(input);
  if (selectedAccount(before, input) && routeName(before, input) !== 'Login') {
    return {
      action: input.action,
      unlocked: true,
      alreadyUnlocked: true,
      account: selectedAccount(before, input),
      redacted: true,
      proofPath: 'agentic-wallet-status',
    };
  }

  const password = input.node?.password ?? await fixturePassword(input.context.projectRoot);
  try {
    const result = await bridgeCommand(input, ['unlock', String(password)]);
    const after = await waitForUnlocked(input, Number(input.node?.unlock_timeout_ms ?? 15000));
    return {
      action: input.action,
      unlocked: Boolean(result?.ok ?? result?.unlocked ?? true),
      account: selectedAccount(after, input),
      route: selectedStatus(after, input)?.route ?? null,
      redacted: true,
      proofPath: 'agentic-wallet-unlock',
    };
  } catch (error) {
    if (!String(error?.message ?? error).includes('login-password-input not found')) throw error;
    const after = await status(input);
    if (!selectedAccount(after, input) || routeName(after, input) === 'Login') throw error;
    return {
      action: input.action,
      unlocked: true,
      alreadyUnlocked: true,
      account: selectedAccount(after, input),
      redacted: true,
      proofPath: 'agentic-wallet-status-after-missing-login-input',
    };
  }
});
