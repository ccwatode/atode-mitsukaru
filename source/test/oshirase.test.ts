import test from 'node:test';
import assert from 'node:assert/strict';
import { assignImages, genreChoices, matchBySize, parseOshiraseList, postKey, sizeMatches, suggestGenres, titleKey } from '../src/core/oshirase.ts';
import type { TextPiece } from '../src/core/types.ts';

/** 架空のお知らせ一覧を、実際の保存PDFと同じ並び（見出し・札・題名・本文・字下げの添付）で組み立てる */
function layout(scale = 1) {
  const ps: TextPiece[] = [];
  let y = 100;
  const H = 12.8 * scale;
  const X = 151 * scale;
  const put = (str: string, x: number, h: number, yy = y) => ps.push({ str, x, y: yy, w: [...str].length * h * (/^[\x20-\x7e]+$/.test(str) ? 0.55 : 1), h, page: 1 });
  const api = {
    date(d: string) { put(d, X - 13 * scale, 11.2 * scale); y += 36 * scale; return api; },
    post(title: string | string[], lines: string[], opts: { end?: 'more' | 'less'; atts?: string[]; gapAfter?: number; child?: string } = {}) {
      put('みどり保育園', X + 7 * scale, 9.6 * scale);
      if (opts.child !== '') put(opts.child ?? 'はなこ', X + 96 * scale, 9.6 * scale);
      y += 28 * scale;
      for (const t of [title].flat()) { put(t, X, H); y += 16 * scale; }
      y += 8 * scale;
      lines.forEach((l, i) => {
        if (l === '') { y += 19 * scale; return; }
        const last = i === lines.length - 1;
        put(l, X, H);
        if (last && opts.end === 'more') { put('…', X + [...l].length * H + 2, H); put('もっとみる', X + [...l].length * H + 16 * scale, H); }
        y += 19 * scale;
      });
      if (opts.end === 'less') { put('小さくする', X, H); y += 19 * scale; }
      y += 25 * scale;
      for (const a of opts.atts ?? []) { put(a, X + 29 * scale, H); y += 19 * scale; }
      y += opts.gapAfter ?? 60 * scale;
      return api;
    },
    get y() { return y; },
    pieces: ps,
  };
  return api;
}

const wide = 'あ'.repeat(22); // 幅いっぱいの行（次の行とつながる）

test('一覧PDF：日付・札・題名・本文・添付で記事に分ける', () => {
  const L = layout()
    .date('2026-11-02')
    .post('今日の給食', ['11月2日（月）', '【昼食】', 'カレーライス'], { end: 'less' })
    .post('今日のそら組', [wide, 'たくさん遊びました', '', '明日も元気に'], { end: 'more' })
    .date('2026-10-30')
    .post(['2026年11月【献立表／夕食】配信', 'します'], ['献立表を配信いたします。'], { atts: ['献立表夕食11月号.pdf (180.8KB)'] })
    .post('資料のお知らせ', ['詳しくは添付をご覧ください。'], { end: 'less', atts: ['0151_001.pdf (291.5KB)', 'とても長い名前の資料（配信用）.pdf (4.7M', 'B)'], child: '' });
  const r = parseOshiraseList(L.pieces, [L.y]);
  assert.equal(r.posts.length, 4);
  assert.deepEqual(r.range, { from: '2026-10-30', to: '2026-11-02' });
  const [a, b, c, d] = r.posts;
  assert.equal(a.date, '2026-11-02');
  assert.equal(a.title, '今日の給食');
  assert.equal(a.childName, 'はなこ');
  assert.equal(a.school, 'みどり保育園');
  assert.equal(a.bodyState, 'full');
  assert.equal(a.body, '11月2日（月）\n【昼食】\nカレーライス');
  assert.equal(b.bodyState, 'truncated');
  assert.equal(b.body, `${wide}たくさん遊びました\n\n明日も元気に`);
  assert.equal(c.date, '2026-10-30');
  assert.equal(c.title, '2026年11月【献立表／夕食】配信します');
  assert.deepEqual(c.attachments, [{ displayName: '献立表夕食11月号.pdf', displaySize: '180.8KB' }]);
  assert.equal(c.bodyState, 'full');
  assert.equal(d.childName, '');
  assert.deepEqual(d.attachments.map((x) => x.displaySize), ['291.5KB', '4.7MB']);
  assert.equal(d.attachments[1].displayName, 'とても長い名前の資料（配信用）.pdf');
  assert.equal(d.body, '詳しくは添付をご覧ください。');
});

test('一覧PDF：保存方法で倍率が変わっても同じ記事は同じキーになる（省略あり／全文でも）', () => {
  const mk = (scale: number, end: 'more' | 'less', lines: string[]) => parseOshiraseList(layout(scale).date('2026-11-02').post('今日のそら組', lines, { end }).pieces).posts[0];
  const full = mk(1, 'less', ['今日は屋上で遊びました。みんなで体操をして、そのあと鬼ごっこをしました。', '砂場も大人気でした。']);
  const cut = mk(1.25, 'more', ['今日は屋上で遊びました。みんなで体操をして、そのあと鬼ごっこをしました。']);
  assert.equal(full.externalKey, cut.externalKey);
  assert.equal(cut.bodyState, 'truncated');
  assert.equal(postKey('2026-11-02', '今日の給食', 'a'), postKey('2026-11-02', '今日の 給食', 'ａ'));
});

test('一覧PDF：フルページ（1ページで約14400pt）は末尾が切れている可能性を知らせる', () => {
  const L = layout().date('2026-11-02').post('今日の給食', ['カレーライス'], { end: 'less' });
  const r = parseOshiraseList(L.pieces, [14400]);
  assert.ok(r.cutOff);
  assert.equal(r.posts[0].bodyState, 'truncated');
  assert.match(r.warnings[0], /共有 → オプション → PDF/);
  assert.equal(parseOshiraseList([], []).posts.length, 0);
});

test('写真：位置から記事に割り当てる', () => {
  const L = layout().date('2026-11-02').post('今日のそら組', ['遊びました'], { end: 'less', gapAfter: 400 }).post('今日の給食', ['カレー'], { end: 'less', gapAfter: 300 });
  const r = parseOshiraseList(L.pieces);
  const [p1, p2] = r.posts;
  const got = assignImages(r.posts, [{ y: p1.yStart + 120, width: 800, height: 600 }, { y: p1.yStart + 260, width: 800, height: 600 }, { y: p2.yStart + 150, width: 800, height: 600 }, { y: 5, width: 800, height: 600 }]);
  assert.deepEqual(got, [[0, 1], [2]]);
});

test('ジャンル：内容からの提案', () => {
  assert.equal(suggestGenres('今日の給食')[0], '給食');
  assert.equal(suggestGenres('今日のそら組とうみ組')[0], '活動記録');
  assert.equal(suggestGenres('2026年11月【園だより】配信します')[0], '園だより');
  assert.equal(suggestGenres('2026年11月【献立表／夕食】配信します')[0], '献立表');
  assert.equal(suggestGenres('【園だよりカレンダー】お詫びと訂正')[0], '訂正・変更');
  assert.equal(suggestGenres('本日の欠席状況')[0], '欠席・感染症');
  assert.equal(suggestGenres('【リズム教室】おたより', '', true)[0], 'リズム教室');
  assert.deepEqual(suggestGenres('入職者のご紹介', 'よろしくお願いします'), ['お知らせ', '持ち物・提出']);
  assert.equal(suggestGenres('資料について', '', true)[0], '資料');
});

test('ジャンル：候補は「前に同じ題名で選んだもの → 提案 → これまでに使ったもの」の順', () => {
  assert.equal(titleKey('2026年11月【園だより】配信します'), titleKey('2026年10月【園だより】配信します'));
  const existing = [
    { title: '今日の給食', genre: 'ごはん' },
    { title: '今日の給食', genre: 'ごはん' },
    { title: '2026年10月【園だより】配信します', genre: '園だより' },
    { title: '遠足', genre: '行事' },
    { title: 'メモ', genre: undefined },
  ];
  const c1 = genreChoices({ title: '今日の給食', body: '', hasPdf: false }, existing);
  assert.deepEqual(c1.slice(0, 2), [{ name: 'ごはん', why: 'past' }, { name: '給食', why: 'suggest' }]);
  assert.ok(c1.some((c) => c.name === '行事' && c.why === 'used'));
  const c2 = genreChoices({ title: '個人面談のお知らせ', body: '', hasPdf: false }, existing);
  assert.deepEqual(c2[0], { name: '行事', why: 'used' });
  const c3 = genreChoices({ title: 'はじめての題名', body: '', hasPdf: false }, []);
  assert.deepEqual(c3, [{ name: 'お知らせ', why: 'suggest' }]);
});

test('添付：画面の容量表記と保存したファイルの容量を照合する', () => {
  assert.ok(sizeMatches('180.8KB', 185057));
  assert.ok(sizeMatches('4.7MB', 4855312));
  assert.ok(!sizeMatches('180.8KB', 186000));
  assert.ok(!sizeMatches('3.8MB', 4855312));
  const missing = [
    { itemId: 'a', attachmentId: '1', displayName: '献立表夕食.pdf', displaySize: '180.8KB' },
    { itemId: 'b', attachmentId: '2', displayName: '園だより.pdf', displaySize: '4.7MB' },
  ];
  assert.deepEqual(matchBySize(185057, missing).map((m) => m.itemId), ['a']);
  assert.equal(matchBySize(999, missing).length, 0);
});

import { findJpegStreams } from '../src/core/pdfjpeg.ts';
test('PDFにそのまま入っているJPEGの範囲を見つける', () => {
  const e = new TextEncoder();
  const jpg = (n: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array(n).fill(7), 0xff, 0xd9]);
  const j1 = jpg(40);
  const j2 = jpg(12);
  const parts = [
    e.encode('%PDF-1.3\n12 0 obj\n<< /Type /XObject /Subtype /Image /Width 800 /Height 566\n/BitsPerComponent 8 /Length ' + j1.length + ' /Filter\n/DCTDecode >>\nstream\n'), j1, e.encode('\nendstream\nendobj\n'),
    e.encode('13 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /Length 5 /Filter /FlateDecode >>\nstream\nabcde\nendstream\nendobj\n'),
    e.encode('14 0 obj\n<< /Subtype /Image /Width 797 /Height 600 /Length 15 0 R /Filter /DCTDecode >>\nstream\r\n'), j2, e.encode('\nendstream\nendobj\n'),
  ];
  const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (buf.set(p, o), (o += p.length));
  const found = findJpegStreams(buf);
  assert.deepEqual(found.map((f) => [f.width, f.height, f.end - f.start]), [[800, 566, j1.length], [797, 600, j2.length]]);
  assert.deepEqual([...buf.subarray(found[1].start, found[1].end)], [...j2]);
});

import { missingAttachments, planPosts } from '../src/core/oshirase.ts';
import type { Item } from '../src/core/types.ts';
test('取り込みの計画：取り込み済みは重複させず、全文になった・写真が増えた記事だけ更新する', () => {
  const L = layout().date('2026-11-02').post('今日のそら組', ['遊びました。楽しかったです。'], { end: 'less' }).post('今日の給食', ['カレー'], { end: 'less' }).post('新しい記事', ['はじめて'], { end: 'less' });
  const posts = parseOshiraseList(L.pieces).posts;
  const base = { kind: 'notice', date: '2026-11-02', searchText: '', childName: '', event: '', createdAt: '', updatedAt: '' } as const;
  const existing: Item[] = [
    { ...base, id: 'a', title: '今日のそら組', body: '遊びました。', bodyState: 'truncated', attachments: [], source: { via: 'listpdf', fileNames: [], externalKey: posts[0].externalKey } },
    { ...base, id: 'b', title: '今日の給食', body: 'カレー', bodyState: 'full', source: { via: 'listpdf', fileNames: [], externalKey: posts[1].externalKey },
      attachments: [{ id: 'p', name: 'p.jpg', mime: 'image/jpeg', size: 1, variants: ['orig', 'thumb'] }, { id: 'm', name: '献立.pdf', mime: 'application/pdf', size: 0, variants: [], state: 'missing', displayName: '献立.pdf', displaySize: '180.8KB' }] },
  ];
  const plan = planPosts([...posts, posts[2]], [0, 1, 0, 0], existing);
  assert.deepEqual(plan.map((p) => p.status), ['fuller', 'same', 'new', 'same']);
  assert.equal(plan[0].betterBody, true);
  assert.equal(planPosts(posts, [0, 3, 0], existing)[1].morePhotos, true);
  assert.deepEqual(missingAttachments(existing).map((m) => [m.itemId, m.displaySize]), [['b', '180.8KB']]);
});

test('部首用の文字をふつうの漢字に直す（全角記号は変えない）', async () => {
  const { fixRadicals } = await import('../src/core/textutil.ts');
  assert.equal(fixRadicals('10⽉⽇（⼟）：⼩さくする'), '10月日（土）：小さくする');
});
