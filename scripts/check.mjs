#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const farmslotRoot = findFarmslotRoot(runnerDir) ?? findFarmslotRoot(process.cwd());
const localTsc = path.join(runnerDir, 'node_modules/typescript/bin/tsc');
const farmslotTsc = farmslotRoot
  ? path.join(farmslotRoot, 'node_modules/typescript/bin/tsc')
  : undefined;
const tsc = fs.existsSync(localTsc) ? localTsc : farmslotTsc;
if (!tsc || !fs.existsSync(tsc)) {
  throw new Error(
    'TypeScript compiler not found. Install this package normally, or set FARMSLOT_ROOT/use npm run dev:link-farmslot while co-developing Farmslot locally.',
  );
}
const generatedTsconfig = path.join(runnerDir, '.tmp', 'tsconfig.check.json');
fs.mkdirSync(path.dirname(generatedTsconfig), { recursive: true });
fs.writeFileSync(
  generatedTsconfig,
  `${JSON.stringify(
    {
      extends: '../tsconfig.json',
      compilerOptions: {
        baseUrl: '..',
        types: ['node'],
        ...localTypescriptOverrides(generatedTsconfig, farmslotRoot),
      },
    },
    null,
    2,
  )}\n`,
);
run(process.execPath, [tsc, '--noEmit', '--project', generatedTsconfig]);
for (const file of listFiles(runnerDir, (name) => name.endsWith('.mjs'))) {
  run(process.execPath, ['--check', file]);
}
validateCommittedRecipes();

function localTypescriptOverrides(generatedTsconfigPath, root) {
  if (!root) return {};
  return {
    typeRoots: [
      path.relative(
        path.dirname(generatedTsconfigPath),
        path.join(root, 'node_modules/@types'),
      ),
    ],
    paths: {
      '@farmslot/protocol': [
        path.relative(runnerDir, path.join(root, 'packages/protocol/src/index.ts')),
      ],
      '@farmslot/protocol/*': [
        path.relative(runnerDir, path.join(root, 'packages/protocol/src/*')),
      ],
      '@farmslot/recipe-harness': [
        path.relative(runnerDir, path.join(root, 'packages/recipe-harness/src/index.ts')),
      ],
      '@farmslot/recipe-harness/*': [
        path.relative(runnerDir, path.join(root, 'packages/recipe-harness/src/*')),
      ],
    },
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: runnerDir,
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findFarmslotRoot(start) {
  const candidates = [process.env.FARMSLOT_ROOT, start].filter(Boolean);
  for (const candidate of candidates) {
    let dir = path.resolve(candidate);
    while (dir !== path.dirname(dir)) {
      if (isFarmslotRoot(dir)) return dir;
      const sibling = path.join(dir, 'farmslot');
      if (isFarmslotRoot(sibling)) return sibling;
      dir = path.dirname(dir);
    }
  }
  return null;
}

function isFarmslotRoot(dir) {
  return (
    fs.existsSync(path.join(dir, 'packages/recipe-harness/package.json')) &&
    fs.existsSync(path.join(dir, 'packages/protocol/package.json'))
  );
}

function listFiles(root, predicate) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, predicate));
    else if (entry.isFile() && predicate(entry.name)) out.push(full);
  }
  return out;
}

function validateCommittedRecipes() {
  const recipeDir = path.join(runnerDir, 'recipes');
  const recipes = listFiles(recipeDir, (name) => name.endsWith('.recipe.json'));
  const manifests = {
    mobile: readJson(
      path.join(runnerDir, 'manifests/mobile.action-manifest.json'),
    ),
    extension: readJson(
      path.join(runnerDir, 'manifests/extension.action-manifest.json'),
    ),
  };
  const allActions = new Set([
    ...manifestActions(manifests.mobile),
    ...manifestActions(manifests.extension),
  ]);
  for (const recipePath of recipes) {
    const recipe = readJson(recipePath);
    const adapter = adapterForRecipe(recipePath);
    const actions = adapter ? manifestActions(manifests[adapter]) : allActions;
    const failures = validateRecipeShape(recipe, actions);
    if (failures.length > 0) {
      console.error(`Invalid recipe ${path.relative(runnerDir, recipePath)}:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function manifestActions(manifest) {
  return new Set([
    ...(manifest.supported_official_actions || []),
    ...(manifest.custom_actions || []).map((entry) => entry.name),
  ]);
}

function adapterForRecipe(recipePath) {
  const name = path.basename(recipePath);
  if (name.includes('.mobile.')) return 'mobile';
  if (name.includes('.extension.')) return 'extension';
  return null;
}

function validateRecipeShape(recipe, actions) {
  const failures = [];
  const workflow = recipe?.validate?.workflow;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return ['validate.workflow must be an object'];
  }
  if (
    !workflow.nodes ||
    typeof workflow.nodes !== 'object' ||
    Array.isArray(workflow.nodes)
  ) {
    return ['validate.workflow.nodes must be an object'];
  }
  const nodes = workflow.nodes;
  if (!Object.hasOwn(nodes, workflow.entry)) {
    failures.push(`entry node does not exist: ${workflow.entry}`);
  }
  for (const [nodeId, node] of Object.entries(nodes)) {
    validateNode(
      node,
      `validate.workflow.nodes.${nodeId}`,
      actions,
      nodes,
      failures,
    );
  }
  for (const lifecycleName of ['setup', 'teardown']) {
    validateLifecycle(
      workflow[lifecycleName],
      `validate.workflow.${lifecycleName}`,
      actions,
      failures,
    );
  }
  if (recipe.startState != null) {
    validateNode(recipe.startState, 'startState', actions, nodes, failures, {
      lifecycle: true,
    });
  }
  validateTerminalReachability(workflow, failures);
  return failures;
}

function validateLifecycle(value, label, actions, failures) {
  if (value == null) return;
  if (!Array.isArray(value)) {
    failures.push(`${label} must be an array`);
    return;
  }
  value.forEach((node, index) => {
    validateNode(node, `${label}[${index}]`, actions, {}, failures, {
      lifecycle: true,
    });
  });
}

function validateNode(node, label, actions, nodes, failures, options = {}) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    failures.push(`${label} must be an action node object`);
    return;
  }
  if (typeof node.action !== 'string' || node.action.length === 0) {
    failures.push(`${label}.action must be a non-empty string`);
    return;
  }
  if (!actions.has(node.action))
    failures.push(`${label}.action is not manifest-declared: ${node.action}`);
  if (options.lifecycle) {
    if (node.next != null || node.default != null || node.cases != null) {
      failures.push(
        `${label} lifecycle nodes must not declare graph transitions`,
      );
    }
    return;
  }
  if (node.action === 'end') return;
  const targets = collectTargets(node);
  if (targets.length === 0)
    failures.push(`${label} must transition via next, default, or cases`);
  for (const target of targets) {
    if (!Object.hasOwn(nodes, target)) {
      failures.push(`${label} references missing target: ${target}`);
    }
  }
}

function collectTargets(node) {
  return [...directTargets(node), ...caseTargets(node.cases)];
}

function directTargets(node) {
  return [node.next, node.default].filter(isNonEmptyString);
}

function caseTargets(cases) {
  if (Array.isArray(cases)) return arrayCaseTargets(cases);
  if (isPlainObject(cases)) return Object.values(cases).filter(isNonEmptyString);
  return [];
}

function arrayCaseTargets(cases) {
  return cases
    .filter(isPlainObject)
    .map((entry) => entry.next)
    .filter(isNonEmptyString);
}

function validateTerminalReachability(workflow, failures) {
  const nodes = workflow.nodes;
  const terminalCount = Object.values(nodes).filter(isEndNode).length;
  const reachableTerminalCount = reachableNodes(workflow).filter(isEndNode).length;
  if (terminalCount === 0) {
    failures.push('workflow must include at least one end node');
  } else if (reachableTerminalCount === 0) {
    failures.push('workflow must have at least one reachable end node');
  }
}

function reachableNodes(workflow) {
  const nodes = workflow.nodes;
  const queue = Object.hasOwn(nodes, workflow.entry) ? [workflow.entry] : [];
  const reachable = new Set();
  const values = [];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || reachable.has(nodeId)) continue;
    const node = nodes[nodeId];
    if (!isPlainObject(node)) continue;
    reachable.add(nodeId);
    values.push(node);
    queue.push(...unvisitedTargets(node, nodes, reachable));
  }
  return values;
}

function unvisitedTargets(node, nodes, reachable) {
  return collectTargets(node).filter(
    (target) => Object.hasOwn(nodes, target) && !reachable.has(target),
  );
}

function isEndNode(node) {
  return node?.action === 'end';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
