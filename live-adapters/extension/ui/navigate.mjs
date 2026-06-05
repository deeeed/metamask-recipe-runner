import { runAdapter, withExtensionPage } from '../platform/cdp.mjs';

const PAGE_HASHES = {
  home: '#/',
  perps: '#/?tab=perps',
};

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pageHash(node) {
  const page = text(node?.page);
  if (!page) return undefined;
  if (PAGE_HASHES[page]) return { page, hash: PAGE_HASHES[page] };
  if (page === 'perps-market') {
    const market = text(node.market) ?? text(node.symbol);
    if (!market) throw new Error('extension ui.navigate page=perps-market requires market or symbol.');
    return { page, hash: `#/perps/market/${encodeURIComponent(market)}` };
  }
  throw new Error('extension ui.navigate supported page aliases: home, perps, perps-market.');
}

runAdapter((input) => withExtensionPage(input, async (page) => {
  const alias = pageHash(input.node);
  if (alias) {
    const navigation = await page.navigateHash(alias.hash);
    return { action: input.action, ...alias, navigation, proofPath: 'ui-navigation' };
  }

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

  throw new Error('extension ui.navigate requires page, raw extension url, hash, or path.');
}));
