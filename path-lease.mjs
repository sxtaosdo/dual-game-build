import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Fail closed when an OS-level no-delete path lease cannot be acquired. */
export async function pathLease(workspace) {
  if (process.platform !== 'win32') throw new Error('Migration requires Windows path leases; other platforms are unsupported');
  const physicalTemp = await realpath(tmpdir()), workspaceRoot = resolve(workspace);
  const tempRelative = relative(physicalTemp, workspaceRoot);
  const boundary = !tempRelative.startsWith('..') && !/^[A-Za-z]:/.test(tempRelative) ? physicalTemp : workspaceRoot;
  const child = spawn('python', ['-X', 'utf8', '-B', fileURLToPath(new URL('./windows-path-lease.py', import.meta.url)), boundary, workspaceRoot],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const replies = [], waiting = [];
  let ended = null, stderr = '';
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-3000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', text => {
    const value = JSON.parse(text);
    if (waiting.length) waiting.shift().resolve(value); else replies.push(value);
  });
  const failure = error => { ended = error; for (const waiter of waiting.splice(0)) waiter.reject(error); };
  child.stdin.on('error', failure);
  child.once('error', error => { failure(error); finish(); });
  child.once('exit', (code, signal) => { failure(new Error(`Path lease exited (${code ?? signal}): ${stderr}`)); finish(); });
  const receive = () => ended ? Promise.reject(ended) : replies.length ? Promise.resolve(replies.shift())
    : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  if (!(await receive()).ready) throw new Error('Path lease did not initialize');
  async function request(value) {
    if (ended) throw ended;
    child.stdin.write(JSON.stringify(value) + '\n');
    const result = await receive();
    if (!result.ok) throw new Error(`Unsafe or concurrently replaced path: ${result.error}`);
    return result;
  }
  return {
    async lock(path) { await request({ path }); },
    async mkdir(path) { await request({ op: 'mkdir', path }); },
    async read(path) { return Buffer.from((await request({ op: 'read', path })).bytes, 'base64'); },
    async writeNew(path, bytes) { return request({ op: 'write', path, bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }); },
    async close() {
      if (!ended) child.stdin.end();
      await completed;
    },
  };
}
