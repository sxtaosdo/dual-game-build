import { acquirePreviewPage } from '../cocos-mcp/mcp/dist/companion/edge-session.js';
import { writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

export async function finalizeRuntimeReceipt(path, receipt, lease) {
  let cleanupError;
  try { await lease?.release(); }
  catch (error) {
    cleanupError = error; receipt.cleanupFailure = String(error); receipt.passed = false;
    receipt.failure ??= String(error);
  } finally { await writeFile(path, JSON.stringify(receipt, null, 2) + '\n'); }
  return cleanupError;
}
// Each run owns a fresh Edge browser context. It never reads a user's browser profile.
export async function runtimeSmoke(url, receiptPath, playwrightPackage) {
  const target = new URL(url);
  if (!['localhost', '127.0.0.1', '192.168.31.100'].includes(target.hostname)) throw Error('Runtime smoke requires an explicitly supported local artifact/Preview URL');
  const path = resolve(receiptPath), rel = relative(resolve(tmpdir()), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Runtime receipt must stay in task Temp');
  const receipt = { observedAt: new Date().toISOString(), url, browser: 'msedge', edgeChain: 'Creator AI Companion acquirePreviewPage', freshContexts: true, cases: [], passed: false };
  let livePage, liveErrors, liveWarnings, liveLease;
  try {
    for (const scenario of ['ant', 'cook', 'cook-startup-failure']) {
      const initial = scenario === 'ant' ? 'ant' : 'cook', startupFailure = scenario === 'cook-startup-failure';
      const launch = new URL(url); launch.searchParams.set('mode', initial);
      const lease = liveLease = await acquirePreviewPage(launch.href, { mode: 'isolated', viewport: { width: 390, height: 844 } });
      assert.equal(lease.mode, 'isolated'); assert.equal(lease.reusedBrowser, false); assert.equal(lease.reusedPage, false);
      const page = lease.page, errors = [], warnings = [];
      livePage = page; liveErrors = errors; liveWarnings = warnings;
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); else if (m.type() === 'warning') warnings.push(m.text()); });
      await page.addInitScript(startupFailure => {
        globalThis.__dualSaveFail = startupFailure;
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (globalThis.__dualSaveFail && key.startsWith('p4000.ant-cook.dev1.')) throw new DOMException('Task-scoped save fault', 'QuotaExceededError');
          return write.call(this, key, value);
        };
        globalThis.__dualShell = () => globalThis.cc?.director?.getScene?.()?.children.find(n => n.name === 'ProductShell')?.components.find(c => c.constructor.name === 'ProductBootstrap');
        globalThis.__dualSnapshot = () => {
          const s = __dualShell(), a = s?.coordinator?.active ?? s?.coordinator?.pendingStart?.module;
          return { mode: s?.coordinator?.currentMode, status: s?.status?.string, transitioning: s?.transitioning,
            ready: a?.ready, inputLocked: a?.inputLocked, cleanupBlockedMode: s?.coordinator?.cleanupBlockedMode,
            page: a?.bootstrap?.StateMachine?.current?.constructor.name ?? a?.StateMachine?.current?.constructor.name,
            economy: a?.id === 'cook' ? a.application.read().progress : a?.progress?.snapshot(),
            settings: a?.id === 'cook' ? a.application.read().progress.settings : a?.settings?.snapshot(),
            activity: a?.dailyActivity && { pending: a.dailyActivity.buffer.pending, batch: a.dailyActivity.buffer.batch },
            saves: Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('p4000.ant-cook.dev1.')).sort().map(k => [k, localStorage.getItem(k)])) };
        };
      }, startupFailure);
      await lease.ensureLoaded();
      const waitReady = mode => page.waitForFunction(mode => {
        const s = globalThis.__dualShell?.();
        return s?.coordinator?.currentMode === mode && !s.transitioning && s.coordinator.active?.ready && !s.coordinator.active?.inputLocked;
      }, mode, { timeout: 45000 });
      let startupBlocked;
      if (startupFailure) {
        await page.waitForFunction(() => { const s = globalThis.__dualShell?.(); return !!s?.coordinator?.pendingStart && !s.transitioning; }, null, { timeout: 45000 });
        startupBlocked = await page.evaluate(() => __dualSnapshot());
        assert.equal(startupBlocked.mode, null); assert.equal(startupBlocked.ready, false); assert.equal(startupBlocked.inputLocked, true);
        assert.equal(await page.evaluate(async () => { globalThis.__dualSaveFail = false; return __dualShell().coordinator.retrySave(); }), true);
      }
      await waitReady(initial);
      const first = await page.evaluate(() => __dualSnapshot());
      const other = initial === 'ant' ? 'cook' : 'ant';
      // Exercise actual persisted preference commands and verify their own namespace survives re-entry.
      await page.evaluate(() => { const a = __dualShell().coordinator.active; if (a.id === 'ant') a.settings.toggleSound(); else a.application.setSetting('effectsVolume', 0); });
      const changed = await page.evaluate(() => __dualSnapshot());
      assert.equal(initial === 'ant' ? changed.settings.soundEnabled : changed.settings.effectsVolume, initial === 'ant' ? false : 0);
      await page.evaluate(async mode => { await __dualShell().openMode(mode); }, other);
      await waitReady(other);
      const second = await page.evaluate(() => __dualSnapshot());
      await page.evaluate(async mode => { await __dualShell().openMode(mode); }, initial);
      await waitReady(initial);
      const returned = await page.evaluate(() => __dualSnapshot());
      assert.deepEqual(returned.settings, changed.settings, `${initial} own settings must persist`);
      for (const key of ['coins', 'diamonds', 'stars', 'stamps', 'vouchers', 'supplyTokens', 'clearedLevels', 'unlockedRestaurants'])
        if (key in first.economy) assert.deepEqual(returned.economy[key], first.economy[key], `${initial} ${key} must remain independent`);
      assert.notDeepEqual(Object.keys(returned.saves).filter(k => k.includes('.ant.')), []);
      assert.notDeepEqual(Object.keys(returned.saves).filter(k => k.includes('.cook.')), []);
      // A flush fault must preserve the source, block its input, and never enter the destination.
      await page.evaluate(() => { globalThis.__dualSaveFail = true; });
      await page.evaluate(async mode => { await __dualShell().openMode(mode); }, other);
      const blocked = await page.evaluate(() => __dualSnapshot());
      assert.equal(blocked.mode, initial); assert.equal(blocked.inputLocked, true);
      assert.deepEqual(blocked.saves, returned.saves, 'Failed flush must retain all persisted bytes');
      const retry = await page.evaluate(async () => { globalThis.__dualSaveFail = false; return __dualShell().coordinator.retrySave(); });
      assert.equal(retry, true); await waitReady(initial);
      await page.evaluate(async mode => { await __dualShell().openMode(mode); }, other);
      await waitReady(other);
      // Readiness is sampled across real animation frames, after all entry/close promises settled.
      const sustained = await page.evaluate(async () => {
        const samples = [];
        for (let i = 0; i < 120; i++) { await new Promise(resolve => requestAnimationFrame(resolve)); const s = __dualSnapshot(); if (i % 20 === 0) samples.push(s); }
        return samples;
      });
      assert(sustained.every(s => s.mode === other && s.ready && !s.inputLocked && !s.transitioning && !s.cleanupBlockedMode));
      assert.equal(errors.length, 0, JSON.stringify(errors));
      receipt.cases.push({ scenario, initial, startupBlocked, first, changed, second, returned, blocked, retry, sustained, errors, warnings, passed: true });
      await page.screenshot({ path: path.replace(/\.json$/, `-${scenario}-final.png`) });
      await lease.release(); liveLease = null;
    }
    receipt.passed = true;
  } catch (error) {
    receipt.failure = String(error); receipt.errors = liveErrors; receipt.warnings = liveWarnings;
    if (livePage) {
      receipt.failedState = await livePage.evaluate(() => globalThis.__dualSnapshot?.()).catch(() => null);
      await livePage.screenshot({ path: path.replace(/\.json$/, '-failed.png') }).catch(() => {});
    }
    throw error;
  }
  finally {
    const originalFailure = receipt.failure;
    const cleanupError = await finalizeRuntimeReceipt(path, receipt, liveLease);
    if (cleanupError && !originalFailure) throw cleanupError;
  }
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runtimeSmoke(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify({ passed: result.passed, cases: result.cases.map(c => ({ initial: c.initial, passed: c.passed })), receiptPath: process.argv[3] }));
}
