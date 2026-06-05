import { navigate, runAdapter } from '../platform/bridge.mjs';

const PAGE_ROUTES = {
  home: { route: 'WalletView', params: {} },
  perps: { route: 'PerpsMarketListView', params: {} },
};

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pageRoute(node) {
  const page = text(node?.page);
  if (!page) return undefined;
  if (PAGE_ROUTES[page]) return { page, ...PAGE_ROUTES[page] };
  if (page === 'perps-market') {
    const market = text(node.market) ?? text(node.symbol) ?? text(node.params?.market?.symbol);
    if (!market) throw new Error('mobile ui.navigate page=perps-market requires market or symbol.');
    return { page, route: 'PerpsMarketDetails', params: { market: { symbol: market } } };
  }
  throw new Error('mobile ui.navigate supported page aliases: home, perps, perps-market.');
}

runAdapter(async (input) => {
  const alias = pageRoute(input.node);
  if (alias) {
    const navigation = await navigate(input, alias.route, alias.params);
    return { action: input.action, ...alias, navigation, proofPath: 'agentic-navigation' };
  }

  const route = input.node?.route ?? input.node?.screen;
  if (typeof route !== 'string' || route.length === 0) {
    throw new Error('mobile ui.navigate requires page or a raw React Navigation route in node.route or node.screen.');
  }
  const params = input.node?.params && typeof input.node.params === 'object' ? input.node.params : {};
  const navigation = await navigate(input, route, params);
  return { action: input.action, route, params, navigation, proofPath: 'agentic-navigation' };
});
