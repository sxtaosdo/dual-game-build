import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { stage } from './build-input.mjs';
import { hashTree } from './build-smoke.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Build disposable physical inputs in sequence. Creator's interactive lifecycle is not invoked. */
export async function creatorBuild(project, creatorExecutable, receiptPath) {
  project = resolve(project);
  const product = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  if (product.name !== 'ant-cook' || product.creator?.version !== '3.8.8') throw Error('This build contract is limited to ant-cook / Creator 3.8.8');
  const sourceHead = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  const root = join(tmpdir(), 'shidai3-dual-game-build', `creator-final-${randomUUID()}`);
  const report = { observedAt: new Date().toISOString(), source: project, sourceHead, root, sequential: true, results: [] };
  for (const variant of ['ant', 'cook', 'both']) {
    const staged = await stage(project, variant, join(root, variant));
    const scenePaths = ['assets/shell/Bootstrap.scene', ...(variant === 'cook' ? [] : ['assets/Colony/scenes/ColonyGame.scene']), ...(variant === 'ant' ? [] : ['assets/bundles/game/Game.scene'])];
    const scenes = await Promise.all(scenePaths.map(async path => ({ url: `db://${path}`, uuid: JSON.parse(await readFile(join(staged.output, path + '.meta'), 'utf8')).uuid })));
    const config = { name: 'web-mobile', platform: 'web-mobile', buildPath: 'project://build', debug: true, md5Cache: false,
      sourceMaps: false, replaceSplashScreen: false, experimentalEraseModules: false, startScene: scenes[0].uuid, scenes,
      excludedModules: [], packages: { 'web-mobile': { orientation: 'portrait', embedWebDebugger: false, remoteServerAddress: '' } } };
    const configPath = join(staged.output, 'web-mobile-build-config.json'), logPath = join(staged.output, 'creator-build.log');
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    const args = ['--disable-gpu', `--user-data-dir=${join(staged.output, 'temp/build-user-data')}`,
      '--project', staged.output, '--build', `configPath=${configPath};logDest=${logPath}`];
    const child = spawn(creatorExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const result = { variant, output: staged.output, staged, operationId: randomUUID(), sourceHead,
      configPath, configSha256: sha256(await readFile(configPath)), logPath, pid: child.pid, args, state: 'running' };
    report.results.push(result); await writeFile(receiptPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ variant, pid: child.pid, output: staged.output }));
    let stdout = '';
    child.stdout.on('data', bytes => { stdout += bytes.toString(); }); child.stderr.on('data', bytes => { stdout += bytes.toString(); });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    child.stdout.destroy(); child.stderr.destroy();
    // Creator also writes logDest itself. Preserve that complete log and separate stdout.
    await writeFile(join(staged.output, 'creator-stdout.log'), stdout);
    const log = await readFile(logPath, 'utf8').catch(() => stdout);
    Object.assign(result, exit, { builderFinished: /build Task\s*\([^)]*\)\s*Finished/i.test(log), logSha256: sha256(log) });
    result.artifactReady = !!(await readFile(join(staged.output, 'build/web-mobile/index.html')).catch(() => null));
    result.state = [0, 36].includes(exit.code) && !exit.signal && result.builderFinished && result.artifactReady ? 'passed' : 'failed';
    if (result.artifactReady) result.package = await hashTree(join(staged.output, 'build/web-mobile'));
    await writeFile(receiptPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ variant, state: result.state, code: exit.code, builderFinished: result.builderFinished, artifactReady: result.artifactReady }));
  }
  report.passed = report.results.every(result => result.state === 'passed');
  await writeFile(receiptPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await creatorBuild(process.argv[2], process.argv[3], process.argv[4]);
  if (!result.passed) process.exitCode = 1;
}
