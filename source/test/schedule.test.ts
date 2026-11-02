import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, matchCandidate, newEventFromCandidate, applyCandidate, toICS, googleCalendarUrl, monthGrid, eventsOn, cleanTitle } from '../src/core/schedule.ts';
import type { CalEvent } from '../src/core/types.ts';

const notice = `【運動会のお知らせ】
保護者各位　2026年9月1日
下記のとおり運動会を行います。
日時：10月10日（土）9:00〜12:00
場所：〇〇小学校 校庭
雨天の場合は10月11日（日）に延期します。
参加申込書は9月18日（金）までに提出してください。
9月30日（水）は準備のため午後から休園となります。
10月9日（金）は体操服を持参してください。`;

test('予定候補：行事・予備日・締切・休園・持ち物を取り出す', () => {
  const cs = extractCandidates(notice, '2026-09-01', '【運動会のお知らせ】');
  const by = (cat: string) => cs.filter((c) => c.category === cat);
  const ev = by('event')[0];
  assert.equal(ev.date, '2026-10-10');
  assert.equal(ev.start, '09:00');
  assert.equal(ev.end, '12:00');
  assert.match(ev.title, /運動会/);
  assert.equal(ev.location, '〇〇小学校 校庭');
  assert.ok(ev.dateCertain);
  const bk = by('backup')[0];
  assert.equal(bk.date, '2026-10-11');
  assert.equal(bk.title, '運動会（予備日）');
  assert.equal(bk.cancelled, false);
  const dl = by('deadline')[0];
  assert.equal(dl.date, '2026-09-18');
  assert.match(dl.title, /^締切：.*申込書/);
  assert.equal(by('closed')[0].date, '2026-09-30');
  assert.equal(by('prepare')[0].date, '2026-10-09');
  // 発行日（保護者各位 2026年9月1日）は予定にしない
  assert.ok(!cs.some((c) => c.date === '2026-09-01'));
});

test('予定候補：曜日が合わない・あいまいな日付は確定しない', () => {
  const cs = extractCandidates('11月5日（月）に遠足があります。\n作品展は12月中旬の予定です。', '2026-10-20', '');
  const a = cs.find((c) => c.title.includes('遠足'))!;
  assert.equal(a.date, '2026-11-05'); // 2026/11/5 は木曜
  assert.equal(a.dateCertain, false);
  assert.match(a.notes.join(), /曜日が合いません/);
  const b = cs.find((c) => c.title.includes('作品展'))!;
  assert.equal(b.date, '');
  assert.equal(b.dateCertain, false);
});

test('予定候補：年の推定（年末のお知らせの1月は翌年）と範囲・午後', () => {
  const cs = extractCandidates('1月8日（金）〜1月9日（土）は保育参観です。午後1時〜3時', '2026-12-10', '保育参観のご案内');
  assert.equal(cs[0].date, '2027-01-08');
  assert.equal(cs[0].endDate, '2027-01-09');
  assert.ok(cs[0].yearInferred);
  const t = extractCandidates('11月20日（金）　保育参観　午後1時〜3時', '2026-11-01')[0];
  assert.equal(t.start, '13:00');
  assert.equal(t.end, '15:00');
});

test('予定候補：中止の記載', () => {
  const cs = extractCandidates('10月10日（土）の運動会は中止します。', '2026-10-05', '運動会について');
  assert.ok(cs[0].cancelled);
});

const ev = (o: Partial<CalEvent> = {}): CalEvent => ({
  ...newEventFromCandidate(
    { title: '運動会', date: '2026-10-10', endDate: '', start: '09:00', end: '12:00', location: '校庭', category: 'event', snippet: '', dateCertain: true, yearInferred: false, cancelled: false, notes: [] },
    { type: 'item', id: 'it-1', snippet: '' },
    '',
    'ev-1',
    '2026-09-01T00:00:00Z',
  ),
  ...o,
});

test('照合：同じお知らせの再取り込みは重複しない・変更と中止を検知', () => {
  const existing = [ev()];
  const same = extractCandidates(notice, '2026-09-01', '【運動会のお知らせ】').find((c) => c.category === 'event')!;
  same.location = '校庭';
  assert.equal(matchCandidate(same, existing).status, 'same');
  const moved = extractCandidates('運動会は10月17日（土）9:00〜12:00に変更します。', '2026-10-01', '運動会の日程変更')[0];
  const m = matchCandidate(moved, existing);
  assert.equal(m.status, 'changed');
  if (m.status === 'changed') {
    assert.match(m.diffs[0], /10月10日（土） → 10月17日（土）/);
    const up = applyCandidate(m.event, moved, '2026-10-01T00:00:00Z', 'it-2');
    assert.equal(up.date, '2026-10-17');
    assert.equal(up.sequence, 1);
    assert.equal(up.history.length, 1);
    assert.equal(up.id, 'ev-1');
  }
  const stop = extractCandidates('10月10日（土）の運動会は中止します。', '2026-10-05', '')[0];
  assert.equal(matchCandidate(stop, existing).status, 'cancel');
  // 予備日は別の予定として扱う
  const bk = extractCandidates(notice, '2026-09-01', '【運動会のお知らせ】').find((c) => c.category === 'backup')!;
  assert.equal(matchCandidate(bk, existing).status, 'new');
});

test('外部カレンダー：ics と Googleリンク', () => {
  const e = ev({ description: '持ち物：水筒, 帽子; タオル', location: '〇〇小学校 校庭' });
  const allDay = ev({ id: 'ev-2', start: '', end: '', date: '2026-09-30', title: '休園（午後）', category: 'closed' });
  const ics = toICS([e, allDay], new Date('2026-09-01T00:00:00Z'), { sourceTitle: () => '運動会のお知らせ' });
  assert.ok(ics.includes('\r\nDTSTART;TZID=Asia/Tokyo:20261010T090000\r\n'));
  assert.ok(ics.includes('DTEND;TZID=Asia/Tokyo:20261010T120000'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260930\r\nDTEND;VALUE=DATE:20261001'));
  assert.ok(ics.includes('UID:ev-1@atode-mitsukaru'));
  assert.ok(ics.replace(/\r\n /g, '').includes('水筒\\, 帽子\\; タオル'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const u = new URL(googleCalendarUrl(e));
  assert.equal(u.searchParams.get('dates'), '20261010T090000/20261010T120000');
  assert.equal(u.searchParams.get('ctz'), 'Asia/Tokyo');
  assert.equal(u.searchParams.get('text'), '運動会');
  assert.equal(new URL(googleCalendarUrl(allDay)).searchParams.get('dates'), '20260930/20261001');
});

test('カレンダー表示：月の枠と複数日の予定', () => {
  const g = monthGrid(2026, 11);
  assert.equal(g[0][0], '2026-11-01'); // 2026/11/1 は日曜
  assert.equal(g.at(-1)!.at(-1), '2026-12-05');
  const e = ev({ date: '2026-11-02', endDate: '2026-11-04' });
  assert.equal(eventsOn([e], '2026-11-03').length, 1);
  assert.equal(eventsOn([e], '2026-11-05').length, 0);
  assert.equal(cleanTitle('【給食試食会のお知らせ】'), '給食試食会');
});

import { packBackup, unpackBackup, planRestore } from '../src/core/backup.ts';
test('バックアップ：予定も保存・復元され、重複しない', async () => {
  const e1 = ev();
  const e2 = ev({ id: 'ev-2', title: '遠足' });
  const { parts, manifest } = packBackup({ records: [], items: [], events: [e1, e2], files: [], blobs: [], pdfs: [] }, '2026-11-03T00:00:00.000Z');
  assert.equal(manifest.counts.events, 2);
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) (buf.set(p, o), (o += p.length));
  const back = await unpackBackup(buf);
  assert.deepEqual(back.events, [e1, e2]);
  const plan = planRestore(back, { records: [], items: [], events: [e1, { ...e2, title: '遠足（雨天中止）' }], fileHashes: new Set() }, 'now');
  assert.equal(plan.eventsToAdd.length, 0);
  assert.equal(plan.eventsSame, 1);
  assert.equal(plan.eventsKeptExisting.length, 1);
});

test('予定候補：見出しの横の発行日は予定にしない', () => {
  const cs = extractCandidates('【運動会の日程変更】2026年10月1日\n運動会は10月17日（土）9:00〜12:00に変更します。', '2026-10-01', '【運動会の日程変更】');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].date, '2026-10-17');
});

import { titleFromText } from '../src/core/textutil.ts';
test('タイトル：見出しの後ろの発行日を外す・「に変更します」を名前に含めない', () => {
  assert.equal(titleFromText('【運動会の日程変更】2026年10月1日\n本文'), '【運動会の日程変更】');
  const c = extractCandidates('運動会は10月17日（土）9:00〜12:00に変更します。', '2026-10-01')[0];
  assert.equal(c.title, '運動会');
});

test('予定候補：食事量の分数（1/4食べた）を日付と誤認しない', () => {
  assert.equal(extractCandidates('昼食 主食:1/4食べた、主菜:完食、副菜:3/4食べた', '2026-03-25').length, 0);
  assert.equal(extractCandidates('11/20（金）いも掘り', '2026-11-01').length, 1);
});
