import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const VARIANTS = { ant: ['ant'], cook: ['cook'], both: ['ant', 'cook'] };
const PRIVATE = { ant: 'assets/Colony', cook: 'assets/bundles/game' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const omitted = new Set(['.git', 'node_modules', 'library', 'temp', 'local', 'profiles', 'build', 'creator-ai-bridge']);
const IMPORTS = {
  mk: './extensions/MKFramework/assets/MKFramework/Framework/MKInit.ts',
  GlobalConfig: './extensions/MKFramework/assets/MKFramework/Config/GlobalConfig.ts',
  globalEvent: './extensions/MKFramework/assets/MKFramework/Config/GlobalEvent.ts',
};

function inside(root, target) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith('..' + '/') && !path.startsWith('..' + '\\') && !isAbsolute(path);
}
function assetPath(value) {
  return typeof value === 'string' && !isAbsolute(value) && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
      && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment));
}
async function outputBoundary(output) {
  const physicalTemp = await realpath(tmpdir()), physicalRoot = resolve(physicalTemp, 'shidai3-dual-game-build');
  let parent = dirname(output);
  while (!(await stat(parent).catch(() => null))) {
    const next = dirname(parent); if (next === parent) throw new Error('No safe staging parent'); parent = next;
  }
  const physicalParent = await realpath(parent);
  const futureParent = resolve(physicalParent, relative(parent, dirname(output)));
  if (futureParent !== physicalRoot && !inside(physicalRoot, futureParent))
    throw new Error('Staging parent escapes task Temp through a symlink/junction');
  return physicalRoot;
}
async function sharedAssets(project) {
  const bytes = await readFile(join(project, 'SHARED_ASSETS.json')).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (!bytes) return { assets: [], sha256: null };
  const config = JSON.parse(bytes.toString('utf8'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.assets)) throw new Error('Invalid shared asset schema');
  const sources = new Set(), destinations = new Set();
  for (const asset of config.assets) {
    if (!asset || !assetPath(asset.source) || !assetPath(asset.destination)
      || !Object.values(PRIVATE).some(path => asset.source.startsWith(path + '/'))
      || !asset.destination.startsWith('assets/resources/')
      || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(asset.source))
      || extname(asset.source) !== extname(asset.destination)) throw new Error('Invalid shared asset source/destination boundary');
    if (sources.has(asset.source) || destinations.has(asset.destination)) throw new Error('Duplicate shared asset source/destination');
    sources.add(asset.source); destinations.add(asset.destination);
    if (!/^[a-f0-9]{64}$/.test(asset.sourceSha256) || !/^[a-f0-9]{64}$/.test(asset.metaSha256)
      || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(asset.uuid)) throw new Error('Invalid shared asset hash/UUID approval');
    const source = await readFile(join(project, asset.source)), meta = await readFile(join(project, asset.source + '.meta'));
    if (sha256(source) !== asset.sourceSha256 || sha256(meta) !== asset.metaSha256) throw new Error(`Shared asset hash mismatch: ${asset.source}`);
    if (JSON.parse(meta.toString('utf8')).uuid !== asset.uuid) throw new Error(`Shared asset UUID mismatch: ${asset.source}`);
    if (await stat(join(project, asset.destination)).catch(() => null)
      || await stat(join(project, asset.destination + '.meta')).catch(() => null)) throw new Error(`Shared destination already exists: ${asset.destination}`);
  }
  return { assets: config.assets, sha256: sha256(bytes) };
}
async function runtimeMappings(project) {
  const settings = JSON.parse(await readFile(join(project, 'settings/v2/packages/project.json'), 'utf8'));
  const mapping = JSON.parse(await readFile(join(project, 'import-map.json'), 'utf8'));
  if (settings.script?.importMap !== 'project://import-map.json') throw new Error('Creator script.importMap is not configured');
  for (const [name, path] of Object.entries(IMPORTS)) {
    if (mapping.imports?.[name] !== path || !(await stat(join(project, path)).catch(() => null))?.isFile())
      throw new Error(`Creator runtime mapping missing or unexpected: ${name}`);
  }
}

async function filesIn(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (omitted.has(entry.name)) continue;
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not a closed build input: ${path}`);
    if (entry.isDirectory()) result.push(...await filesIn(root, path));
    else if (entry.isFile()) result.push(path.replaceAll('\\', '/'));
  }
  return result.sort();
}
function collectUuids(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (typeof value.uuid === 'string') output.push(value.uuid);
  for (const [key, nested] of Object.entries(value)) if (key !== 'uuid' && nested && typeof nested === 'object') collectUuids(nested, output);
  return output;
}
function decodeUuid(value) {
  const suffix = value.includes('@') ? value.slice(value.indexOf('@')) : '';
  const head = suffix ? value.slice(0, value.indexOf('@')) : value;
  if (head.length !== 22 && head.length !== 23) return value;
  const first = head.length === 22 ? 2 : 5;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let hex = head.slice(0, first);
  for (let i = first; i < head.length; i += 2) {
    const high = alphabet.indexOf(head[i]), low = alphabet.indexOf(head[i + 1]);
    if (high < 0 || low < 0) return value;
    hex += ((high << 6) | low).toString(16).padStart(3, '0');
  }
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-') + suffix;
}
export function collectReferences(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === '__uuid__' || key === '__type__') && typeof nested === 'string') output.push(decodeUuid(nested));
    else if (nested && typeof nested === 'object') collectReferences(nested, output);
  }
  return output;
}
export async function inventory(project) {
  const shared = (await sharedAssets(project)).assets;
  const entries = [];
  for (const path of await filesIn(project)) {
    if (!path.startsWith('assets/') && !path.startsWith('extensions/')) continue;
    const bytes = await readFile(join(project, path));
    let serialized = null;
    if (/\.(meta|scene|prefab|json)$/.test(path)) {
      try { serialized = JSON.parse(bytes.toString()); }
      catch (cause) { if (!path.startsWith('extensions/') || !path.endsWith('.json')) throw new Error(`Invalid serialized asset ${path}: ${cause}`); }
    }
    const promoted = shared.find(asset => path === asset.source || path === asset.source + '.meta');
    const sharedDestination = promoted ? promoted.destination + (path.endsWith('.meta') ? '.meta' : '') : undefined;
    entries.push({ path, size: bytes.length, sha256: sha256(bytes), uuids: path.endsWith('.meta') ? collectUuids(serialized) : [], references: collectReferences(serialized), ...(sharedDestination ? { sharedDestination } : {}) });
  }
  return entries;
}
export function verifyInput(entries, variant, originalInventory) {
  const modes = VARIANTS[variant];
  if (!modes) throw new Error('Variant must be ant, cook or both');
  const seen = new Map();
  const paths = new Set();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`Duplicate destination path: ${entry.path}`);
    paths.add(entry.path);
    for (const [mode, path] of Object.entries(PRIVATE)) if (!modes.includes(mode) && (entry.path === `${path}.meta` || entry.path.startsWith(`${path}/`)))
      throw new Error(`Excluded ${mode} content exists: ${entry.path}`);
    for (const uuid of entry.uuids) {
      const owner = seen.get(uuid);
      if (owner && owner !== entry.path) throw new Error(`Duplicate UUID ${uuid}: ${owner} / ${entry.path}`);
      seen.set(uuid, entry.path);
    }
  }
  const excludedUuids = new Set(originalInventory.filter(entry => !entry.sharedDestination && Object.entries(PRIVATE).some(([mode, path]) => !modes.includes(mode)
    && (entry.path === `${path}.meta` || entry.path.startsWith(`${path}/`)))).flatMap(entry => entry.uuids));
  for (const uuid of seen.keys()) if (excludedUuids.has(uuid)) throw new Error(`Excluded private UUID still present: ${uuid}`);
  for (const entry of entries) for (const ref of entry.references ?? []) if (excludedUuids.has(ref) || excludedUuids.has(ref.split('@')[0]))
    throw new Error(`Reference to excluded private content: ${entry.path} -> ${ref}`);
  return { modes, files: entries.length, uuidCount: seen.size, excludedUuidCount: excludedUuids.size };
}
function selectedPaths(all, modes, promotions) {
  const scopes = ['assets/shell', 'assets/shell.meta', 'assets/resources', 'assets/resources.meta', 'settings',
    'extensions/MKFramework', 'extensions/shidai3', 'package.json', 'tsconfig.json', 'import-map.json'];
  if (modes.includes('ant')) scopes.push('assets/Colony', 'assets/Colony.meta');
  if (modes.includes('cook')) scopes.push('assets/bundles/game', 'assets/bundles/game.meta', 'assets/bundles.meta');
  // Creator executes every imported script in a build. Provider example entry
  // points are development material and must never become product boot code.
  return all.filter(path => !path.startsWith('extensions/shidai3/assets/examples/')
    && path !== 'extensions/shidai3/assets/examples.meta'
    && (promotions.has(path) || scopes.some(scope => path === scope || path.startsWith(scope + '/'))));
}
export async function plan(project, variant) {
  const modes = VARIANTS[variant];
  if (!modes) throw new Error('Variant must be ant, cook or both');
  const original = await inventory(project);
  await runtimeMappings(project);
  const promotions = new Map(original.filter(entry => entry.sharedDestination).map(entry => [entry.path, entry.sharedDestination]));
  const allowed = new Set(selectedPaths(original.map(entry => entry.path), modes, promotions));
  const selected = original.filter(entry => allowed.has(entry.path)).map(entry => entry.sharedDestination ? { ...entry, path: entry.sharedDestination } : entry);
  return { ...verifyInput(selected, variant, original), importMapValid: true, bootstrapPresent: selected.some(entry => entry.path === 'assets/shell/Bootstrap.scene') };
}

/** A separate disposable Creator project is the build input. The integration source is never pruned. */
export async function stage(project, variant, destination, { requireBootstrap = true } = {}) {
  const modes = VARIANTS[variant];
  if (!modes) throw new Error('Variant must be ant, cook or both');
  const source = resolve(project), output = resolve(destination);
  const tempRoot = resolve(tmpdir(), 'shidai3-dual-game-build');
  if (!inside(tempRoot, output)) throw new Error('Build input must be beneath the task Temp directory');
  const physicalRoot = await outputBoundary(output);
  await runtimeMappings(source);
  const originalInventory = await inventory(source);
  const shared = await sharedAssets(source);
  if (requireBootstrap && !(await stat(join(source, 'assets/shell/Bootstrap.scene')).catch(() => null))?.isFile())
    throw new Error('Creator-authored assets/shell/Bootstrap.scene is required before staging');
  const promotions = new Map(originalInventory.filter(entry => entry.sharedDestination).map(entry => [entry.path, entry.sharedDestination]));
  const all = await filesIn(source);
  const selected = selectedPaths(all, modes, promotions);
  const selectedInventory = originalInventory.filter(entry => selected.includes(entry.path))
    .map(entry => entry.sharedDestination ? { ...entry, path: entry.sharedDestination } : entry);
  verifyInput(selectedInventory, variant, originalInventory);
  const targets = new Set();
  const sourceHashes = new Map();
  for (const path of selected) {
    const target = resolve(output, promotions.get(path) ?? path);
    const identity = process.platform === 'win32' ? target.toLowerCase() : target;
    if (!inside(output, target) || targets.has(identity)) throw new Error(`Invalid or conflicting build destination: ${path}`);
    targets.add(identity); sourceHashes.set(promotions.get(path) ?? path, sha256(await readFile(join(source, path))));
  }
  // All source/config/reference validation precedes the first output write.
  // mkdir without recursive is the no-overwrite transaction boundary.
  await mkdir(dirname(output), { recursive: true });
  const physicalParent = await realpath(dirname(output));
  if (physicalParent !== physicalRoot && !inside(physicalRoot, physicalParent)) throw new Error('Staging parent is outside physical task Temp');
  await mkdir(output);
  for (const path of selected) {
    const target = join(output, promotions.get(path) ?? path); await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, path), target, constants.COPYFILE_EXCL);
  }
  const descriptors = modes.map(mode => ({ id: mode, bundleName: mode === 'ant' ? 'Colony' : 'game', sceneName: mode === 'ant' ? 'ColonyGame' : 'Game' }));
  await writeFile(join(output, 'assets/shell/buildModes.ts'), `import type { ModuleDescriptor } from './contracts';\nexport const BUILD_MODES: readonly ModuleDescriptor[] = ${JSON.stringify(descriptors)};\n`);
  await runtimeMappings(output);
  const staged = await inventory(output);
  const validation = verifyInput(staged, variant, originalInventory);
  // Every selected asset remains byte-identical except the one intentional generated selection file.
  const originalMap = new Map(originalInventory.map(entry => [entry.sharedDestination ?? entry.path, entry.sha256]));
  for (const entry of staged) if (entry.path !== 'assets/shell/buildModes.ts' && originalMap.get(entry.path) !== entry.sha256)
    throw new Error(`Staged asset/provider content changed: ${entry.path}`);
  const copiedFiles = [];
  for (const [path, hash] of sourceHashes) {
    const actual = sha256(await readFile(join(output, path)));
    if (path !== 'assets/shell/buildModes.ts' && hash !== actual) throw new Error(`Staged input changed: ${path}`);
    copiedFiles.push({ path, sha256: actual, sourceSha256: hash, generated: path === 'assets/shell/buildModes.ts' });
  }
  const manifest = { schemaVersion: 1, variant, validation, source, observedAt: new Date().toISOString(), entries: staged };
  manifest.readyForCreatorBuild = requireBootstrap;
  manifest.importMapValid = true;
  manifest.sharedConfigSha256 = shared.sha256;
  manifest.copiedFiles = copiedFiles;
  manifest.providerExclusions = all.filter(path => path.startsWith('extensions/shidai3/assets/examples/') || path === 'extensions/shidai3/assets/examples.meta')
    .map(path => ({ path, reason: 'Provider development examples are not product runtime' }));
  manifest.sharedPromotions = [...promotions].map(([from, to]) => ({ from, to, sha256: originalMap.get(to) }));
  await writeFile(join(output, 'BUILD_INPUT.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output, manifestSha256: sha256(await readFile(join(output, 'BUILD_INPUT.json'))), ...validation };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  console.log(JSON.stringify(await stage(process.argv[2], process.argv[3], process.argv[4]), null, 2));
}
