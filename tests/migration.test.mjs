import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { watch, writeFileSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile, stat, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { migrate } from '../migration.mjs';
import { pathLease } from '../path-lease.mjs';

const taskTemp = resolve(tmpdir(), 'shidai3-dual-game-build');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { stdio: 'pipe' });
async function fixture(t) {
  const physicalTemp = await realpath(tmpdir());
  assert.equal(resolve(physicalTemp).toLowerCase(), resolve(tmpdir()).toLowerCase());
  const existing = await lstat(taskTemp).catch(() => null);
  if (existing) { assert.equal(existing.isSymbolicLink(), false); assert.equal((await realpath(taskTemp)).toLowerCase(), taskTemp.toLowerCase()); }
  const lease = await pathLease(taskTemp);
  let root = null, subtreeLease = null;
  t.after(async () => {
    try {
      await subtreeLease?.close();
      if (!root) return;
      assert.ok(resolve(root).startsWith(taskTemp + '\\') || resolve(root).startsWith(taskTemp + '/'));
      assert.equal((await lstat(root)).isSymbolicLink(), false); assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase());
      assert.equal((await realpath(taskTemp)).toLowerCase(), taskTemp.toLowerCase());
      await rm(root, { recursive: true, force: true });
    } finally { await lease.close(); }
  });
  await lease.lock(physicalTemp);
  await mkdir(taskTemp, { recursive: true }); await lease.lock(taskTemp);
  root = await mkdtemp(join(taskTemp, 'migration-')); const output = join(root, 'P4000/ant-cook');
  subtreeLease = await pathLease(taskTemp);
  await subtreeLease.lock(root);
  const ant = join(root, 'P4000/colony-flow-food-hunt'), cook = join(root, 'P4000/cook');
  for (const [repo, paths] of [[ant, ['assets/Colony/a.txt', 'assets/Colony.meta', 'assets/resources/a.txt', 'assets/resources.meta', 'extensions/MKFramework/a.txt', 'Tests/a.txt']],
    [cook, ['assets/bundles/a.txt', 'assets/bundles.meta', 'tests/a.txt']]]) {
    await mkdir(repo, { recursive: true });
    for (const path of [...paths, 'VERSION']) { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), path === 'VERSION' ? '0.1.0.1\n' : 'original\n'); }
    git(repo, 'init'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  }
  await mkdir(output);
  return { root, output, ant, cook };
}

test('migration freezes selected source, preserves Git, refuses overwrite and reports saved manifest byte hash', async t => {
  const f = await fixture(t), before = git(f.ant, 'status', '--porcelain=v1', '-z');
  const result = await migrate(f.root, f.output), bytes = await readFile(join(f.output, 'MIGRATION_SOURCES.json'));
  assert.equal(result.manifestSha256, hash(bytes)); assert.equal(result.copiedFiles, 9);
  assert.deepEqual(git(f.ant, 'status', '--porcelain=v1', '-z'), before);
  const manifest = JSON.parse(bytes);
  for (const file of manifest.files) assert.equal(hash(await readFile(join(f.output, file.destination))), file.sha256);
  await assert.rejects(migrate(f.root, f.output), /already exists/);
});

test('Windows path lease prevents destination ancestor substitution between checking and writing', async t => {
  const f = await fixture(t), external = join(f.root, 'external'); await mkdir(external);
  let attempted = false, denied = false;
  const watcher = watch(f.output, { recursive: true }, (_, path) => {
    if (attempted || !String(path).replaceAll('\\', '/').endsWith('assets/Colony/a.txt')) return;
    attempted = true;
    try { renameSync(join(f.output, 'assets'), join(external, 'redirected')); }
    catch (cause) { denied = ['EPERM', 'EACCES', 'EBUSY'].includes(cause.code); }
  });
  try {
    await migrate(f.root, f.output); assert.equal(attempted, true); assert.equal(denied, true);
    assert.equal(await stat(join(external, 'redirected')).catch(() => null), null);
    assert.equal(await readFile(join(f.output, 'assets/Colony/a.txt'), 'utf8'), 'original\n');
  } finally { watcher.close(); }
});

test('source junction and target/upstream junction are rejected before imported writes', async t => {
  for (const location of ['source', 'target', 'upstream']) {
    const f = await fixture(t), external = join(f.root, 'external'); await mkdir(external);
    let linked;
    if (location === 'source') { linked = join(f.ant, 'assets/Colony/link'); }
    else if (location === 'target') { linked = join(f.output, 'assets'); }
    else { await rmdir(f.output); linked = f.output; }
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(migrate(f.root, f.output), /symlink\/junction/);
    assert.equal(await stat(join(external, 'Colony')).catch(() => null), null);
    assert.equal(await stat(join(f.output, 'MIGRATION_SOURCES.json')).catch(() => null), null);
  }
});

test('preflight rejects an existing imported file without writing other selected content', async t => {
  const f = await fixture(t); await mkdir(join(f.output, 'assets/Colony'), { recursive: true });
  await writeFile(join(f.output, 'assets/Colony/a.txt'), 'keep');
  await assert.rejects(migrate(f.root, f.output), /already exists/);
  assert.equal(await readFile(join(f.output, 'assets/Colony/a.txt'), 'utf8'), 'keep');
  assert.equal(await stat(join(f.output, 'assets/bundles')).catch(() => null), null);
});

test('end snapshot detects already-dirty byte changes, inventory, HEAD, index and version changes', async t => {
  for (const mutation of ['dirty-bytes', 'file-set', 'head', 'index', 'version']) {
    const f = await fixture(t), source = join(f.ant, 'assets/Colony/a.txt');
    // It was already dirty before migration: a second edit leaves porcelain unchanged.
    await writeFile(source, 'first dirty');
    let changed = false;
    const watcher = watch(f.output, { recursive: true }, (_, path) => {
      if (changed || !String(path).replaceAll('\\', '/').endsWith('assets/Colony/a.txt')) return;
      changed = true;
      if (mutation === 'dirty-bytes') writeFileSync(source, 'second dirty');
      if (mutation === 'file-set') writeFileSync(join(f.ant, 'assets/Colony/new.txt'), 'new');
      if (mutation === 'head') git(f.ant, 'commit', '--allow-empty', '-m', 'changed head');
      if (mutation === 'index') git(f.ant, 'add', 'assets/Colony/a.txt');
      if (mutation === 'version') writeFileSync(join(f.ant, 'VERSION'), '0.1.0.2\n');
    });
    try {
      await assert.rejects(migrate(f.root, f.output), /Source bytes changed|file set changed|Git\/version snapshot changed/);
      assert.equal(changed, true); assert.equal(await stat(join(f.output, 'MIGRATION_SOURCES.json')).catch(() => null), null);
    } finally { watcher.close(); }
  }
});
