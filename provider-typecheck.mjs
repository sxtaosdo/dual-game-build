import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Preserve strict diagnostics; compare local Provider patches with their byte-verified source baseline. */
export function checkProvider(project, workspace) {
  project = resolve(project); workspace = resolve(workspace);
  const ts = createRequire(join(project, 'package.json'))('typescript');
  const manifest = JSON.parse(readFileSync(join(project, 'MIGRATION_SOURCES.json'), 'utf8'));
  const overrides = new Map(), reviewedSources = [];
  for (const file of manifest.files) {
    if (!file.destination.startsWith('extensions/MKFramework/') || !file.destination.endsWith('.ts')) continue;
    const currentPath = resolve(project, file.destination), current = readFileSync(currentPath);
    if (hash(current) === file.sha256) continue;
    const original = readFileSync(resolve(workspace, file.repository, file.source));
    if (hash(original) !== file.sha256) throw Error(`Provider source baseline changed: ${file.source}`);
    overrides.set(ts.sys.useCaseSensitiveFileNames ? currentPath : currentPath.toLowerCase(), original.toString('utf8'));
    reviewedSources.push({ path: file.destination, sourceSha256: file.sha256, currentSha256: hash(current) });
  }
  const configPath = join(project, 'tests/tsconfig.provider.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  function diagnostics(baseline) {
    const host = ts.createCompilerHost(parsed.options), read = host.readFile.bind(host);
    if (baseline) host.readFile = path => overrides.get(ts.sys.useCaseSensitiveFileNames ? resolve(path) : resolve(path).toLowerCase()) ?? read(path);
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true }, host);
    return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(d => ({
      path: d.file ? relative(project, d.file.fileName).replaceAll('\\', '/') : null,
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
      code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    }));
  }
  const baseline = diagnostics(true), current = diagnostics(false);
  const remaining = new Map();
  for (const d of baseline) { const key = JSON.stringify([d.path, d.code, d.message]); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  const introduced = [];
  for (const d of current) {
    const key = JSON.stringify([d.path, d.code, d.message]), count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1); else introduced.push(d);
  }
  return { schemaVersion: 1, typescript: ts.version, strict: parsed.options.strict, scope: 'MK Provider patches compared with verified migration source',
    reviewedSources, baselineDiagnosticCount: baseline.length, currentDiagnosticCount: current.length, introduced,
    removedCount: [...remaining.values()].reduce((sum, count) => sum + count, 0), currentDiagnostics: current,
    passed: introduced.length === 0, cleanProviderTypecheck: current.length === 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = checkProvider(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
