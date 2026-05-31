import { pathToFileURL } from 'node:url';
import { dataTestId, marketSymbol, normalizeMarketSymbol, runAdapter, withExtensionPage } from '../platform/cdp.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function symbolForItem(item) {
  return normalizeMarketSymbol(item?.coin ?? item?.symbol ?? '');
}

function sideForItem(item) {
  return String(item?.side ?? item?.direction ?? '').toLowerCase();
}

function uniqueSymbols(symbols) {
  return Array.from(new Set(symbols.filter(Boolean)));
}

function configuredSymbols(input, items) {
  const selector = input.node?.selector && typeof input.node.selector === 'object' ? input.node.selector : {};
  const mode = String(input.node?.mode ?? selector.mode ?? 'matching').toLowerCase();
  if (mode === 'all') return uniqueSymbols(items.map(symbolForItem).filter(Boolean));
  const explicit = input.node?.markets ?? input.node?.symbols ?? selector.markets ?? selector.symbols;
  if (Array.isArray(explicit) && explicit.length > 0) return uniqueSymbols(explicit.map(normalizeMarketSymbol));
  if (typeof explicit === 'string' && explicit.length > 0) return uniqueSymbols(explicit.split(',').map((part) => normalizeMarketSymbol(part.trim())).filter(Boolean));
  return [marketSymbol(input)];
}

function selectedItems(input, items) {
  const symbols = new Set(configuredSymbols(input, items));
  const selector = input.node?.selector && typeof input.node.selector === 'object' ? input.node.selector : {};
  const side = input.node?.side ?? selector.side;
  return items.filter((item) => {
    if (!symbols.has(symbolForItem(item))) return false;
    if (side && sideForItem(item) && sideForItem(item) !== String(side).toLowerCase()) return false;
    return true;
  });
}

export async function navigatePerps(input) {
  const selected = String(input.node?.target ?? input.node?.destination ?? (input.node?.market || input.node?.symbol ? 'market' : 'home')).toLowerCase();
  return withExtensionPage(input, async (page) => {
    if (selected === 'home' || selected === 'perps' || selected === 'perps_home') {
      const navigation = await page.navigateHash('#/?tab=perps');
      await page.waitForExpression('document.body && document.body.innerText.includes("Perps")', { timeoutMs: 15000 });
      return { action: input.action, target: selected, navigation, proofPath: 'ui-navigation' };
    }
    const symbol = marketSymbol(input);
    if (selected === 'market' || selected === 'market_details') {
      const encodedSymbol = encodeURIComponent(symbol);
      const navigation = await page.navigateHash(`#/perps/market/${encodedSymbol}`);
      await page.waitForExpression(`location.hash.includes(${JSON.stringify(`/perps/market/${encodedSymbol}`)})`, { timeoutMs: 15000 });
      return { action: input.action, target: selected, market: symbol, navigation, proofPath: 'ui-navigation' };
    }
    if (selected === 'trade' || selected === 'order') {
      const side = String(input.node?.side ?? 'long').toLowerCase();
      const navigation = await page.navigateHash(`#/perps/trade/${encodeURIComponent(symbol)}?direction=${encodeURIComponent(side)}&mode=new`);
      await page.waitForSelector(dataTestId('perps-order-entry-page'), { timeoutMs: 20000 });
      return { action: input.action, target: selected, market: symbol, side, navigation, proofPath: 'ui-navigation' };
    }
    throw new Error(`Unsupported extension Perps navigation target: ${selected}`);
  });
}

export async function readPositions(input) {
  return withExtensionPage(input, async (page) => {
    const state = await page.readPositions();
    if (!state.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot read live Perps positions.');
    const matching = selectedItems(input, state.positions);
    return { action: input.action, source: state.source ?? 'perps-stream-manager-cache', count: state.positions.length, matchingCount: matching.length, positions: matching.map(redactPosition) };
  });
}

export async function readOrders(input) {
  return withExtensionPage(input, async (page) => {
    const orders = await readOpenOrders(page);
    const matching = selectedItems(input, orders);
    return { action: input.action, source: 'perps-stream-manager-cache', count: orders.length, matchingCount: matching.length, orders: matching.map(redactOrder) };
  });
}

export async function assertPositions(input, expectedOpen) {
  return withExtensionPage(input, async (page) => {
    const state = await page.readPositions();
    if (!state.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot assert live Perps positions.');
    const matching = selectedItems(input, state.positions);
    const hasPosition = matching.length > 0;
    if (expectedOpen && !hasPosition) throw new Error(`Expected selected Perps position(s), but none matched ${JSON.stringify(input.node)}.`);
    if (!expectedOpen && hasPosition) throw new Error(`Expected no selected Perps positions, but ${matching.length} matched ${JSON.stringify(input.node)}.`);
    return { action: input.action, expectedOpen, matchingCount: matching.length, positions: matching.map(redactPosition), source: state.source ?? 'perps-stream-manager-cache' };
  });
}

export async function assertOrders(input, expectedOpen) {
  return withExtensionPage(input, async (page) => {
    const orders = await readOpenOrders(page);
    const matching = selectedItems(input, orders);
    const hasOrders = matching.length > 0;
    if (expectedOpen && !hasOrders) throw new Error(`Expected selected Perps order(s), but none matched ${JSON.stringify(input.node)}.`);
    if (!expectedOpen && hasOrders) throw new Error(`Expected no selected Perps orders, but ${matching.length} matched ${JSON.stringify(input.node)}.`);
    return { action: input.action, expectedOpen, matchingCount: matching.length, orders: matching.map(redactOrder), source: 'perps-stream-manager-cache' };
  });
}

export async function closePositions(input) {
  return withExtensionPage(input, async (page) => {
    const timeoutMs = Number(input.node?.timeout_ms ?? 30000);
    const state = await page.readPositions();
    if (!state.available) throw new Error('Background Perps API unavailable; cannot verify or close live positions.');
    const matching = selectedItems(input, state.positions);
    const symbols = uniqueSymbols(matching.map(symbolForItem));
    if (symbols.length === 0) return { action: input.action, closed: false, matchingCount: 0, symbols, reason: 'no matching open positions' };
    const closeResult = { success: true, successCount: 0, failureCount: 0, results: [] };
    for (const position of matching) {
      const symbol = symbolForItem(position);
      const currentPrice = await readCurrentMarketPrice(page, symbol);
      const positionSize = Number(position?.size ?? position?.szi);
      if (!Number.isFinite(positionSize) || positionSize === 0) {
        closeResult.success = false;
        closeResult.failureCount += 1;
        closeResult.results.push({ symbol, success: false, error: `Invalid position size for ${symbol}: ${String(position?.size ?? position?.szi)}` });
        continue;
      }
      const result = await closePositionWithFreshPrice(page, input, position, symbol);
      const success = result?.success === true;
      closeResult.results.push({ symbol, success, result });
      if (success) closeResult.successCount += 1;
      else {
        closeResult.success = false;
        closeResult.failureCount += 1;
      }
    }
    const after = await waitForPositionsAbsent(page, symbols, timeoutMs);
    const stillOpen = after.positions.filter((position) => symbols.includes(symbolForItem(position)));
    if (stillOpen.length > 0) throw new Error(`Expected selected positions to close after perpsClosePosition. Result: ${JSON.stringify(closeResult)}`);
    return { action: input.action, closed: true, matchingCount: matching.length, symbols, closeResult, proofPath: 'background-perpsClosePosition' };
  });
}

export async function closeOrders(input) {
  return withExtensionPage(input, async (page) => {
    const timeoutMs = Number(input.node?.timeout_ms ?? 30000);
    const before = await readOpenOrders(page);
    const matching = selectedItems(input, before);
    const symbols = uniqueSymbols(matching.map(symbolForItem));
    if (symbols.length === 0) return { action: input.action, canceled: false, matchingCount: 0, symbols, result: null };
    const result = { success: true, successCount: 0, failureCount: 0, results: [] };
    for (const order of matching) {
      const orderId = order?.orderId ?? order?.id;
      const symbol = symbolForItem(order);
      if (!orderId || !symbol) {
        result.success = false;
        result.failureCount += 1;
        result.results.push({ orderId: orderId ?? null, symbol: symbol || null, success: false, error: 'missing orderId or symbol' });
        continue;
      }
      const cancelResult = await requestBackground(page, 'perpsCancelOrder', [{ orderId: String(orderId), symbol }]);
      const success = cancelResult?.success !== false;
      result.results.push({ orderId: String(orderId), symbol, success, result: cancelResult });
      if (success) result.successCount += 1;
      else {
        result.success = false;
        result.failureCount += 1;
      }
    }
    const after = await waitForOrdersAbsent(page, symbols, timeoutMs);
    const stillOpen = after.filter((order) => symbols.includes(symbolForItem(order)));
    if (stillOpen.length > 0) throw new Error(`Expected selected Perps orders to cancel, but ${stillOpen.length} are still open.`);
    return { action: input.action, canceled: true, matchingCount: matching.length, symbols, result, proofPath: 'background-perpsCancelOrder' };
  });
}

async function requestBackground(page, method, args, timeoutMs = 20000) {
  const result = await page.evaluate(`(async () => {
    const request = globalThis.stateHooks?.submitRequestToBackground;
    if (typeof request !== 'function') throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot call ${method}.');
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('${method} timed out after ${timeoutMs}ms')), ${JSON.stringify(timeoutMs)}));
    return Promise.race([request(${JSON.stringify(method)}, ${JSON.stringify(args)}), timeout]);
  })()`);
  if (!result) throw new Error(`${method} returned no result.`);
  return result;
}

function isTransientClosePriceError(result) {
  const message = String(result?.error ?? result?.message ?? '');
  // Retry local pricing/slippage races only. Provider-level oracle rejections
  // such as "Price too far from oracle" are surfaced as real market failures.
  return /IOC_CANCEL|Slippage/i.test(message);
}

async function closePositionWithFreshPrice(page, input, position, symbol) {
  const maxAttempts = Number(input.node?.close_attempts ?? 3);
  const attempts = [];
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const currentPrice = await readCurrentMarketPrice(page, symbol, input.node?.current_price);
    const params = {
      symbol,
      size: String(input.node?.size ?? ''),
      orderType: 'market',
      priceAtCalculation: currentPrice,
      maxSlippageBps: Number(input.node?.max_slippage_bps ?? input.node?.maxSlippageBps ?? 300),
      position,
    };
    const result = await requestBackground(page, 'perpsClosePosition', [params]);
    attempts.push({ attempt, currentPrice, result });
    lastResult = result;
    if (result?.success === true) return { ...result, attempts, params };
    if (!isTransientClosePriceError(result) || attempt === maxAttempts) break;
    await sleep(Number(input.node?.close_retry_delay_ms ?? 1000));
  }
  return { ...(lastResult && typeof lastResult === 'object' ? lastResult : { success: false, error: String(lastResult) }), attempts };
}

async function readCurrentMarketPrice(page, symbol, explicitPrice) {
  if (explicitPrice !== undefined && explicitPrice !== null && explicitPrice !== '') {
    const parsed = Number(String(explicitPrice).replace(/[$,]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    throw new Error(`Invalid explicit current price for ${symbol}: ${String(explicitPrice)}`);
  }
  const price = await page.evaluate(String.raw`(async () => {
    const request = globalThis.stateHooks?.submitRequestToBackground;
    const manager = globalThis.stateHooks?.getPerpsStreamManager?.();
    const symbol = ${JSON.stringify(symbol)};
    function parsePrice(value) {
      const parsed = Number(String(value ?? '').replace(/[$,]/g, '').match(/[0-9]+(?:[.][0-9]+)?/)?.[0] || '0');
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    function bySymbol(item) {
      return item?.symbol === symbol || item?.coin === symbol;
    }
    const visibleSelectors = [
      '[data-testid="perps-order-entry-price"]',
      '[data-testid="perps-market-detail-price"]',
      '[data-testid="perps-market-detail-oracle-price"]',
    ];
    for (const selector of visibleSelectors) {
      const fromDom = parsePrice(document.querySelector(selector)?.innerText);
      if (fromDom) return { price: fromDom, source: selector };
    }
    const streamPrices = manager?.prices?.cache;
    const streamPrice = Array.isArray(streamPrices) ? streamPrices.find(bySymbol) : null;
    const fromStream = parsePrice(streamPrice?.price ?? streamPrice?.markPrice ?? streamPrice?.oraclePrice);
    if (fromStream) return { price: fromStream, source: 'perps-stream-manager-prices' };
    if (typeof request === 'function') {
      const markets = await request('perpsGetMarketDataWithPrices', []);
      const market = Array.isArray(markets) ? markets.find(bySymbol) : null;
      const fromMarket = parsePrice(market?.markPrice ?? market?.oraclePrice ?? market?.currentPrice ?? market?.price);
      if (fromMarket) return { price: fromMarket, source: 'perpsGetMarketDataWithPrices' };
    }
    const body = document.body?.innerText || '';
    const line = body.split('\n').find((text) => /\$[0-9][0-9,]*(?:\.[0-9]+)?/.test(text));
    const fromBody = parsePrice(line);
    return fromBody ? { price: fromBody, source: 'document-body-price-line' } : null;
  })()`);
  const numericPrice = Number(price?.price ?? price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) throw new Error(`Unable to determine current Perps price for ${symbol}.`);
  return numericPrice;
}

async function readOpenOrders(page) {
  const state = await page.evaluate(`(async () => {
    const request = globalThis.stateHooks?.submitRequestToBackground;
    const manager = globalThis.stateHooks?.getPerpsStreamManager?.();
    const cached = manager?.orders?.cache;
    if (typeof request === 'function') {
      const result = await Promise.race([
        request('perpsGetOpenOrders', []).then((orders) => ({ ok: true, orders })),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 5000)),
      ]);
      if (result.ok && Array.isArray(result.orders)) return { available: true, source: 'background-perpsGetOpenOrders', orders: result.orders };
    }
    return {
      available: Array.isArray(cached),
      source: 'perps-stream-manager-cache',
      initialized: Boolean(manager?.isInitialized?.()),
      connected: Boolean(manager?.orders?.isConnected),
      orders: Array.isArray(cached) ? cached : [],
    };
  })()`);
  if (!state.available) throw new Error('Perps orders are unavailable from both background and stream manager cache.');
  return state.orders;
}

async function readAccountState(page) {
  const state = await page.evaluate(`(async () => {
    const request = globalThis.stateHooks?.submitRequestToBackground;
    const manager = globalThis.stateHooks?.getPerpsStreamManager?.();
    const cached = manager?.account?.cache;
    if (typeof request === 'function') {
      const result = await Promise.race([
        request('perpsGetAccountState', []).then((account) => ({ ok: true, account })),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 5000)),
      ]);
      if (result.ok && result.account && typeof result.account === 'object') return { available: true, source: 'background-perpsGetAccountState', account: result.account };
    }
    return {
      available: Boolean(cached && typeof cached === 'object'),
      source: 'perps-stream-manager-cache',
      initialized: Boolean(manager?.isInitialized?.()),
      connected: Boolean(manager?.account?.isConnected),
      account: cached && typeof cached === 'object' ? cached : null,
    };
  })()`);
  if (!state.available) throw new Error('Perps account state is unavailable from both background and stream manager cache.');
  return state.account;
}

async function waitForPositionsAbsent(page, symbols, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = { available: true, positions: [] };
  while (Date.now() < deadline) {
    const state = await page.readPositions();
    if (!state.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot assert live Perps positions.');
    lastState = state;
    const remaining = state.positions.filter((position) => symbols.includes(symbolForItem(position)));
    if (remaining.length === 0) return state;
    await sleep(500);
  }
  return lastState;
}

async function waitForOrdersAbsent(page, symbols, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await readOpenOrders(page);
    const remaining = last.filter((order) => symbols.includes(symbolForItem(order)));
    if (remaining.length === 0) return last;
    await sleep(500);
  }
  return last;
}

async function waitForPositionPresent(page, symbol, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = { available: true, positions: [] };
  while (Date.now() < deadline) {
    const state = await page.readPositions();
    if (!state.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot assert live Perps positions.');
    lastState = state;
    const matching = state.positions.filter((position) => symbolForItem(position) === symbol);
    if (matching.length > 0) return state;
    await sleep(500);
  }
  return lastState;
}

export async function placeOrder(input) {
  const symbol = marketSymbol(input);
  const side = String(input.node?.side ?? 'long').toLowerCase();
  const amount = String(input.node?.amount ?? input.node?.notional ?? '11');
  const leverage = Number(input.node?.leverage ?? 3);
  return withExtensionPage(input, async (page) => {
    await page.navigateHash(`#/perps/trade/${encodeURIComponent(symbol)}?direction=${encodeURIComponent(side)}&mode=new`);
    await page.waitForSelector(dataTestId('perps-order-entry-page'), { timeoutMs: 20000 });
    const order = await page.evaluate(`(async () => {
      const request = globalThis.stateHooks?.submitRequestToBackground;
      if (typeof request !== 'function') throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot place live Perps order.');
      const priceText = document.querySelector(${JSON.stringify(dataTestId('perps-order-entry-price'))})?.innerText || document.body?.innerText || '';
      const parsedPrice = Number(String(priceText).replace(/,/g, '').match(/[0-9]+(?:[.][0-9]+)?/)?.[0] || '0');
      const currentPrice = Number(${JSON.stringify(input.node?.current_price ?? null)}) || parsedPrice;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error('Unable to determine current Perps price for order placement.');
      const usdAmount = ${JSON.stringify(amount)};
      const leverage = ${JSON.stringify(leverage)};
      const orderParams = {
        symbol: ${JSON.stringify(symbol)},
        isBuy: ${JSON.stringify(side !== 'short')},
        size: ((Number(usdAmount) * Number(leverage)) / currentPrice).toString(),
        orderType: 'market',
        leverage,
        currentPrice,
        usdAmount,
        maxSlippageBps: ${JSON.stringify(Number(input.node?.max_slippage_bps ?? input.node?.maxSlippageBps ?? 300))},
      };
      const result = await request('perpsPlaceOrder', [orderParams]);
      if (!result || result.success !== true) throw new Error(result?.error || 'perpsPlaceOrder failed.');
      return { result, orderParams };
    })()`, { awaitPromise: true });
    await waitForPositionPresent(page, symbol, Number(input.node?.timeout_ms ?? 30000));
    return { action: input.action, market: symbol, side, amount, leverage, submitted: true, order, proofPath: 'background-perpsPlaceOrder' };
  });
}

export async function ensurePositions(input) {
  const state = String(input.node?.state ?? input.node?.position ?? 'none').toLowerCase();
  if (state === 'none' || state === 'closed' || state === 'absent') {
    const close = await closePositions(input);
    return { ...(await assertPositions(input, false)), close };
  }
  if (state === 'open' || state === 'present') {
    const current = await withExtensionPage(input, async (page) => {
      const stateResult = await page.readPositions();
      if (!stateResult.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot ensure live Perps positions.');
      return stateResult.positions;
    });
    if (selectedItems(input, current).length === 0) await placeOrder(input);
    return assertPositions(input, true);
  }
  throw new Error(`metamask.perps.ensure_positions received unsupported state: ${state}`);
}

export async function ensureOrders(input) {
  const state = String(input.node?.state ?? input.node?.orders ?? 'none').toLowerCase();
  if (state === 'none' || state === 'closed' || state === 'absent') {
    const close = await closeOrders(input);
    return { ...(await assertOrders(input, false)), close };
  }
  if (state === 'open' || state === 'present') return assertOrders(input, true);
  throw new Error(`metamask.perps.ensure_orders received unsupported state: ${state}`);
}

function redactPosition(position) {
  return {
    coin: position.coin ?? position.symbol ?? null,
    size: position.size ?? position.szi ?? null,
    side: position.side ?? null,
    entryPrice: position.entryPrice ?? position.entryPx ?? null,
  };
}

function redactOrder(order) {
  return {
    coin: order.coin ?? order.symbol ?? null,
    side: order.side ?? null,
    size: order.size ?? order.sz ?? order.szi ?? null,
    price: order.price ?? order.limitPx ?? order.px ?? null,
    type: order.orderType ?? order.type ?? null,
  };
}


function paramsForState(input) {
  const nested = input.node?.params && typeof input.node.params === 'object' ? input.node.params : {};
  return { ...nested, ...input.node };
}

function profileDefaults(profile) {
  const selected = String(profile ?? 'clean_market_testnet');
  if (selected === 'clean_market_testnet') {
    return {
      provider: 'hyperliquid',
      network: 'testnet',
      page: 'market',
      positions: { state: 'none', mode: 'matching' },
      orders: { state: 'none', mode: 'matching' },
    };
  }
  if (selected === 'open_position_testnet') {
    return {
      provider: 'hyperliquid',
      network: 'testnet',
      page: 'market',
      positions: { state: 'open', mode: 'matching' },
      orders: { state: 'none', mode: 'matching' },
    };
  }
  if (selected === 'open_order_testnet') {
    return {
      provider: 'hyperliquid',
      network: 'testnet',
      page: 'market',
      positions: false,
      orders: { state: 'open', mode: 'matching' },
    };
  }
  if (selected === 'provider_mainnet_readonly') {
    return {
      provider: 'hyperliquid',
      network: 'mainnet',
      page: 'home',
      positions: false,
      orders: false,
    };
  }
  if (selected === 'clean_market_mainnet') {
    return {
      provider: 'hyperliquid',
      network: 'mainnet',
      page: 'market',
      positions: { state: 'none', mode: 'matching' },
      orders: { state: 'none', mode: 'matching' },
    };
  }
  return {};
}

function mergeStateConfig(defaults, params) {
  return {
    ...defaults,
    ...params,
    positions: mergeNested(defaults.positions, params.positions),
    orders: mergeNested(defaults.orders, params.orders),
  };
}

function mergeNested(defaultValue, overrideValue) {
  if (overrideValue === false) return false;
  if (overrideValue === undefined) return defaultValue;
  if (defaultValue && typeof defaultValue === 'object' && overrideValue && typeof overrideValue === 'object') {
    return { ...defaultValue, ...overrideValue };
  }
  return overrideValue;
}

function childInput(input, node) {
  const params = paramsForState(input);
  return {
    ...input,
    node: {
      ...params,
      ...node,
      market: node.market ?? node.symbol ?? params.market ?? params.symbol,
      markets: node.markets ?? params.markets,
      symbols: node.symbols ?? params.symbols,
      side: node.side ?? params.side,
      timeout_ms: node.timeout_ms ?? params.timeout_ms,
    },
  };
}

async function applyOrdersState(input, config) {
  if (config === false) return { skipped: true };
  const node = config && typeof config === 'object' ? config : { state: String(config ?? 'none') };
  return ensureOrders(childInput(input, node));
}

async function applyPositionsState(input, config) {
  if (config === false) return { skipped: true };
  const node = config && typeof config === 'object' ? config : { state: String(config ?? 'none') };
  return ensurePositions(childInput(input, node));
}

async function applyStateNavigation(input, config) {
  if (!config.page && !config.market && !config.symbol) return { skipped: true };
  const target = config.page ?? (config.market || config.symbol ? 'market' : 'home');
  return navigatePerps(childInput(input, { target, market: config.market, symbol: config.symbol }));
}


async function readPerpsRuntimeState(page) {
  return page.evaluate(`(async () => {
    const hooks = globalThis.stateHooks || {};
    const request = hooks.submitRequestToBackground;
    const reduxState = hooks.store?.getState?.() || {};
    const cleanState = hooks.getCleanAppState?.() || hooks.getState?.() || {};
    // Extension flattens PerpsController state into state.metamask via ComposableObservableStore.getFlatState().
    const metamask = reduxState.metamask || cleanState.metamask || {};
    const nestedPerps = metamask.PerpsController || cleanState.PerpsController || cleanState.perps || {};
    return {
      available: typeof request === 'function',
      activeProvider: metamask.activeProvider || nestedPerps.activeProvider || 'hyperliquid',
      isTestnet: Boolean(metamask.isTestnet ?? nestedPerps.isTestnet),
      initializationState: metamask.initializationState || nestedPerps.initializationState || null,
      isEligible: Boolean(metamask.isEligible ?? nestedPerps.isEligible),
    };
  })()`);
}

async function ensureProvider(input, config) {
  if (!config.provider) return { skipped: true };
  const expected = String(config.provider).toLowerCase();
  return withExtensionPage(input, async (page) => {
    const state = await readPerpsRuntimeState(page);
    if (!state.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot enforce Perps provider.');
    if (!state.activeProvider && expected === 'hyperliquid') return { requested: expected, activeProvider: 'hyperliquid', changed: false, defaulted: true };
    if (String(state.activeProvider || '').toLowerCase() !== expected) {
      throw new Error(`Expected Perps provider ${expected}, got ${state.activeProvider || 'unknown'}. Extension does not expose a provider switch request yet; select the provider before running or add a supported product request.`);
    }
    return { requested: expected, activeProvider: state.activeProvider, changed: false };
  });
}

async function ensureNetwork(input, config) {
  if (!config.network) return { skipped: true };
  const expectedTestnet = String(config.network).toLowerCase() === 'testnet';
  return withExtensionPage(input, async (page) => {
    const before = await readPerpsRuntimeState(page);
    if (!before.available) throw new Error('stateHooks.submitRequestToBackground is unavailable; cannot enforce Perps network.');
    if (Boolean(before.isTestnet) === expectedTestnet) return { requested: config.network, isTestnet: before.isTestnet, changed: false };
    const result = await requestBackground(page, 'perpsToggleTestnet', []);
    const after = await waitForNetworkState(page, expectedTestnet, Number(input.node?.timeout_ms ?? 30000));
    if (Boolean(after.isTestnet) !== expectedTestnet) {
      throw new Error(`Expected Perps network ${config.network}, got isTestnet=${after.isTestnet}.`);
    }
    return { requested: config.network, isTestnet: after.isTestnet, changed: true, result };
  });
}

async function waitForNetworkState(page, expectedTestnet, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await readPerpsRuntimeState(page);
  while (Date.now() < deadline) {
    last = await readPerpsRuntimeState(page);
    if (Boolean(last.isTestnet) === expectedTestnet) return last;
    await sleep(500);
  }
  return last;
}

async function assertReadyToTrade(input, config) {
  if (config.readyToTrade === undefined || config.readyToTrade === false) return { skipped: true };
  return withExtensionPage(input, async (page) => {
    const accountState = await readAccountState(page);
    return { ready: true, source: 'perps-stream-manager-cache', accountStatePresent: Boolean(accountState) };
  });
}

async function assertBalance(input, config) {
  if (!config.balance) return { skipped: true };
  const balanceConfig = config.balance && typeof config.balance === 'object' ? config.balance : {};
  const minWithdrawable = Number(balanceConfig.minWithdrawableUsd ?? balanceConfig.minUsd ?? 0);
  const minSpendable = Number(balanceConfig.minSpendableUsd ?? 0);
  return withExtensionPage(input, async (page) => {
    const accountState = await readAccountState(page);
    const withdrawable = Number(accountState.withdrawableBalance ?? 0);
    const spendable = Number(accountState.spendableBalance ?? accountState.withdrawableBalance ?? 0);
    if (Number.isFinite(minWithdrawable) && withdrawable < minWithdrawable) {
      throw new Error(`Perps withdrawable balance ${withdrawable} is below requested minimum ${minWithdrawable}.`);
    }
    if (Number.isFinite(minSpendable) && spendable < minSpendable) {
      throw new Error(`Perps spendable balance ${spendable} is below requested minimum ${minSpendable}.`);
    }
    return { withdrawableBalance: withdrawable, spendableBalance: spendable, minWithdrawableUsd: minWithdrawable, minSpendableUsd: minSpendable };
  });
}



export async function startState(input) {
  const params = paramsForState(input);
  const config = mergeStateConfig(profileDefaults(params.profile), params);
  const provider = await ensureProvider(input, config);
  const network = await ensureNetwork(input, config);
  const readyToTrade = await assertReadyToTrade(input, config);
  const balance = await assertBalance(input, config);
  const orders = await applyOrdersState(input, config.orders);
  const positions = await applyPositionsState(input, config.positions);
  const navigation = await applyStateNavigation(input, config);
  return {
    action: input.action,
    profile: config.profile ?? params.profile ?? 'clean_market_testnet',
    phase: 'start_state',
    provider,
    network,
    readyToTrade,
    balance,
    market: config.market ?? config.symbol ?? null,
    orders,
    positions,
    navigation,
    proofPath: 'metamask-perps-start-state',
  };
}

export async function teardownState(input) {
  const params = paramsForState(input);
  const defaults = {
    page: 'home',
    positions: params.market || params.symbol || params.markets || params.symbols ? { state: 'none', mode: 'matching' } : false,
    orders: params.market || params.symbol || params.markets || params.symbols ? { state: 'none', mode: 'matching' } : false,
  };
  const config = mergeStateConfig(defaults, params);
  const orders = await applyOrdersState(input, config.orders);
  const positions = await applyPositionsState(input, config.positions);
  const navigation = config.page === false ? { skipped: true } : await applyStateNavigation(input, config);
  return {
    action: input.action,
    phase: 'teardown',
    market: config.market ?? config.symbol ?? null,
    orders,
    positions,
    navigation,
    proofPath: 'metamask-perps-teardown-state',
  };
}

const DIRECT_ACTIONS = new Map([
  ['metamask.perps.navigate', navigatePerps],
  ['metamask.perps.read_positions', readPositions],
  ['metamask.perps.read_orders', readOrders],
  ['metamask.perps.close_positions', closePositions],
  ['metamask.perps.close_orders', closeOrders],
  ['metamask.perps.place_order', placeOrder],
  ['metamask.perps.ensure_positions', ensurePositions],
  ['metamask.perps.ensure_orders', ensureOrders],
  ['metamask.perps.start_state', startState],
  ['metamask.perps.teardown_state', teardownState],
]);

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  runAdapter((input) => {
    const handler = DIRECT_ACTIONS.get(input.action);
    if (!handler) throw new Error(`No Perps domain dispatcher handler for ${input.action}.`);
    return handler(input);
  });
}
