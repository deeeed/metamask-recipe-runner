import { navigate, runAdapter } from '../platform/bridge.mjs';

runAdapter(async (input) => {
  const route = input.node?.route ?? input.node?.screen;
  if (typeof route !== 'string' || route.length === 0) {
    throw new Error('mobile ui.navigate requires a raw React Navigation route in node.route or node.screen.');
  }
  const params = input.node?.params && typeof input.node.params === 'object' ? input.node.params : {};
  const navigation = await navigate(input, route, params);
  return { action: input.action, route, params, navigation, proofPath: 'agentic-navigation' };
});
