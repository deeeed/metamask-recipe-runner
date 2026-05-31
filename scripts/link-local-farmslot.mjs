#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const runnerDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const farmslotRoot = resolveFarmslotRoot();

linkPackage('@farmslot/protocol', path.join(farmslotRoot, 'packages/protocol'));
linkPackage('@farmslot/recipe-harness', path.join(farmslotRoot, 'packages/recipe-harness'));

const nodeTypes = path.join(farmslotRoot, 'node_modules/@types/node');
if (fs.existsSync(nodeTypes)) {
  linkPackage('@types/node', nodeTypes);
}

console.log(`Dev-linked local Farmslot packages from ${farmslotRoot}`);

function resolveFarmslotRoot() {
  const candidates = [
    process.env.FARMSLOT_ROOT,
    path.resolve(runnerDir, '../../farmslot'),
    path.resolve(runnerDir, '../farmslot'),
    path.resolve(process.cwd(), '../farmslot'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isFarmslotRoot(candidate)) return candidate;
  }
  throw new Error(
    'Unable to find Farmslot root. Set FARMSLOT_ROOT=/path/to/farmslot and rerun npm run dev:link-farmslot.',
  );
}

function isFarmslotRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, 'packages/protocol/package.json')) &&
    fs.existsSync(path.join(candidate, 'packages/recipe-harness/package.json'))
  );
}

function linkPackage(name, target) {
  if (!fs.existsSync(target)) throw new Error(`Cannot link missing package target: ${target}`);
  const destination = path.join(runnerDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.symlinkSync(target, destination, 'dir');
  console.log(`${name} -> ${target}`);
}
