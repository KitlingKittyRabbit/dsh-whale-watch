import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildArtwork } from '../scripts/build-art.js';

test('两个前端随既有样式表交付完整图片，打包产物与原资源一致', async () => {
  await buildArtwork({ checkOnly: true });
  const image = await readFile(new URL('../ui/assets/watch-desk-duo-v2.webp', import.meta.url));
  for (const name of ['native.css', 'style.css']) {
    const css = await readFile(new URL(`../ui/${name}`, import.meta.url), 'utf8');
    const embedded = [...css.matchAll(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/g)];
    assert.equal(embedded.length, 1, `${name} 应只内嵌一份值班台图片`);
    assert.deepEqual(Buffer.from(embedded[0][1], 'base64'), image);
  }
  for (const name of ['client.js', 'index.html']) {
    const ui = await readFile(new URL(`../ui/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(ui, /\/assets\/watch-desk-duo/, '页头不再依赖新增图片路由');
  }
});
