import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const begin = '/* BEGIN GENERATED DESK ART — npm run art:build */';
const end = '/* END GENERATED DESK ART */';

// Ship the image with the existing stylesheet routes. Upgrading the UI then
// does not depend on a newly registered backend route or an external image host.
export async function buildArtwork({ checkOnly = false } = {}) {
  const image = await readFile(new URL('../ui/assets/watch-desk-duo-v2.webp', import.meta.url));
  if (image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('值班台图片不是有效的 WebP 文件');
  }
  for (const [file, scope] of [['native.css', '.patrol-native'], ['style.css', 'main']]) {
    const url = new URL(`../ui/${file}`, import.meta.url);
    const css = await readFile(url, 'utf8');
    const body = css.replace(/\n?\/\* BEGIN GENERATED DESK ART[^]*?\/\* END GENERATED DESK ART \*\/\n?/g, '').trimEnd();
    const generated = `${body}\n\n${begin}\n${scope}{--patrol-desk-art-image:url("data:image/webp;base64,${image.toString('base64')}")}\n${end}\n`;
    if (checkOnly && css !== generated) throw new Error(`${file} 的内嵌图片已过期，请运行 npm run art:build`);
    if (!checkOnly && css !== generated) await writeFile(url, generated);
  }
  return { bytes: image.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildArtwork({ checkOnly: process.argv.includes('--check') });
  console.log(`值班台图片已${process.argv.includes('--check') ? '核对' : '打包到样式表'}（${result.bytes} 字节）`);
}
