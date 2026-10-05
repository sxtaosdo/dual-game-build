import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateBuildReceipt, verifyBuildArtifact, hashTree } from '../build-smoke.mjs';
import { startCreatorProcess } from '../creator-build.mjs';
import { finalizeRuntimeReceipt } from '../runtime-smoke.mjs';

const sourceHead = 'a'.repeat(40), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = () => ({ passed: true, state: 'complete', sourceHead, results: ['ant', 'cook', 'both'].map(variant => ({
  variant, sourceHead, state: 'passed', package: { sha256: 'b'.repeat(64) },
})) });

test('acceptance rejects partial, duplicate, unfinished or stale-source build receipts', () => {
  assert.equal(validateBuildReceipt(receipt(), sourceHead).length, 3);
  for (const mutate of [
    r => { r.results = []; }, r => { r.results.length = 1; },
    r => { r.results[2].variant = 'ant'; }, r => { r.passed = false; },
    r => { delete r.passed; }, r => { r.state = 'running'; },
    r => { r.results[1].state = 'running'; }, r => { r.sourceHead = 'c'.repeat(40); },
    r => { r.results[2].sourceHead = 'c'.repeat(40); }, r => { delete r.results[1].package; },
  ]) {
    const r = receipt(); mutate(r); assert.throws(() => validateBuildReceipt(r, sourceHead));
  }
});

test('acceptance binds the build package, config and selected input manifest to recorded bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shidai3-build-acceptance-'));
  t.after(async () => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'build/web-mobile'), { recursive: true });
  const index = join(root, 'build/web-mobile/index.html'), configPath = join(root, 'config.json'), manifestPath = join(root, 'BUILD_INPUT.json');
  await writeFile(index, '<html>compiled fixture</html>');
  await writeFile(configPath, '{"platform":"web-mobile"}');
  await writeFile(manifestPath, '{"variant":"both","copiedFiles":[]}');
  const build = { output: root, configPath, configSha256: hash(await readFile(configPath)),
    staged: { manifestSha256: hash(await readFile(manifestPath)) }, package: await hashTree(join(root, 'build/web-mobile')) };
  assert.equal((await verifyBuildArtifact(build)).sha256, build.package.sha256);
  for (const [file, message] of [[index, /Compiled artifact/], [configPath, /Build config/], [manifestPath, /payload manifest/]]) {
    const before = await readFile(file); await writeFile(file, Buffer.concat([before, Buffer.from(' changed')]));
    await assert.rejects(verifyBuildArtifact(build), message); await writeFile(file, before);
  }
  assert.equal((await verifyBuildArtifact(build)).sha256, build.package.sha256);
});

const observe = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Lost child completion event')), 1000); })]); }
  finally { clearTimeout(timer); }
};
function fakeSpawn(event) {
  return () => {
    const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write('early build output');
      if (event === 'error') child.emit('error', Error('spawn ENOENT'));
      else { child.emit('exit', 36, null); child.emit('exit', 1, null); }
    });
    return child;
  };
}
test('fast child exit during awaited receipt IO is retained and settles exactly once', async () => {
  const run = startCreatorProcess('fixture', [], fakeSpawn('exit'));
  await new Promise(resolve => setImmediate(resolve));
  const result = await observe(run.completed);
  assert.equal(result.code, 36); assert.equal(result.signal, null); assert.equal(result.stdout, 'early build output');
});
test('fast asynchronous spawn error during receipt IO becomes a terminal failure', async () => {
  const run = startCreatorProcess('fixture', [], fakeSpawn('error'));
  await new Promise(resolve => setImmediate(resolve));
  const result = await observe(run.completed);
  assert.equal(result.code, null); assert.match(result.launchError, /ENOENT/);
});
test('synchronous spawn refusal becomes a terminal failure without an unhandled rejection', async () => {
  const run = startCreatorProcess('fixture', [], () => { throw Error('launch denied'); });
  const result = await observe(run.completed);
  assert.equal(run.pid, null); assert.match(result.launchError, /launch denied/);
});
test('Edge release rejection still persists failed receipt and preserves the original validation failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shidai3-release-receipt-'));
  t.after(async () => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  });
  const error = Error('owned Edge close failed');
  for (const original of [undefined, 'original validation failure']) {
    const receipt = { passed: true, ...(original ? { failure: original } : {}) }, path = join(root, 'receipt.json');
    const result = await finalizeRuntimeReceipt(path, receipt, { release: async () => { throw error; } });
    assert.equal(result, error);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.passed, false); assert.equal(saved.cleanupFailure, String(error));
    assert.equal(saved.failure, original ?? String(error));
  }
});
