import { pathToFileURL } from 'node:url';
import { evalAsync, navigate, runAdapter } from '../platform/bridge.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function marketSymbol(input) {
  return normalizeMarketSymbol(input.node?.market ?? input.node?.symbol ?? 'BTC');
}

function normalizeMarketSymbol(rawSymbol) {
  const raw = String(rawSymbol);
  if (raw.includes(':')) {
    const [source, ...symbolParts] = raw.split(':');
    return `${source.toLowerCase()}:${symbolParts.join(':').toUpperCase()}`;
  }
  return raw.toUpperCase();
}

function symbolForItem(item) {
  return normalizeMarketSymbol(item?.symbol ?? item?.coin ?? '');
}

function sideForItem(item) {
  return String(item?.side ?? item?.direction ?? '').toLowerCase();
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

function uniqueSymbols(symbols) {
  return Array.from(new Set(symbols.filter(Boolean)));
}

async function readPositions(input) {
  const positions = await evalAsync(
    input,
    `(function(){
      var controller = Engine && Engine.context && Engine.context.PerpsController;
      if (!controller || typeof controller.getPositions !== 'function') {
        throw new Error('Engine.context.PerpsController.getPositions is unavailable; cannot assert live Perps positions.');
      }
      return controller.getPositions().then(function(r){
        if (!Array.isArray(r)) throw new Error('PerpsController.getPositions returned a non-array result.');
        return JSON.stringify(r);
      });
    })()`,
  );
  if (!Array.isArray(positions)) throw new Error('PerpsController.getPositions returned a non-array result.');
  return positions;
}

async function readOpenOrders(input) {
  const orders = await evalAsync(
    input,
    `(function(){
      var controller = Engine && Engine.context && Engine.context.PerpsController;
      if (!controller || typeof controller.getOpenOrders !== 'function') {
        throw new Error('Engine.context.PerpsController.getOpenOrders is unavailable; cannot assert live Perps orders.');
      }
      return controller.getOpenOrders().then(function(r){
        if (!Array.isArray(r)) throw new Error('PerpsController.getOpenOrders returned a non-array result.');
        return JSON.stringify(r);
      });
    })()`,
  );
  if (!Array.isArray(orders)) throw new Error('PerpsController.getOpenOrders returned a non-array result.');
  return orders;
}

async function waitForPositionsAbsent(input, symbols, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await readPositions(input);
    const remaining = last.filter((position) => symbols.includes(symbolForItem(position)));
    if (remaining.length === 0) return last;
    await sleep(500);
  }
  return last;
}

async function waitForOrdersAbsent(input, symbols, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await readOpenOrders(input);
    const remaining = last.filter((order) => symbols.includes(symbolForItem(order)));
    if (remaining.length === 0) return last;
    await sleep(500);
  }
  return last;
}

async function waitForPositionPresent(input, symbol, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await readPositions(input);
    const matching = last.filter((position) => symbolForItem(position) === symbol);
    if (matching.length > 0) return last;
    await sleep(500);
  }
  return last;
}

function redactPosition(position) {
  return {
    symbol: position.symbol ?? position.coin ?? null,
    size: position.size ?? position.szi ?? null,
    side: position.side ?? null,
    entryPrice: position.entryPrice ?? position.entryPx ?? null,
  };
}

function orderIdForItem(order) {
  return order?.orderId ?? order?.oid ?? order?.id ?? null;
}

function redactOrder(order) {
  return {
    orderId: orderIdForItem(order),
    symbol: order.symbol ?? order.coin ?? null,
    side: order.side ?? null,
    size: order.size ?? order.sz ?? order.szi ?? null,
    price: order.price ?? order.limitPx ?? order.px ?? null,
    type: order.orderType ?? order.type ?? null,
  };
}

function parsePrice(value) {
  const priceMatch = /\d+(?:\.\d+)?/.exec(String(value ?? '').replace(/[$,]/g, ''));
  const parsed = Number(priceMatch?.[0] ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readCurrentMarketPrice(input, symbol, explicitPrice) {
  if (explicitPrice === undefined || explicitPrice === null || explicitPrice === '') {
    return readControllerMarketPrice(input, symbol);
  }
  const parsed = parsePrice(explicitPrice);
  if (parsed) return parsed;
  throw new Error(`Invalid explicit current price for ${symbol}: ${String(explicitPrice)}`);
}

async function readControllerMarketPrice(input, symbol) {
  const market = await evalAsync(
    input,
    `Engine.context.PerpsController.getMarketDataWithPrices().then(function(markets){
      var symbol = ${JSON.stringify(symbol)};
      var market = Array.isArray(markets) ? markets.find(function(item){ return item && (item.symbol === symbol || item.coin === symbol); }) : null;
      return JSON.stringify(market || null);
    })`,
  );
  const parsed = parsePrice(market?.price ?? market?.markPrice ?? market?.oraclePrice ?? market?.currentPrice);
  if (parsed) return parsed;
  throw new Error(`Unable to determine current Perps price for ${symbol}.`);
}

function hasNodeValue(input, snakeName, camelName = snakeName) {
  const node = input.node ?? {};
  return Object.hasOwn(node, snakeName) || Object.hasOwn(node, camelName);
}

function nodeValue(input, snakeName, camelName = snakeName) {
  return input.node?.[snakeName] ?? input.node?.[camelName];
}

async function currentPriceForCloseAttempt(input, symbol) {
  if (hasNodeValue(input, 'price_at_calculation', 'priceAtCalculation')) {
    return Number(nodeValue(input, 'price_at_calculation', 'priceAtCalculation'));
  }
  if (hasNodeValue(input, 'current_price', 'currentPrice')) {
    return readCurrentMarketPrice(input, symbol, nodeValue(input, 'current_price', 'currentPrice'));
  }
  return readCurrentMarketPrice(input, symbol);
}

async function currentPriceForOrder(input, symbol) {
  if (hasNodeValue(input, 'current_price', 'currentPrice')) {
    return readCurrentMarketPrice(input, symbol, nodeValue(input, 'current_price', 'currentPrice'));
  }
  return readCurrentMarketPrice(input, symbol);
}

function orderSideIsBuy(side) {
  if (side === 'short') return false;
  return true;
}

function defaultNavigationTarget(source) {
  if (source?.market || source?.symbol) return 'market';
  return 'home';
}

function isTransientClosePriceError(result) {
  const message = String(result?.error ?? result?.message ?? '');
  // We retry local pricing/slippage races only. "Price too far from oracle"
  // is a provider rejection observed on Hyperliquid testnet and should surface
  // immediately so recipes do not hide an upstream market/oracle failure.
  return /IOC_CANCEL|Slippage/i.test(message);
}

async function navigatePerps(input) {
  const selected = String(
    input.node?.target ?? input.node?.destination ?? defaultNavigationTarget(input.node),
  ).toLowerCase();
  if (selected === 'home' || selected === 'perps' || selected === 'perps_home') {
    const navigation = await navigate(input, 'PerpsMarketListView', {});
    return { action: input.action, target: selected, navigation, proofPath: 'agentic-navigation' };
  }
  if (selected === 'market' || selected === 'market_details') {
    const symbol = marketSymbol(input);
    const navigation = await navigate(input, 'PerpsMarketDetails', { market: { symbol } });
    return { action: input.action, target: selected, market: symbol, navigation, proofPath: 'agentic-navigation' };
  }
  throw new Error(`Unsupported mobile Perps navigation target: ${selected}`);
}

export async function readPerpsPositions(input) {
  const positions = await readPositions(input);
  const matching = selectedItems(input, positions);
  return { action: input.action, source: 'mobile-perps-controller', count: positions.length, matchingCount: matching.length, positions: matching.map(redactPosition) };
}

export async function readOrders(input) {
  const orders = await readOpenOrders(input);
  const matching = selectedItems(input, orders);
  return { action: input.action, source: 'mobile-perps-controller-open-orders', count: orders.length, matchingCount: matching.length, orders: matching.map(redactOrder) };
}

export async function assertPositions(input, expectedOpen) {
  const positions = await readPositions(input);
  const matching = selectedItems(input, positions);
  const hasPosition = matching.length > 0;
  if (expectedOpen && !hasPosition) throw new Error(`Expected selected Perps position(s), but none matched ${JSON.stringify(input.node)}.`);
  if (!expectedOpen && hasPosition) throw new Error(`Expected no selected Perps positions, but ${matching.length} matched ${JSON.stringify(input.node)}.`);
  return { action: input.action, expectedOpen, matchingCount: matching.length, positions: matching.map(redactPosition), source: 'mobile-perps-controller' };
}

export async function assertOrders(input, expectedOpen) {
  const orders = await readOpenOrders(input);
  const matching = selectedItems(input, orders);
  const hasOrders = matching.length > 0;
  if (expectedOpen && !hasOrders) throw new Error(`Expected selected Perps order(s), but none matched ${JSON.stringify(input.node)}.`);
  if (!expectedOpen && hasOrders) throw new Error(`Expected no selected Perps orders, but ${matching.length} matched ${JSON.stringify(input.node)}.`);
  return { action: input.action, expectedOpen, matchingCount: matching.length, orders: matching.map(redactOrder), source: 'mobile-perps-controller-open-orders' };
}

function closePositionParams(input, position) {
  const maxSlippageBps = Number(input.node?.max_slippage_bps ?? input.node?.maxSlippageBps ?? 300);
  const params = {
    symbol: symbolForItem(position),
    size: String(input.node?.size ?? ''),
    orderType: String(input.node?.order_type ?? input.node?.orderType ?? 'market'),
    position,
  };
  if (Number.isFinite(maxSlippageBps)) params.maxSlippageBps = maxSlippageBps;
  if (hasNodeValue(input, 'price_at_calculation', 'priceAtCalculation')) {
    params.priceAtCalculation = Number(nodeValue(input, 'price_at_calculation', 'priceAtCalculation'));
  }
  return params;
}

async function closePositionItem(input, position) {
  const maxAttempts = Number(input.node?.close_attempts ?? 3);
  const retryDelayMs = Number(input.node?.close_retry_delay_ms ?? 1000);
  const baseParams = closePositionParams(input, position);
  const attempts = [];
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const currentPositions = await readPositions(input);
    const currentPosition = currentPositions.find((candidate) => symbolForItem(candidate) === baseParams.symbol);
    if (!currentPosition) return { symbol: baseParams.symbol, result: { success: true, alreadyClosed: true }, attempts };

    const priceAtCalculation = await currentPriceForCloseAttempt(input, baseParams.symbol);
    const params = { ...baseParams, position: currentPosition, priceAtCalculation };
    const result = await evalAsync(
      input,
      `Engine.context.PerpsController.closePosition(${JSON.stringify(params)}).then(function(r){return JSON.stringify(r)})`,
    );
    attempts.push({ attempt, priceAtCalculation, result });
    lastResult = result;
    if (result?.success === false) {
      if (isTransientClosePriceError(result)) {
        await sleep(retryDelayMs);
      } else {
        break;
      }
    } else {
      return { symbol: params.symbol, result, attempts };
    }
  }
  throw new Error(`Failed to close ${baseParams.symbol}: ${lastResult?.error || JSON.stringify(lastResult)} attempts=${JSON.stringify(attempts)}`);
}

export async function closePositions(input) {
  const before = await readPositions(input);
  const matching = selectedItems(input, before);
  const symbols = uniqueSymbols(matching.map(symbolForItem));
  if (symbols.length === 0) {
    return { action: input.action, closed: false, matchingCount: 0, symbols, reason: 'no matching open positions', proofPath: 'mobile-perps-controller-close' };
  }

  const results = [];
  for (const position of matching) {
    results.push(await closePositionItem(input, position));
  }

  const after = await waitForPositionsAbsent(input, symbols, Number(input.node?.timeout_ms ?? 30000));
  const stillOpen = after.filter((position) => symbols.includes(symbolForItem(position)));
  if (stillOpen.length > 0) {
    throw new Error(`Expected selected positions to close, but ${stillOpen.length} are still present: ${JSON.stringify(stillOpen.map(redactPosition))}`);
  }
  return { action: input.action, closed: true, matchingCount: matching.length, symbols, results, proofPath: 'mobile-perps-controller-close' };
}

export async function closeOrders(input) {
  const before = await readOpenOrders(input);
  const matching = selectedItems(input, before);
  const symbols = uniqueSymbols(matching.map(symbolForItem));
  if (symbols.length === 0) return { action: input.action, canceled: false, matchingCount: 0, symbols, result: null };
  const orders = matching.map((order) => ({ orderId: orderIdForItem(order), symbol: symbolForItem(order) }));
  const invalid = orders.find((order) => !order.orderId || !order.symbol);
  if (invalid) {
    throw new Error(`Cannot cancel selected Perps order without orderId and symbol: ${JSON.stringify(invalid)}`);
  }
  const result = await evalAsync(
    input,
    `(function(){
      var controller = Engine && Engine.context && Engine.context.PerpsController;
      var orders = ${JSON.stringify(orders)};
      if (!controller || typeof controller.cancelOrder !== 'function') {
        throw new Error('Engine.context.PerpsController.cancelOrder is unavailable; cannot cancel live Perps orders.');
      }
      return Promise.all(orders.map(function(order){
        return controller.cancelOrder({ orderId: String(order.orderId), symbol: order.symbol }).then(function(r){
          return {
            orderId: String(order.orderId),
            symbol: order.symbol,
            success: !r || r.success !== false,
            result: r
          };
        });
      })).then(function(results){
        var successCount = results.filter(function(entry){ return entry.success; }).length;
        return JSON.stringify({
          success: successCount === results.length,
          successCount: successCount,
          failureCount: results.length - successCount,
          results: results
        });
      });
    })()`,
  );
  const after = await waitForOrdersAbsent(input, symbols, Number(input.node?.timeout_ms ?? 30000));
  const stillOpen = after.filter((order) => symbols.includes(symbolForItem(order)));
  if (stillOpen.length > 0) throw new Error(`Expected selected Perps orders to cancel, but ${stillOpen.length} are still open.`);
  return { action: input.action, canceled: true, matchingCount: matching.length, symbols, result, proofPath: 'mobile-perps-controller-cancel-order' };
}

export async function placeOrder(input) {
  const symbol = marketSymbol(input);
  const side = String(input.node?.side ?? 'long').toLowerCase();
  const amount = String(input.node?.amount ?? input.node?.notional ?? '11');
  const size = String(input.node?.size ?? '0.0001');
  const leverage = Number(input.node?.leverage ?? 3);
  const maxSlippageBps = Number(input.node?.max_slippage_bps ?? input.node?.maxSlippageBps ?? 300);
  const isBuy = orderSideIsBuy(side);
  const currentPrice = await currentPriceForOrder(input, symbol);
  const result = await evalAsync(input, `Engine.context.PerpsController.placeOrder({ symbol: ${JSON.stringify(symbol)}, isBuy: ${JSON.stringify(isBuy)}, orderType: 'market', size: ${JSON.stringify(size)}, usdAmount: ${JSON.stringify(amount)}, leverage: ${JSON.stringify(leverage)}, currentPrice: ${JSON.stringify(currentPrice)}, maxSlippageBps: ${JSON.stringify(maxSlippageBps)} }).then(function(r){return JSON.stringify(r)})`);
  if (result?.success === false || result == null) {
    throw new Error(`Failed to place ${symbol} ${side}: ${result?.error || JSON.stringify(result)}`);
  }
  const refresh = await evalAsync(
    input,
    'globalThis.__AGENTIC__ && globalThis.__AGENTIC__.refreshPerpsStreams ? globalThis.__AGENTIC__.refreshPerpsStreams().then(function(r){return JSON.stringify(r)}) : Promise.resolve(JSON.stringify({ ok: false, reason: "refreshPerpsStreams unavailable" }))',
  );
  await waitForPositionPresent(input, symbol, Number(input.node?.timeout_ms ?? 30000));
  return { action: input.action, market: symbol, side, amount, size, leverage, submitted: true, result, refresh, proofPath: 'mobile-perps-controller-place-order' };
}

export async function ensurePositions(input) {
  const state = String(input.node?.state ?? input.node?.position ?? 'none').toLowerCase();
  if (state === 'none' || state === 'closed' || state === 'absent') {
    const close = await closePositions(input);
    return { ...(await assertPositions(input, false)), close };
  }
  if (state === 'open' || state === 'present') {
    const existing = await readPositions(input);
    if (selectedItems(input, existing).length === 0) await placeOrder(input);
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
  const target = config.page ?? defaultNavigationTarget(config);
  return navigatePerps(childInput(input, { target, market: config.market, symbol: config.symbol }));
}


async function readPerpsRuntimeState(input) {
  return evalAsync(input, `
    (function(){
      var c=Engine.context.PerpsController;
      var s=c.state || {};
      return JSON.stringify({ activeProvider:s.activeProvider || null, isTestnet:!!s.isTestnet });
    })()
  `);
}

async function ensureProvider(input, config) {
  if (!config.provider) return { skipped: true };
  const expected = String(config.provider).toLowerCase();
  const before = await readPerpsRuntimeState(input);
  if (String(before.activeProvider || '').toLowerCase() === expected) {
    return { requested: expected, activeProvider: before.activeProvider, changed: false };
  }
  const result = await evalAsync(
    input,
    `Engine.context.PerpsController.switchProvider(${JSON.stringify(expected)}).then(function(r){return JSON.stringify(r)})`,
  );
  const after = await readPerpsRuntimeState(input);
  if (String(after.activeProvider || '').toLowerCase() !== expected) {
    throw new Error(`Expected Perps provider ${expected}, got ${after.activeProvider || 'unknown'} after switchProvider.`);
  }
  return { requested: expected, activeProvider: after.activeProvider, changed: true, result };
}

async function ensureNetwork(input, config) {
  if (!config.network) return { skipped: true };
  const expectedTestnet = String(config.network).toLowerCase() === 'testnet';
  const before = await readPerpsRuntimeState(input);
  if (Boolean(before.isTestnet) === expectedTestnet) {
    return { requested: config.network, isTestnet: before.isTestnet, changed: false };
  }
  const result = await evalAsync(input, 'Engine.context.PerpsController.toggleTestnet().then(function(r){return JSON.stringify(r)})');
  const after = await waitForNetworkState(input, expectedTestnet, Number(input.node?.timeout_ms ?? 30000));
  if (Boolean(after.isTestnet) !== expectedTestnet) {
    throw new Error(`Expected Perps network ${config.network}, got isTestnet=${after.isTestnet}.`);
  }
  return { requested: config.network, isTestnet: after.isTestnet, changed: true, result };
}

async function waitForNetworkState(input, expectedTestnet, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await readPerpsRuntimeState(input);
  while (Date.now() < deadline) {
    last = await readPerpsRuntimeState(input);
    if (Boolean(last.isTestnet) === expectedTestnet) return last;
    await sleep(500);
  }
  return last;
}

async function assertReadyToTrade(input, config) {
  if (config.readyToTrade === undefined || config.readyToTrade === false) return { skipped: true };
  const ready = await evalAsync(
    input,
    `(function(){ var c=Engine.context.PerpsController; var id=c.state.activeProvider; var p=c.providers && c.providers.get ? c.providers.get(id) : c.getActiveProvider && c.getActiveProvider(); if(!p || typeof p.isReadyToTrade !== 'function') return Promise.resolve(JSON.stringify({ready:false,activeProvider:id || null,error:'provider unavailable'})); return p.isReadyToTrade().then(function(r){ return JSON.stringify({ready:!!(r && r.ready), activeProvider:id || null, authenticatedAddress:(r&&r.authenticatedAddress)||null}); }); })()`,
  );
  if (!ready.ready) throw new Error(`Perps provider is not ready to trade: ${JSON.stringify(ready)}`);
  return ready;
}

async function assertBalance(input, config) {
  if (!config.balance) return { skipped: true };
  const balanceConfig = config.balance && typeof config.balance === 'object' ? config.balance : {};
  const minWithdrawable = Number(balanceConfig.minWithdrawableUsd ?? balanceConfig.minUsd ?? 0);
  const minSpendable = Number(balanceConfig.minSpendableUsd ?? 0);
  const accountState = await evalAsync(
    input,
    'Engine.context.PerpsController.getAccountState().then(function(r){return JSON.stringify(r)})',
  );
  const withdrawable = Number(accountState.withdrawableBalance ?? 0);
  const spendable = Number(accountState.spendableBalance ?? accountState.withdrawableBalance ?? 0);
  if (Number.isFinite(minWithdrawable) && withdrawable < minWithdrawable) {
    throw new Error(`Perps withdrawable balance ${withdrawable} is below requested minimum ${minWithdrawable}.`);
  }
  if (Number.isFinite(minSpendable) && spendable < minSpendable) {
    throw new Error(`Perps spendable balance ${spendable} is below requested minimum ${minSpendable}.`);
  }
  return { withdrawableBalance: withdrawable, spendableBalance: spendable, minWithdrawableUsd: minWithdrawable, minSpendableUsd: minSpendable };
}

async function applyTutorialState(input, config) {
  const tutorialConfig = config.tutorial && typeof config.tutorial === 'object'
    ? config.tutorial
    : { completed: config.tutorialCompleted ?? config.skipTutorial };
  if (tutorialConfig.completed !== true) return { skipped: true };
  return evalAsync(
    input,
    `(function(){
      var c=Engine.context.PerpsController;
      if (!c || typeof c.markTutorialCompleted !== 'function') return JSON.stringify({ok:false, skipped:true, reason:'markTutorialCompleted unavailable'});
      c.markTutorialCompleted();
      return JSON.stringify({ok:true, completed:true, isTestnet:!!c.state.isTestnet, isFirstTimeUser:c.state.isFirstTimeUser});
    })()`,
  );
}



export async function startState(input) {
  const params = paramsForState(input);
  const config = mergeStateConfig(profileDefaults(params.profile), params);
  const provider = await ensureProvider(input, config);
  const network = await ensureNetwork(input, config);
  const tutorial = await applyTutorialState(input, config);
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
    tutorial,
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
  ['metamask.perps.read_positions', readPerpsPositions],
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
