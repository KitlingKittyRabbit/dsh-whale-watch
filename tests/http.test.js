import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from '../src/http.js';

test('面板写入拒绝跨站和无来源请求；正常同源请求可保存复核', async t => {
  let writes = 0;
  const handler = createHandler({ state: () => ({ ok: true }), review: async data => { writes++; return data; } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = origin => fetch(base + '/plugins/dafeiyu-patrol/api/review', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ id: 'test', verdict: 'dismissed' }) });
  assert.equal((await request('https://evil.example')).status, 403);
  assert.equal((await request()).status, 403);
  assert.equal(writes, 0);
  assert.equal((await request(base)).status, 200);
  assert.equal(writes, 1);
});

test('配图接口只读取记录中的附件，不允许通过参数读取任意文件或地址', async t => {
  const ref = { attachmentId: 'sha256:fixture', mediaType: 'image/png' }; let reads = 0;
  const handler = createHandler({ store: { data: { items: [{ id: 'fixture', images: [{ index: 1, attachment: ref }] }] } }, model: { ctx: { attachments: { readImage: async image => { assert.deepEqual(image, ref); reads++; return { ref, data: Buffer.from([1, 2, 3]) }; } } } } });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/plugins/dafeiyu-patrol/api/image/`;
  const response = await fetch(base + 'fixture/1'); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.equal((await fetch(base + 'fixture/2')).status, 404); assert.equal(reads, 1);
});
