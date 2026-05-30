import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAdapter, withExtensionPage } from '../platform/cdp.mjs';

async function fixturePassword(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'temp/runtime/wallet-fixture.json'),
    path.join(projectRoot, '.agent/wallet-fixture.json'),
    path.join(projectRoot, 'scripts/perps/agentic/wallet-fixture.json'),
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
  throw new Error('No wallet fixture password found for Extension unlock.');
}

runAdapter((input) => withExtensionPage(input, async (page) => {
  const locked = await page.evaluate(`(() => Boolean(document.querySelector('input[type="password"]')))()`);
  if (!locked) {
    return { action: input.action, unlocked: true, alreadyUnlocked: true, proofPath: 'extension-unlocked-state' };
  }

  const password = input.node?.password ?? await fixturePassword(input.context.projectRoot);
  await page.setInput('input[type="password"]', String(password));
  await page.evaluate(`(() => {
    const button = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find((candidate) => /unlock/i.test(candidate.innerText || candidate.textContent || ''));
    if (!button) throw new Error('Unlock button not found.');
    button.click();
  })()`);
  await page.waitForExpression(`!document.querySelector('input[type="password"]')`, { timeoutMs: Number(input.node?.timeout_ms ?? 15000) });
  return { action: input.action, unlocked: true, redacted: true, proofPath: 'extension-password-unlock' };
}));
