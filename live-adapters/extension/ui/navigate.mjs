import { runAdapter, withExtensionPage } from '../platform/cdp.mjs';

runAdapter((input) => withExtensionPage(input, async (page) => {
  const url = input.node?.url;
  if (typeof url === 'string' && url.length > 0) {
    const navigation = await page.navigate(url);
    return { action: input.action, url, navigation, proofPath: 'ui-navigation' };
  }

  const hash = input.node?.hash ?? input.node?.path;
  if (typeof hash === 'string' && hash.length > 0) {
    const navigation = await page.navigateHash(hash);
    return { action: input.action, hash, navigation, proofPath: 'ui-navigation' };
  }

  throw new Error('extension ui.navigate requires a raw extension url, hash, or path.');
}));
