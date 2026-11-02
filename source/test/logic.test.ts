import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotebook } from '../src/core/parse.ts';
import { planMerge, applyPending, toNoteRecord } from '../src/core/merge.ts';
import { toCSV, toJSON, fromJSON } from '../src/core/exportData.ts';
import { search, fold } from '../src/core/search.ts';
import type { TextPiece, NoteRecord } from '../src/core/types.ts';

const P = (str: string, x: number, y: number, w = str.length * 16, h = 16): TextPiece => ({ str, x, y, w, h, page: 1 });

/** サンプルと同じ配置の合成データ */
function synthetic(opts: { expanded: boolean; bodyDate?: boolean; home?: string }) {
  const pieces: TextPiece[] = [
    P('2026-05-02', 16, 80, 74, 14),
    P('花子', 88, 132),
  ];
  if (opts.expanded) {
    pieces.push(P('テスト保育園', 32, 175, 84, 14), P('山田', 120, 175, 28, 14), P('花先生', 152, 175, 42, 14), P('より', 198, 175, 28, 14));
    pieces.push(P('今日は運動会の練習をしました。', 32, 212, 240));
    if (opts.bodyDate) pieces.push(P('2026-05-10', 32, 236, 80, 16)); // 本文中に日付だけの行
    pieces.push(P('みんな上手でした。', 32, 284, 144));
    pieces.push(P('登園', 69, 330, 32), P('08:00', 137.5, 332, 40));
    pieces.push(P('家庭からの連絡', 32, 400, 98, 14));
    pieces.push(P('連絡', 69, 450, 32), P(opts.home ?? '元気です。', 137.5, 452, 80));
  } else {
    pieces.push(P('さらに表示', 166, 198, 60, 12));
  }
  pieces.push(P('2026-05-01', 16, 800, 74, 14), P('花子', 88, 852), P('さらに表示', 166, 918, 60, 12));
  return { pieces, totalHeight: 2000, pageCount: 1 };
}

test('本文中の日付を見出しと誤認しない', () => {
  const res = parseNotebook(synthetic({ expanded: true, bodyDate: true }));
  assert.equal(res.headingCount, 2);
  assert.deepEqual(res.records.map((r) => r.date), ['2026-05-02', '2026-05-01']);
  assert.match(res.records[0].classNote, /2026-05-10/);
});

test('状態判定: 展開済みは取得済み、さらに表示のみは未取得', () => {
  const res = parseNotebook(synthetic({ expanded: true }));
  assert.equal(res.records[0].fetchStatus, '取得済み');
  assert.equal(res.records[0].teacher, '山田 花先生');
  assert.equal(res.records[0].schoolName, 'テスト保育園');
  assert.equal(res.records[0].homeMessage, '元気です。');
  assert.equal(res.records[0].personalComment, 'みんな上手でした。');
  assert.equal(res.records[1].fetchStatus, '未取得');
});

test('状態判定: 本文と「さらに表示」が両方あれば要確認', () => {
  const doc = synthetic({ expanded: true });
  doc.pieces.push(P('さらに表示', 166, 470, 60, 12));
  assert.equal(parseNotebook(doc).records[0].fetchStatus, '要確認');
});

test('日付見出しがなければ空で警告', () => {
  const res = parseNotebook({ pieces: [P('こんにちは', 32, 100)], totalHeight: 500, pageCount: 1 });
  assert.equal(res.records.length, 0);
  assert.equal(res.warnings.length, 1);
});

const src = (h: string) => ({ fileName: h + '.pdf', fileHash: h, importedAt: 't' });
const recs = (doc: ReturnType<typeof synthetic>, h: string) => parseNotebook(doc).records.map((r) => toNoteRecord(r, src(h), 't'));

test('再取り込み: 本文が増えた版は上書きせず承認待ちにする', () => {
  const old = recs(synthetic({ expanded: false }), 'a');
  const existing = new Map(old.map((r) => [r.id, r]));
  const plan = planMerge(recs(synthetic({ expanded: true }), 'b'), existing, 'now');
  assert.equal(plan.added.length, 0);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].date, '2026-05-02');
  assert.ok(plan.pending[0].incomingHasMore);
  assert.ok(plan.pending[0].diffs.some((d) => d.field === 'classNote'));
  assert.equal(existing.get('2026-05-02_花子')!.fetchStatus, '未取得'); // まだ変わっていない
  const applied = applyPending(existing.get(plan.pending[0].id), plan.pending[0], 'now');
  assert.equal(applied.fetchStatus, '取得済み');
  assert.deepEqual(applied.sources.map((s) => s.fileHash), ['a', 'b']);
  // 5/1は内容同じ→出典だけ追加
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.touched.length, 1);
});

test('再取り込み: 情報の少ない古い版では既存を残す', () => {
  const rich = recs(synthetic({ expanded: true }), 'b');
  const plan = planMerge(recs(synthetic({ expanded: false }), 'a'), new Map(rich.map((r) => [r.id, r])), 'now');
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.keptRicher, 1);
});

test('再取り込み: 本文が変わった場合も承認待ち（編集済みなら警告フラグ）', () => {
  const cur = recs(synthetic({ expanded: true }), 'a').map((r) => ({ ...r, reviewStatus: '修正済み' as const }));
  const plan = planMerge(recs(synthetic({ expanded: true, home: '少し咳があります。' }), 'b'), new Map(cur.map((r) => [r.id, r])), 'now');
  assert.equal(plan.pending.length, 1);
  assert.ok(plan.pending[0].currentEdited);
});

test('JSONの往復と検証', () => {
  const r = recs(synthetic({ expanded: true }), 'a');
  const back = fromJSON(toJSON(r, 'now'));
  assert.deepEqual(back, r);
  assert.throws(() => fromJSON('{"app":"other","records":[]}'), /書き出したJSONではありません/);
  assert.throws(() => fromJSON('not json'), /JSON/);
});

test('CSVはBOM付き・引用符エスケープ', () => {
  const r = recs(synthetic({ expanded: true, home: '「"です"」' }), 'a');
  const csv = toCSV(r);
  assert.ok(csv.startsWith('﻿"日付","園児名"'));
  assert.ok(csv.includes('"「""です""」"'));
  assert.equal(csv.trim().split('\r\n').length, 3);
});

test('検索の正規化', () => {
  assert.equal(fold('ＡＢＣ　トトロ\n公園').text, 'abcととろ公園');
  const r: NoteRecord[] = recs(synthetic({ expanded: true }), 'a');
  assert.equal(search(r, '運動会')[0].snippets[0].match, '運動会');
  assert.equal(search(r, '運動会 存在しない語').length, 0);
  assert.equal(search(r, '').length, 2);
});
