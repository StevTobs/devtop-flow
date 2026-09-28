import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const bundled = await build({
  entryPoints: ['src/lib/chatSessions.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm',
  plugins: [{ name: 'mock-files', setup(build) {
    build.onResolve({ filter: /^\.\/fileSystem$/ }, () => ({ path: 'files', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents:
      'export const createFile = (...args) => globalThis.testFiles.write(...args); export const readFile = (...args) => globalThis.testFiles.read(...args);' }));
  } }],
});
const { saveSessions, loadSessions, newSession } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('serializes project saves and waits before loading history', async () => {
  let release;
  let saved;
  let writes = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  globalThis.testFiles = {
    async write(_path, payload) {
      writes++;
      if (writes === 1) await blocked;
      saved = payload;
    },
    async read() { return saved; },
  };
  const first = newSession();
  const second = { ...first, title: 'Latest' };
  const a = saveSessions('/project', [first], first.id);
  const b = saveSessions('/project', [second], second.id);
  const load = loadSessions('/project');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1, 'second write must wait for first');
  release();
  await Promise.all([a, b]);
  assert.equal((await load).sessions[0].title, 'Latest');
  assert.equal(writes, 2);
});
