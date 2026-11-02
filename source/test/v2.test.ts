import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, readZip, crc32 } from '../src/core/zip.ts';
import { packBackup, unpackBackup, planRestore, type BackupData } from '../src/core/backup.ts';
import { searchDocs, itemToDoc, noteToDoc } from '../src/core/search.ts';
import { exifDate, findDateInText, titleFromText } from '../src/core/textutil.ts';
import { parseNotebook } from '../src/core/parse.ts';
import { toNoteRecord } from '../src/core/merge.ts';
import type { Item, TextPiece } from '../src/core/types.ts';

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

test('CRC32 の既知値', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP の書き込みと読み込み（日本語ファイル名・バイナリ）', async () => {
  const bin = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
  const zip = concat(buildZip([{ name: 'a.json', data: new TextEncoder().encode('{"x":1}') }, { name: 'blobs/写真_1', data: bin }]));
  const back = await readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ['a.json', 'blobs/写真_1']);
  assert.deepEqual(back[1].data, bin);
});

test('ZIP：deflate 圧縮されたファイルも読める（他のアプリで作り直された場合）', async () => {
  const raw = new TextEncoder().encode('あとで見つかる'.repeat(200));
  const cs = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const deflated = new Uint8Array(await new Response(cs).arrayBuffer());
  // stored で作ってから、ヘッダーを deflate に書き換える
  const zip = concat(buildZip([{ name: 't.txt', data: deflated }]));
  const dv = new DataView(zip.buffer);
  const crc = crc32(raw);
  dv.setUint16(8, 8, true);
  dv.setUint32(14, crc, true);
  dv.setUint32(22, raw.length, true);
  const cen = zip.length - 22 - (46 + 5);
  dv.setUint16(cen + 10, 8, true);
  dv.setUint32(cen + 16, crc, true);
  dv.setUint32(cen + 24, raw.length, true);
  const back = await readZip(zip);
  assert.equal(new TextDecoder().decode(back[0].data), 'あとで見つかる'.repeat(200));
});

test('ZIP：壊れたファイルは理由つきで拒否', async () => {
  const zip = concat(buildZip([{ name: 'a', data: new Uint8Array([1, 2, 3]) }]));
  zip[31] ^= 0xff; // データを1バイト壊す
  await assert.rejects(() => readZip(zip), /壊れています/);
  await assert.rejects(() => readZip(new Uint8Array(10)), /ZIPファイルとして読み込めません/);
});

const P = (str: string, x: number, y: number, w = str.length * 16, h = 16): TextPiece => ({ str, x, y, w, h, page: 1 });
function note() {
  const pieces = [P('2026-05-02', 16, 80, 74, 14), P('花子', 88, 132), P('テスト保育園', 32, 175, 84, 14), P('山田', 120, 175, 28, 14), P('より', 152, 175, 28, 14), P('運動会の練習をしました。', 32, 212, 200), P('家庭からの連絡', 32, 400, 98, 14), P('連絡', 69, 450, 32), P('元気です。', 137.5, 452, 80)];
  const rec = parseNotebook({ pieces, totalHeight: 2000, pageCount: 1 }).records;
  return rec.map((r) => toNoteRecord(r, { fileName: 'a.pdf', fileHash: 'h1', importedAt: 't' }, 't'));
}

const item = (over: Partial<Item> = {}): Item => ({
  id: 'it-1',
  kind: 'flyer',
  date: '2026-10-12',
  title: '運動会のご案内',
  body: '持ち物：水筒、帽子',
  searchText: '雨天の場合は翌日に延期',
  childName: '',
  event: '運動会',
  attachments: [{ id: 'at-1', name: 'flyer.jpg', mime: 'image/jpeg', size: 3, variants: ['view', 'thumb'] }],
  source: { via: 'photo', fileNames: ['flyer.jpg'] },
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

test('バックアップ：作成→読み込みで記録・添付・元PDFが一致する', async () => {
  const data: BackupData = {
    records: note(),
    items: [item()],
    files: [{ hash: 'h1', name: 'a.pdf', size: 4, importedAt: 't', recordCount: 1 }],
    blobs: [
      { key: 'at-1:view', mime: 'image/jpeg', data: new Uint8Array([1, 2, 3]) },
      { key: 'at-1:thumb', mime: 'image/jpeg', data: new Uint8Array([4, 5]) },
    ],
    pdfs: [{ hash: 'h1', data: new Uint8Array([37, 80, 68, 70]) }],
  };
  const { parts, manifest } = packBackup(data, '2026-11-03T00:00:00.000Z');
  assert.equal(manifest.counts.attachments, 1);
  const back = await unpackBackup(concat(parts));
  assert.deepEqual(back.records, data.records);
  assert.deepEqual(back.items, data.items);
  assert.deepEqual(back.blobs, data.blobs);
  assert.deepEqual(back.pdfs, data.pdfs);
  assert.deepEqual(back.files, data.files);
});

test('復元：既存データを上書きせず、新しいものだけ追加する', () => {
  const recs = note();
  const backup: BackupData = {
    records: recs,
    items: [item(), item({ id: 'it-2', title: '新しいお知らせ', attachments: [] }), item({ id: 'it-3', title: '内容が違う' })],
    files: [{ hash: 'h1', name: 'a.pdf', size: 4, importedAt: 't', recordCount: 1 }],
    blobs: [{ key: 'at-1:view', mime: 'image/jpeg', data: new Uint8Array([1]) }],
    pdfs: [],
  };
  const plan = planRestore(backup, { records: recs, items: [item(), item({ id: 'it-3', title: '端末側で直したタイトル' })], fileHashes: new Set(['h1']) }, 'now');
  assert.equal(plan.notes.added.length, 0);
  assert.equal(plan.notes.unchanged, 1);
  assert.deepEqual(plan.itemsToAdd.map((i) => i.id), ['it-2']);
  assert.equal(plan.itemsSame, 1);
  assert.deepEqual(plan.itemsKeptExisting.map((i) => i.id), ['it-3']);
  assert.equal(plan.blobsToAdd.length, 0); // it-1 は既にあるので添付も追加しない
  assert.equal(plan.filesToAdd.length, 0);
});

test('バックアップでないZIPは拒否', async () => {
  const zip = concat(buildZip([{ name: 'x.txt', data: new Uint8Array([1]) }]));
  await assert.rejects(() => unpackBackup(zip), /バックアップではありません/);
});

test('横断検索：連絡帳とチラシを同じ検索で探せる', () => {
  const docs = [...note().map(noteToDoc), itemToDoc(item())];
  assert.deepEqual(searchDocs(docs, '運動会').map((h) => h.doc.kind).sort(), ['flyer', 'note']);
  const hit = searchDocs(docs, '雨天')[0];
  assert.equal(hit.doc.kind, 'flyer');
  assert.equal(hit.snippets[0].label, '画像内の文字など');
  assert.deepEqual(searchDocs(docs, '運動会', { kinds: ['flyer'] }).map((h) => h.doc.id), ['it-1']);
  assert.equal(searchDocs(docs, '運動会', { child: '太郎' }).length, 1); // 子ども指定なしのチラシは全員分として出る
});

test('貼り付けた文章から日付とタイトルを推定', () => {
  const base = new Date(2026, 10, 3);
  assert.equal(findDateInText('【お知らせ】\n11月15日（土）は作品展です', base), '2026-11-15');
  assert.equal(findDateInText('2026年4月1日より開始', base), '2026-04-01');
  assert.equal(findDateInText('12/20 クリスマス会', new Date(2027, 0, 5)), '2026-12-20'); // 1月に見た12月の案内は前年
  assert.equal(findDateInText('日付なし', base), null);
  assert.equal(titleFromText('\n  作品展のお知らせ  \n本文'), '作品展のお知らせ');
});

test('JPEGのEXIFから撮影日を読む', () => {
  const dt = new TextEncoder().encode('2026:10:12 09:30:00\0');
  // TIFF（リトルエンディアン）：IFD0 に ExifIFD へのポインタ、ExifIFD に DateTimeOriginal
  const tiff = new Uint8Array(8 + 18 + 18 + dt.length);
  const v = new DataView(tiff.buffer);
  v.setUint16(0, 0x4949);
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);
  v.setUint16(8, 1, true);
  v.setUint16(10, 0x8769, true);
  v.setUint16(12, 4, true);
  v.setUint32(14, 1, true);
  v.setUint32(18, 26, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 0x9003, true);
  v.setUint16(30, 2, true);
  v.setUint32(32, dt.length, true);
  v.setUint32(36, 44, true);
  tiff.set(dt, 44);
  const app1 = new Uint8Array(4 + 6 + tiff.length);
  const a = new DataView(app1.buffer);
  a.setUint16(0, 0xffe1);
  a.setUint16(2, 2 + 6 + tiff.length);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  app1.set(tiff, 10);
  const jpeg = concat([new Uint8Array([0xff, 0xd8]), app1, new Uint8Array([0xff, 0xda])]);
  assert.equal(exifDate(jpeg), '2026-10-12');
  assert.equal(exifDate(new Uint8Array([0x89, 0x50])), null);
});

test('PDFの切れ：最下端で終わる記録は検出、余白があれば検出しない', () => {
  const pieces = [P('2026-05-02', 16, 80, 74, 14), P('花子', 88, 132), P('テスト保育園', 32, 175, 84, 14), P('山田', 120, 175, 28, 14), P('より', 152, 175, 28, 14), P('本文です。', 32, 212, 80)];
  assert.equal(parseNotebook({ pieces, totalHeight: 2000, pageCount: 1 }).truncation, null);
  const cut = parseNotebook({ pieces, totalHeight: 14400, pageCount: 1, pageHeights: [14400] });
  assert.equal(cut.truncation, null);
  const cut2 = parseNotebook({ pieces, totalHeight: 230, pageCount: 1, pageHeights: [230] });
  assert.equal(cut2.truncation?.lastDate, '2026-05-02');
  assert.equal(cut2.truncation?.atHeightLimit, false);
  assert.match(cut2.warnings.at(-1)!, /2026-05-02 以前の記録は/);
});
