import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPurposes, collectChildren, findChild, mergeChildren, migrate } from '../src/core/migrate.ts';
import type { CalEvent, Item, NoteRecord } from '../src/core/types.ts';

let n = 0;
const gen = () => `id-${++n}`;
const now = '2026-11-04T00:00:00.000Z';

const item = (o: Partial<Item> = {}): Item => ({
  id: 'it-1', kind: 'notice', date: '2026-10-30', title: '運動会のお知らせ', body: '10月10日に運動会', searchText: '', childName: 'はなこ', event: '',
  attachments: [{ id: 'at-1', name: 'a.jpg', mime: 'image/jpeg', size: 10, variants: ['view', 'thumb'] }],
  source: { via: 'paste', fileNames: [] }, createdAt: '2026-10-30T01:00:00.000Z', updatedAt: '2026-10-30T01:00:00.000Z', ...o,
});
const note = (o: Partial<NoteRecord> = {}): NoteRecord => ({
  id: '2026-03-01_ハナコ', date: '2026-03-01', childName: 'ハナコ', schoolName: '', teacher: '', classNote: '', personalComment: '', attendance: '', sleep: '', toilet: '', meal: '',
  otherLife: '', homeMessage: '', homeRecord: '', rawText: '', sources: [], fetchStatus: '取得済み', statusReason: '', reviewStatus: '未確認', editedFields: [], updatedAt: now, ...o,
});
const ev = (o: Partial<CalEvent> = {}): CalEvent => ({
  id: 'ev-1', title: '運動会', date: '2026-10-10', endDate: '', start: '', end: '', location: '', description: '', childName: 'はなこ', category: 'event', status: 'active',
  source: { type: 'item', id: 'it-1', snippet: '' }, history: [], exportedAt: '', sequence: 0, createdAt: now, updatedAt: now, ...o,
});

test('分類：タイトルの決まった形から保護者向けの区分を推定', () => {
  assert.deepEqual(classifyPurposes('今日のくじら組'), ['memories']);
  assert.deepEqual(classifyPurposes('今日の給食'), ['daily']);
  assert.deepEqual(classifyPurposes('2026年11月【園だより】配信します'), ['documents']);
  assert.deepEqual(classifyPurposes('2026年11月【献立表／夕食】配信します'), ['documents']);
  assert.deepEqual(classifyPurposes('【園だよりカレンダー】お詫びと訂正'), ['schedule', 'documents']);
  assert.deepEqual(classifyPurposes('運動会についてのお知らせ'), ['schedule']);
  assert.deepEqual(classifyPurposes('', 'photo'), ['memories']);
  assert.deepEqual(classifyPurposes('本日の欠席状況', 'notice', '詳細は添付'), []);
});

test('子ども：表記ゆれ（カタカナ・ひらがな）は同じ子どもとして扱い、統合もできる', () => {
  const { children, added } = collectChildren(['ハナコ', 'はなこ', 'たろう', ''], [], gen, now);
  assert.equal(added.length, 2);
  assert.equal(findChild(children, 'はなこ')!.id, findChild(children, 'ハナコ')!.id);
  const merged = mergeChildren(children, children[0].id, children[1].id);
  assert.equal(merged.length, 1);
  assert.ok(findChild(merged, 'たろう'));
});

test('移行：連絡帳は書き換えず、記録と予定は足りない項目だけ埋める。2回目は変更0件', () => {
  const records = [note()];
  const before = JSON.stringify(records);
  const items = [item(), item({ id: 'it-2', kind: 'photo', title: '', childName: '', attachments: [] })];
  const events = [ev()];
  const r1 = migrate({ records, items, events }, gen, now);
  assert.equal(JSON.stringify(records), before);
  assert.equal(r1.report.childrenAdded, 1);
  assert.equal(r1.items.length, 2);
  const a = r1.items[0];
  assert.deepEqual(a.purposes, ['schedule']);
  assert.equal(a.importedAt, '2026-10-30T01:00:00.000Z');
  assert.equal(a.status, 'filed');
  assert.equal(a.bodyState, 'unknown');
  assert.deepEqual(a.childIds, [r1.children[0].id]);
  assert.equal(a.attachments[0].provenance, 'single');
  assert.equal(a.attachments[0].role, 'document');
  // 既存の項目は変わらない
  for (const k of ['id', 'kind', 'date', 'title', 'body', 'childName', 'createdAt', 'updatedAt'] as const) assert.equal(a[k], items[0][k]);
  assert.deepEqual(r1.items[1].childIds, []);
  assert.deepEqual(r1.items[1].purposes, ['memories']);
  assert.equal(r1.events[0].childIds![0], r1.children[0].id);
  // 2回目
  const merged = items.map((i) => r1.items.find((x) => x.id === i.id) ?? i);
  const r2 = migrate({ records, items: merged, events: r1.events, family: r1.family, children: r1.children }, gen, now);
  assert.equal(r2.items.length + r2.events.length + r2.report.childrenAdded, 0);
  assert.equal(r2.family.id, r1.family.id);
});

test('移行：利用者が既に付けた区分や状態は上書きしない', () => {
  const r = migrate({ records: [], items: [item({ purposes: ['memories'], status: 'inbox', important: true })], events: [] }, gen, now);
  assert.deepEqual(r.items[0].purposes, ['memories']);
  assert.equal(r.items[0].status, 'inbox');
  assert.equal(r.items[0].important, true);
});

import { packBackup, unpackBackup, planRestore } from '../src/core/backup.ts';
const cat = (parts: Uint8Array[]) => { const b = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) (b.set(p, o), (o += p.length)); return b; };

test('バックアップ：形式の版は3のまま（v0.4で読める）、家族と子どもを含み、復元で子どもIDを読み替える', async () => {
  const m = migrate({ records: [], items: [item()], events: [ev()] }, gen, now);
  const { parts, manifest } = packBackup({ records: [], items: m.items, events: m.events, family: m.family, children: m.children, files: [], blobs: [], pdfs: [] }, now);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.formatRevision, 5);
  const back = await unpackBackup(cat(parts));
  assert.equal(back.children!.length, 1);
  assert.equal(back.family!.id, m.family.id);
  // 別の端末：同じ子どもが別IDで登録済み
  const dev = [{ id: 'dev-child', displayName: 'ハナコ', aliases: ['ハナコ'], createdAt: now }];
  const plan = planRestore(back, { records: [], items: [], events: [], children: dev, fileHashes: new Set() }, now);
  assert.equal(plan.childrenToAdd.length, 0);
  assert.deepEqual(plan.itemsToAdd[0].childIds, ['dev-child']);
  assert.deepEqual(plan.eventsToAdd[0].childIds, ['dev-child']);
});

test('復元：v0.4のバックアップを移行済みの端末に戻しても「内容が違う」にならない', () => {
  const old = item();
  const migrated = migrate({ records: [], items: [old], events: [] }, gen, now).items[0];
  const plan = planRestore({ records: [], items: [old], events: [], files: [], blobs: [], pdfs: [] }, { records: [], items: [migrated], fileHashes: new Set() }, now);
  assert.equal(plan.itemsSame, 1);
  assert.equal(plan.itemsKeptExisting.length, 0);
});
