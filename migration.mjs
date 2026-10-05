import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join, parse } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathLease } from './path-lease.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args]);
const normalized = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (root, path) => { const rel = relative(root, path); return !rel.startsWith('..') && !parse(rel).root; };
const excludedDirectories = new Set(['node_modules', '.git', '__pycache__', '.cache']);

/** Reject links/junctions in every existing ancestor, including workspace and source roots. */
async function safePath(path, allowMissing = false, lease) {
  const absolute = resolve(path), anchor = parse(absolute).root;
  let current = anchor, missing = false, nearestExisting = anchor;
  for (const part of relative(anchor, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(cause => {
      if (allowMissing && cause.code === 'ENOENT') { missing = true; return null; }
      throw cause;
    });
    if (!info) continue;
    if (missing || info.isSymbolicLink())
      throw new Error(`Unsafe symlink/junction path: ${current}`);
    nearestExisting = current;
  }
  if (normalized(await realpath(nearestExisting)) !== normalized(nearestExisting))
    throw new Error(`Unsafe symlink/junction path: ${nearestExisting}`);
  if (lease) await lease.lock(nearestExisting);
  return absolute;
}

async function createDirectory(path, boundary, lease) {
  if (!inside(boundary, path)) throw new Error('Escaping target');
  await safePath(path, true, lease);
  const existing = await lstat(path).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (!existing) {
    if (path !== boundary) await createDirectory(dirname(path), boundary, lease);
    await lease.mkdir(path);
  } else if (!existing.isDirectory()) throw new Error(`Target ancestor is not a directory: ${path}`);
  await safePath(path, false, lease);
}

/** Freeze selected bytes before writing; never overwrite or follow source/target links. */
async function migrateWithLease(workspace, target, lease) {
  const root = await safePath(workspace, false, lease), output = resolve(target);
  if (normalized(output) !== normalized(join(root, 'P4000', 'ant-cook')))
    throw new Error('Target must be the approved ant-cook project');
  await safePath(output, true, lease);
  const specs = [
    ['ant', 'P4000/colony-flow-food-hunt', 'assets/Colony', 'assets/Colony'],
    ['ant', 'P4000/colony-flow-food-hunt', 'assets/Colony.meta', 'assets/Colony.meta'],
    ['shared', 'P4000/colony-flow-food-hunt', 'assets/resources', 'assets/resources'],
    ['shared', 'P4000/colony-flow-food-hunt', 'assets/resources.meta', 'assets/resources.meta'],
    ['shared', 'P4000/colony-flow-food-hunt', 'extensions/MKFramework', 'extensions/MKFramework'],
    ['cook', 'P4000/cook', 'assets/bundles', 'assets/bundles'],
    ['cook', 'P4000/cook', 'assets/bundles.meta', 'assets/bundles.meta'],
    ['ant-tests', 'P4000/colony-flow-food-hunt', 'Tests', 'tests/ant'],
    ['cook-tests', 'P4000/cook', 'tests', 'tests/cook'],
  ];
  async function repoSnapshot(repo) {
    const cwd = await safePath(join(root, repo), false, lease);
    if (normalized(git(cwd, 'rev-parse', '--show-toplevel').toString().trim()) !== normalized(cwd))
      throw new Error(`Source must be its own Git repository: ${repo}`);
    const versionBytes = await lease.read(await safePath(join(cwd, 'VERSION'), false, lease));
    return { head: git(cwd, 'rev-parse', 'HEAD').toString().trim(), version: versionBytes.toString().trim(),
      versionSha256: hash(versionBytes), statusSha256: hash(git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all')),
      indexSha256: hash(git(cwd, 'ls-files', '--stage', '-z')) };
  }
  const sources = new Map();
  for (const [, repo] of specs) if (!sources.has(repo)) sources.set(repo, await repoSnapshot(repo));
  async function inventory() {
    const result = [];
    async function visit(mode, repo, from, to) {
      const source = await safePath(join(root, repo, from), false, lease);
      if (!inside(join(root, repo), source)) throw new Error('Escaping source');
      const info = await lstat(source);
      if (info.isDirectory()) {
        for (const name of (await readdir(source)).sort())
          if (!excludedDirectories.has(name)) await visit(mode, repo, join(from, name), join(to, name));
      } else if (info.isFile()) result.push({ mode, repository: repo, source: from.replaceAll('\\', '/'), destination: to.replaceAll('\\', '/') });
      else throw new Error(`Unsupported source type: ${source}`);
    }
    for (const spec of specs) await visit(...spec);
    return result;
  }
  const selected = await inventory(), files = [], frozen = [];
  const destinationKeys = new Set();
  const manifestPath = join(output, 'MIGRATION_SOURCES.json');
  for (const record of [...selected, { destination: 'MIGRATION_SOURCES.json' }]) {
    const destination = join(output, record.destination);
    if (!inside(output, destination)) throw new Error('Escaping target');
    await safePath(destination, true, lease);
    if (destinationKeys.has(normalized(destination))) throw new Error('Duplicate destination');
    destinationKeys.add(normalized(destination));
    const exists = await lstat(destination).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (exists) throw new Error(`Target already exists: ${destination}`);
  }
  for (const record of selected) {
    const bytes = await lease.read(await safePath(join(root, record.repository, record.source), false, lease));
    let indexBlob = null;
    try { indexBlob = git(join(root, record.repository), 'rev-parse', `:${record.source}`).toString().trim(); } catch {}
    files.push({ ...record, head: sources.get(record.repository).head, size: bytes.length, sha256: hash(bytes), indexBlob });
    frozen.push(bytes);
  }
  async function verifySources() {
    if (JSON.stringify(await inventory()) !== JSON.stringify(selected)) throw new Error('Source file set changed');
    for (const record of files)
      if (hash(await lease.read(await safePath(join(root, record.repository, record.source), false, lease))) !== record.sha256)
        throw new Error(`Source bytes changed: ${record.repository}/${record.source}`);
    for (const [repo, snapshot] of sources)
      if (JSON.stringify(await repoSnapshot(repo)) !== JSON.stringify(snapshot)) throw new Error(`Source Git/version snapshot changed: ${repo}`);
  }
  await verifySources();
  // Existing scaffold is allowed; imported destinations themselves must all be absent.
  await createDirectory(output, join(root, 'P4000'), lease);
  for (let i = 0; i < files.length; i++) {
    const destination = join(output, files[i].destination);
    await createDirectory(dirname(destination), output, lease);
    await safePath(destination, true, lease);
    await lease.writeNew(destination, frozen[i]);
    await safePath(destination, false, lease);
    if (hash(await lease.read(destination)) !== files[i].sha256) throw new Error(`Copy mismatch: ${files[i].destination}`);
  }
  await verifySources();
  const manifest = { schemaVersion: 1, observedAt: new Date().toISOString(), sources: Object.fromEntries(sources),
    provider: { p0002: '2384980aab0c2bb60559b22cbef88d2c1391d784', mk: 'v1.1.5' },
    excluded: ['old startup scenes', 'old bridge/settings/SDK', 'cook global MultTextures plugin', 'art workbench', 'node_modules'], files };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await safePath(manifestPath, true, lease);
  await lease.writeNew(manifestPath, bytes);
  await safePath(manifestPath, false, lease);
  return { copiedFiles: files.length, manifestSha256: hash(bytes), sources: manifest.sources };
}

export async function migrate(workspace, target) {
  // Validate ancestors before opening handles, then lock every path within the
  // writable workspace/Temp boundary against concurrent replacement.
  await safePath(workspace);
  const lease = await pathLease(workspace);
  try { return await migrateWithLease(workspace, target, lease); }
  finally { await lease.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  console.log(JSON.stringify(await migrate(process.argv[2], process.argv[3]), null, 2));
