import { createServer } from 'node:http';
import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { acquirePreviewPage } from '../cocos-mcp/mcp/dist/companion/edge-session.js';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { runtimeSmoke } from './runtime-smoke.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };
export async function serveArtifact(root) {
  root = await realpath(root);
  const bound = relative(await realpath(tmpdir()), root);
  if (!bound || bound.startsWith('..') || isAbsolute(bound)) throw Error('Only task Temp artifacts may be served');
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      const rel = relative(root, file); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Artifact path escape');
      const physical = await realpath(file), physicalRel = relative(root, physical);
      if (physicalRel.startsWith('..') || isAbsolute(physicalRel)) throw Error('Artifact symlink escape');
      const bytes = await readFile(physical); requests.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}
export async function hashTree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) }); }
      else throw Error('Non-file artifact entry');
    }
  }
  await walk(root);
  return { files, bytes: files.reduce((n, f) => n + f.bytes, 0), sha256: sha256(JSON.stringify(files)) };
}
export function validateBuildReceipt(receipt, expectedSourceHead) {
  assert.equal(receipt.passed, true, 'Build receipt must have a successful final state');
  assert.equal(receipt.state, 'complete', 'Build receipt is incomplete');
  assert.equal(receipt.sourceHead, expectedSourceHead, 'Build source HEAD is stale');
  assert.equal(receipt.results?.length, 3, 'All three variants are required');
  assert.deepEqual(receipt.results.map(r => r.variant).sort(), ['ant', 'both', 'cook'], 'Variants must be complete and unique');
  for (const build of receipt.results) {
    assert.equal(build.state, 'passed', `Unfinished variant: ${build.variant}`);
    assert.equal(build.sourceHead, expectedSourceHead, 'Variant source HEAD differs');
    assert.match(build.package?.sha256 ?? '', /^[a-f0-9]{64}$/, 'Build package hash is required');
  }
  return receipt.results;
}
export async function verifyBuildArtifact(build) {
  const before = await hashTree(join(build.output, 'build/web-mobile'));
  assert.equal(before.sha256, build.package.sha256, 'Compiled artifact differs from build receipt');
  assert.equal(sha256(await readFile(build.configPath)), build.configSha256, 'Build config differs from receipt');
  assert.equal(sha256(await readFile(join(build.output, 'BUILD_INPUT.json'))), build.staged.manifestSha256, 'Staged payload manifest differs from receipt');
  return before;
}
export async function buildSmoke(buildReceipt, receiptPath, playwrightPackage, { dualRuntime = true } = {}) {
  const report = { observedAt: new Date().toISOString(), buildReceipt, cases: [], passed: false };
  const receipt = JSON.parse(await readFile(buildReceipt, 'utf8'));
  const sourceHead = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: receipt.source, encoding: 'utf8' }).trim();
  const builds = validateBuildReceipt(receipt, sourceHead);
  // Validate every build before any browser or server starts, including later variants.
  const packages = await Promise.all(builds.map(verifyBuildArtifact));
  report.sourceHead = sourceHead; report.toolHead = receipt.toolHead;
  report.edgeChain = 'Creator AI Companion acquirePreviewPage';
  try {
    for (const [index, build] of builds.entries()) {
      const root = join(build.output, 'build/web-mobile'), before = packages[index], server = await serveArtifact(root);
      try {
        const modes = build.variant === 'both' ? ['ant', 'cook'] : [build.variant];
        const settings = JSON.parse(await readFile(join(root, 'src/settings.json'), 'utf8'));
        for (const excluded of ['ant', 'cook'].filter(id => !modes.includes(id)))
          assert(!settings.assets.projectBundles.includes(excluded === 'ant' ? 'Colony' : 'game'));
        const cases = [];
        for (const request of ['ant', 'cook']) {
          const lease = await acquirePreviewPage(`${server.url}/?mode=${request}`, { mode: 'isolated', viewport: { width: 390, height: 844 } }), page = lease.page;
          try {
          assert.equal(lease.mode, 'isolated'); assert.equal(lease.reusedBrowser, false); assert.equal(lease.reusedPage, false);
          const errors = [], externalRequests = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
          report.pending = { variant: build.variant, request, errors, externalRequests };
          await page.route('**/*', async route => { if (!route.request().url().startsWith(server.url)) { externalRequests.push(route.request().url()); await route.abort(); } else await route.continue(); });
          await lease.ensureLoaded();
          const expected = modes.includes(request) ? request : modes[0];
          try { await page.waitForFunction(expected => {
            const s = globalThis.cc?.director?.getScene?.()?.children.find(n => n.name === 'ProductShell')?.components.find(c => c.constructor.name === 'ProductBootstrap');
            return s?.coordinator?.currentMode === expected && !s.transitioning && s.coordinator.active?.ready;
          }, expected, { timeout: 45000 }); }
          catch (error) {
            report.pending.state = await page.evaluate(() => ({ cc: !!globalThis.cc, canvas: !!document.querySelector('canvas'), text: document.body.innerText, keys: Object.keys(globalThis).filter(k => /cc|cocos|system/i.test(k)), scene: globalThis.cc?.director?.getScene?.()?.name,
              roots: globalThis.cc?.director?.getScene?.()?.children.map(n => ({ name: n.name, components: n.components.map(c => c.constructor.name), status: n.components.find(c => c.constructor.name === 'ProductBootstrap')?.status?.string })) }));
            await page.screenshot({ path: receiptPath.replace(/\.json$/, '-failed.png') }); throw error;
          }
          const state = await page.evaluate(() => {
            const n = cc.director.getScene().children.find(n => n.name === 'ProductShell'), s = n.components.find(c => c.constructor.name === 'ProductBootstrap');
            return { mode: s.coordinator.currentMode, navigation: n.children.filter(n => n.name.startsWith('Switch_')).map(n => n.name), status: s.status.string };
          });
          assert.deepEqual(state.navigation.sort(), modes.map(id => `Switch_${id}`).sort()); assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(externalRequests.length, 0);
          await page.screenshot({ path: receiptPath.replace(/\.json$/, `-${build.variant}-${request}.png`) });
          cases.push({ request, expected, state, errors, externalRequests, passed: true });
          } finally { await lease.release(); }
        }
        if (dualRuntime && build.variant === 'both') await runtimeSmoke(server.url, receiptPath.replace(/\.json$/, '-dual-runtime.json'), playwrightPackage);
        assert.equal((await hashTree(root)).sha256, before.sha256, 'Smoke must retain the exact compiled artifact');
        report.cases.push({ variant: build.variant, configSha256: build.configSha256, package: before, cases, requests: server.requests, remoteBundles: settings.assets.remoteBundles, passed: true });
      } finally { await server.close(); }
    }
    report.passed = true;
    delete report.pending;
  } catch (error) { report.failure = String(error); throw error; }
  finally { await writeFile(receiptPath, JSON.stringify(report, null, 2) + '\n'); }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const report = await buildSmoke(process.argv[2], process.argv[3], process.argv[4], { dualRuntime: process.argv[5] !== '--boot-only' });
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(c => ({ variant: c.variant, passed: c.passed })), receiptPath: process.argv[3] }));
}
