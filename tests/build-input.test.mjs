import assert from 'node:assert/strict';
import test from 'node:test';
import { collectReferences, inventory, plan, stage, verifyInput } from '../build-input.mjs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const product = fileURLToPath(new URL('../../../P4000/ant-cook/', import.meta.url));
const taskTemp = resolve(tmpdir(), 'shidai3-dual-game-build');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = async path => !(await stat(path).catch(() => null));
async function fixture(t) {
  await mkdir(taskTemp, { recursive: true });
  const root = await mkdtemp(join(taskTemp, 'unit-')), source = join(root, 'source');
  t.after(async () => {
    assert.ok(resolve(root).startsWith(taskTemp + '/') || resolve(root).startsWith(taskTemp + '\\'));
    await rm(root, { recursive: true, force: true });
  });
  async function put(path, text) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), text); }
  async function copy(from, to = from) { await mkdir(dirname(join(source, to)), { recursive: true }); await copyFile(join(product, from), join(source, to)); }
  // Serialized assets/meta are copied unchanged from the authorized new project; no Creator assets are authored here.
  const shared = JSON.parse(await readFile(join(product, 'SHARED_ASSETS.json'), 'utf8'));
  await copy(shared.assets[0].source); await copy(shared.assets[0].source + '.meta');
  await copy('assets/resources/Module/@Common/Mask/ResourcesCommonMask.prefab');
  await copy('assets/Colony/popups/resultPopupNav.ts.meta', 'assets/Colony/ant.ts.meta');
  await copy('assets/bundles/game/GameRoot.ts.meta', 'assets/bundles/game/cook.ts.meta');
  await put('assets/Colony/ant.ts', 'export const ant = true;\n');
  await put('assets/bundles/game/cook.ts', 'export const cook = true;\n');
  await put('assets/shell/buildModes.ts', 'export const BUILD_MODES = [];\n');
  await put('assets/shell/contracts.ts', 'export interface ModuleDescriptor { id: string }\n');
  await put('SHARED_ASSETS.json', JSON.stringify(shared));
  await copy('import-map.json'); await copy('settings/v2/packages/project.json');
  const imports = JSON.parse(await readFile(join(source, 'import-map.json'), 'utf8')).imports;
  for (const path of Object.values(imports)) await put(path, '// provider fixture\n');
  await put('package.json', '{"name":"fixture","creator":{"version":"3.8.8"}}');
  await put('tsconfig.json', '{}');
  await put('extensions/shidai3/assets/examples/run.ts', "throw Error('development entry must not run');\n");
  await put('extensions/shidai3/assets/foundation-core/runtime.ts', 'export const providerRuntime = true;\n');
  return { root, source, shared, put, copy, destination: variant => join(root, variant) };
}
const entries = [
  { path: 'assets/shell/contracts.ts', uuids: [], references: [] },
  { path: 'assets/Colony/ant.ts.meta', uuids: ['ant-uuid'], references: [] },
  { path: 'assets/bundles/game/cook.ts.meta', uuids: ['cook-uuid'], references: [] },
];
test('three selections physically omit the excluded private paths and UUIDs', () => {
  assert.deepEqual(verifyInput(entries.slice(0, 2), 'ant', entries).modes, ['ant']);
  assert.deepEqual(verifyInput([entries[0], entries[2]], 'cook', entries).modes, ['cook']);
  assert.deepEqual(verifyInput(entries, 'both', entries).modes, ['ant', 'cook']);
});
test('a hidden entrance cannot excuse excluded private files or references', () => {
  assert.throws(() => verifyInput(entries, 'ant', entries), /Excluded cook content/);
  assert.throws(() => verifyInput([{ ...entries[0], references: ['cook-uuid'] }, entries[1]], 'ant', entries), /Reference to excluded/);
});
test('duplicate UUIDs across providers/assets cannot be staged', () => {
  assert.throws(() => verifyInput([...entries, { path: 'extensions/other.ts.meta', uuids: ['ant-uuid'] }], 'both', entries), /Duplicate UUID/);
});
test('unselected bundle root UUIDs and their references are excluded too', () => {
  const roots = [{ path: 'assets/Colony.meta', uuids: ['ant-root'], references: [] }, { path: 'assets/bundles/game.meta', uuids: ['cook-root'], references: [] }];
  for (const [variant, excluded] of [['ant', 'cook-root'], ['cook', 'ant-root']]) {
    assert.throws(() => verifyInput([{ path: 'assets/resources/root.json', uuids: [], references: [excluded] }], variant, roots), /Reference to excluded/);
    assert.throws(() => verifyInput([{ path: 'assets/resources/root.meta', uuids: [excluded], references: [] }], variant, roots), /Excluded private UUID/);
  }
});

test('stage produces three physical inputs, shared bytes/UUID, runtime mapping and hash manifests', async t => {
  const f = await fixture(t);
  for (const variant of ['ant', 'cook', 'both']) {
    const output = f.destination(variant), result = await stage(f.source, variant, output, { requireBootstrap: false });
    const planned = await plan(f.source, variant);
    assert.equal(planned.files, result.files); assert.equal(planned.uuidCount, result.uuidCount);
    const manifest = JSON.parse(await readFile(join(output, 'BUILD_INPUT.json'), 'utf8'));
    assert.equal(result.manifestSha256, hash(await readFile(join(output, 'BUILD_INPUT.json'))));
    assert.equal(manifest.readyForCreatorBuild, false); assert.equal(manifest.importMapValid, true);
    assert.equal(manifest.sharedConfigSha256, hash(await readFile(join(f.source, 'SHARED_ASSETS.json'))));
    for (const file of manifest.copiedFiles) if (!file.generated) assert.equal(file.sha256, file.sourceSha256);
    assert.equal(await readFile(join(output, 'import-map.json'), 'utf8'), await readFile(join(f.source, 'import-map.json'), 'utf8'));
    assert.equal(await missing(join(output, 'assets/Colony/ant.ts')), variant === 'cook');
    assert.equal(await missing(join(output, 'assets/bundles/game/cook.ts')), variant === 'ant');
    assert.equal(await missing(join(output, 'extensions/shidai3/assets/examples/run.ts')), true);
    assert.equal(await missing(join(output, 'extensions/shidai3/assets/foundation-core/runtime.ts')), false);
    assert.deepEqual(manifest.providerExclusions.map(e => e.path), ['extensions/shidai3/assets/examples/run.ts']);
    const asset = f.shared.assets[0];
    assert.equal(hash(await readFile(join(output, asset.destination))), asset.sourceSha256);
    assert.equal(hash(await readFile(join(output, asset.destination + '.meta'))), asset.metaSha256);
    assert.equal(await missing(join(output, asset.source)), true);
    assert.ok((await readFile(join(output, 'assets/shell/buildModes.ts'), 'utf8')).includes(variant === 'cook' ? '"cook"' : '"ant"'));
    await assert.rejects(stage(f.source, variant, output, { requireBootstrap: false }), /EEXIST/);
  }
});

test('invalid promotion path, hash, UUID, schema and duplicate approval are rejected before any output write', async t => {
  const f = await fixture(t);
  const mutations = [
    c => { c.assets[0].destination = '../escape.png'; },
    c => { c.assets[0].destination = 'assets/resources/../escape.png'; },
    c => { c.assets[0].source = 'D:/escape.png'; },
    c => { c.assets[0].destination = 'assets/bundles/game/shared.png'; },
    c => { c.assets[0].sourceSha256 = '0'.repeat(64); },
    c => { c.assets[0].metaSha256 = '0'.repeat(64); },
    c => { c.assets[0].uuid = '00000000-0000-0000-0000-000000000000'; },
    c => { c.schemaVersion = 99; },
    c => { c.assets.push(c.assets[0]); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const config = structuredClone(f.shared); mutate(config); await f.put('SHARED_ASSETS.json', JSON.stringify(config));
    const output = f.destination(`invalid-${index}`);
    await assert.rejects(stage(f.source, 'both', output, { requireBootstrap: false }), /shared asset|Shared asset|Duplicate shared/i);
    assert.equal(await missing(output), true);
  }
});

test('existing promoted destination, missing import-map and missing Bootstrap prevent staging', async t => {
  const f = await fixture(t);
  await assert.rejects(stage(f.source, 'ant', f.destination('no-bootstrap')), /Creator-authored/);
  assert.equal(await missing(f.destination('no-bootstrap')), true);
  await f.put('settings/v2/packages/project.json', '{}');
  await assert.rejects(stage(f.source, 'ant', f.destination('no-map'), { requireBootstrap: false }), /script.importMap/);
  assert.equal(await missing(f.destination('no-map')), true);
  await f.copy('settings/v2/packages/project.json');
  await f.copy(f.shared.assets[0].source, f.shared.assets[0].destination);
  await assert.rejects(stage(f.source, 'both', f.destination('collision'), { requireBootstrap: false }), /Shared destination already exists/);
  assert.equal(await missing(f.destination('collision')), true);
});

test('real serialized compressed UUID references exclude unselected script types with 22/23 chars and subassets', async t => {
  const f = await fixture(t), original = await inventory(f.source);
  const uuid = '7c2b9c83-0a19-41bd-8ddd-52dfa0dd8fe2';
  const hex = uuid.replaceAll('-', ''), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const compressed = prefix => {
    let result = hex.slice(0, prefix);
    for (let i = prefix; i < hex.length; i += 3) { const n = parseInt(hex.slice(i, i + 3), 16); result += alphabet[n >> 6] + alphabet[n & 63]; }
    return result;
  };
  const ant = original.filter(entry => !entry.path.startsWith('assets/bundles/game/')).map(entry => entry.sharedDestination ? { ...entry, path: entry.sharedDestination } : entry);
  for (const value of [compressed(2), compressed(5), compressed(2) + '@f9941']) {
    const refs = collectReferences([{ __type__: value }, { nested: { __uuid__: value } }]);
    assert.equal(refs[0].split('@')[0], uuid);
    assert.throws(() => verifyInput([...ant, { path: 'assets/shell/test.ts', uuids: [], references: refs }], 'ant', original), /Reference to excluded/);
  }
  assert.equal((await plan(f.source, 'both')).importMapValid, true);
});

test('a linked output ancestor cannot redirect staging outside task Temp', async t => {
  const f = await fixture(t), external = await mkdtemp(join(tmpdir(), 'shidai3-build-link-test-'));
  t.after(async () => {
    assert.ok(resolve(external).startsWith(resolve(tmpdir()) + '/') || resolve(external).startsWith(resolve(tmpdir()) + '\\'));
    await rm(external, { recursive: true, force: true });
  });
  const linked = join(f.root, 'linked');
  await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stage(f.source, 'both', join(linked, 'output'), { requireBootstrap: false }), /symlink\/junction/);
  assert.equal(await missing(join(external, 'output')), true);
  const rootLink = join(f.root, 'temp-root-link'), newParent = `shidai3-escape-${f.root.split(/[\\/]/).at(-1)}`;
  await symlink(tmpdir(), rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stage(f.source, 'both', join(rootLink, newParent, 'output'), { requireBootstrap: false }), /symlink\/junction/);
  assert.equal(await missing(join(tmpdir(), newParent)), true);
  await assert.rejects(stage(f.source, 'both', join(external, 'outside'), { requireBootstrap: false }), /beneath the task Temp/);
});
