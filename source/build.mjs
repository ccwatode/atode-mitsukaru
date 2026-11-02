// ビルド：esbuild で React + TypeScript をバンドルし dist/ に出力する。
// （Vite の代わり。Vite も内部で esbuild を使っており、出力は同等の静的ファイル）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 通常は npm install したプロジェクト内の node_modules を使う。無ければ MODULES_DIR を参照
const root0 = path.dirname(new URL(import.meta.url).pathname);
const NODE_PATHS = [path.join(root0, 'node_modules'), ...(process.env.MODULES_DIR ? [process.env.MODULES_DIR] : [])].filter((p) => fs.existsSync(path.join(p, 'esbuild')));
if (!NODE_PATHS.length) throw new Error('esbuild が見つかりません。npm install を実行してください');
const require = createRequire(path.join(NODE_PATHS[0], 'noop.js'));
const esbuild = require('esbuild');
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));

const root = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(root, 'dist');

// 日本語系CMapをbase64で同梱（ネットワークから取りに行かない）
const JP = /Japan|JIS|RKSJ|EUC-|^H\.|^V\.|^Ext-|^Hankaku|^Hiragana|^Katakana|^Roman|^NWP|^Add-|^WP-Symbol/;
const NOT_JP = /GB-EUC|KSC|CNS|B5/;
const cmapDir = path.join(PDFJS, 'cmaps');
const cmaps = Object.fromEntries(
  fs.readdirSync(cmapDir)
    .filter((f) => f.endsWith('.bcmap') && JP.test(f) && !NOT_JP.test(f))
    .map((f) => [f.replace(/\.bcmap$/, ''), fs.readFileSync(path.join(cmapDir, f)).toString('base64')]),
);
fs.writeFileSync(path.join(root, 'src/cmaps.gen.ts'), `// 自動生成（build.mjs）。pdfjs-dist の日本語CMap ${Object.keys(cmaps).length}件\nexport const CMAPS: Record<string, string> = ${JSON.stringify(cmaps)};\n`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

await esbuild.build({
  entryPoints: [path.join(root, 'src/main.tsx')],
  outdir: dist,
  entryNames: 'app',
  chunkNames: 'chunk-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  target: ['safari15', 'es2020'],
  jsx: 'automatic',
  nodePaths: NODE_PATHS,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});

// PDF.js のワーカー（拡張子は .js にして配信元を選ばないようにする）
// Safari向け：ReadableStreamの非同期反復の補完をワーカーの先頭にも付ける
fs.writeFileSync(
  path.join(dist, 'pdf.worker.min.js'),
  fs.readFileSync(path.join(root, 'src/polyfill-stream.js'), 'utf8') + '\n' + fs.readFileSync(path.join(PDFJS, 'legacy/build/pdf.worker.min.mjs'), 'utf8'),
);
fs.copyFileSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
for (const f of fs.readdirSync(path.join(root, 'public'))) fs.copyFileSync(path.join(root, 'public', f), path.join(dist, f));

// Service Worker（自分のURLで公開したとき用。claude.ai のアーティファクトでは登録しない）
{
  const { createHash } = await import('node:crypto');
  const files = fs.readdirSync(dist).filter((f) => f !== 'sw.js').sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(dist, f)));
  const list = ['./', ...files.map((f) => './' + f)];
  fs.writeFileSync(
    path.join(dist, 'sw.js'),
    fs.readFileSync(path.join(root, 'sw.template.js'), 'utf8').replace('__VERSION__', 'atode-' + h.digest('hex').slice(0, 12)).replace('__FILES__', JSON.stringify(list)),
  );
}

for (const f of fs.readdirSync(dist)) console.log(`${f.padEnd(28)} ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`);
