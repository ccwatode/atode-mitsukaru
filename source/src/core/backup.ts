import { buildZip, readZip, type ZipEntry } from './zip.ts';
import { fromJSON, EXPORT_APP } from './exportData.ts';
import { planMerge, type MergePlan } from './merge.ts';
import type { CalEvent, Child, Family, Item, NoteRecord } from './types.ts';
import { findChild } from './migrate.ts';

/**
 * 完全バックアップ（ZIP）。JSONだけでは画像が入らないため、
 * 記録（JSON）と添付・元PDF（バイナリ）を1つのZIPにまとめる。
 */

/** v2：連絡帳・記録・添付・元PDF　v3：予定（events.json）を追加。v2 も読める */
export const BACKUP_VERSION = 3;
/**
 * v0.5（D3）：形式の版は 3 のまま、family.json / children.json と記録の新しい項目を足すだけ。
 * v0.4 は知らないファイルと項目を無視するので、v0.5 で作ったバックアップも v0.4 で復元できる。
 */
export const FORMAT_REVISION = 5;

export interface FileMeta {
  hash: string;
  name: string;
  size: number;
  importedAt: string;
  recordCount: number;
}

export interface BlobEntry {
  /** `${attachmentId}:${variant}` */
  key: string;
  mime: string;
  data: Uint8Array;
}

export interface PdfEntry {
  hash: string;
  data: Uint8Array;
}

export interface BackupData {
  records: NoteRecord[];
  items: Item[];
  events?: CalEvent[];
  family?: Family;
  children?: Child[];
  files: FileMeta[];
  blobs: BlobEntry[];
  pdfs: PdfEntry[];
}

export interface BackupManifest {
  app: typeof EXPORT_APP;
  version: number;
  formatRevision?: number;
  createdAt: string;
  counts: { records: number; items: number; attachments: number; pdfs: number; events?: number };
  blobs: { key: string; mime: string; path: string; size: number }[];
  pdfs: { hash: string; path: string; size: number }[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 1));
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

export function packBackup(d: BackupData, now: string): { parts: Uint8Array[]; manifest: BackupManifest } {
  const blobs = d.blobs.map((b) => ({ key: b.key, mime: b.mime, path: `blobs/${safe(b.key)}`, size: b.data.length }));
  const pdfs = d.pdfs.map((p) => ({ hash: p.hash, path: `pdfs/${safe(p.hash)}.pdf`, size: p.data.length }));
  const manifest: BackupManifest = {
    app: EXPORT_APP,
    version: BACKUP_VERSION,
    formatRevision: FORMAT_REVISION,
    createdAt: now,
    counts: { records: d.records.length, items: d.items.length, attachments: new Set(d.blobs.map((b) => b.key.split(':')[0])).size, pdfs: d.pdfs.length, events: (d.events ?? []).length },
    blobs,
    pdfs,
  };
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: json(manifest) },
    // 連絡帳は既存のJSON書き出しと同じ形（JSON単体の読み込みとも互換）
    { name: 'records.json', data: json({ app: EXPORT_APP, version: 1, exportedAt: now, records: d.records }) },
    { name: 'items.json', data: json(d.items) },
    { name: 'events.json', data: json(d.events ?? []) },
    ...(d.family ? [{ name: 'family.json', data: json(d.family) }] : []),
    ...(d.children ? [{ name: 'children.json', data: json(d.children) }] : []),
    { name: 'files.json', data: json(d.files) },
    ...d.blobs.map((b, i) => ({ name: blobs[i].path, data: b.data })),
    ...d.pdfs.map((p, i) => ({ name: pdfs[i].path, data: p.data })),
  ];
  return { parts: buildZip(entries, new Date(now)), manifest };
}

function validateItems(v: unknown): Item[] {
  if (!Array.isArray(v)) throw new Error('items.json が不正です');
  return v.map((x, i) => {
    const it = x as Item;
    if (typeof it?.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it.date) || !['notice', 'flyer', 'photo', 'memo'].includes(it.kind)) {
      throw new Error(`items.json の${i + 1}件目が不正です`);
    }
    return {
      ...it,
      title: String(it.title ?? ''),
      body: String(it.body ?? ''),
      searchText: String(it.searchText ?? ''),
      childName: String(it.childName ?? ''),
      event: String(it.event ?? ''),
      attachments: Array.isArray(it.attachments) ? it.attachments : [],
    };
  });
}

function validateEvents(v: unknown): CalEvent[] {
  if (!Array.isArray(v)) throw new Error('events.json が不正です');
  return v.map((x, i) => {
    const e = x as CalEvent;
    if (typeof e?.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error(`events.json の${i + 1}件目が不正です`);
    return {
      ...e,
      title: String(e.title ?? ''),
      endDate: String(e.endDate ?? ''),
      start: String(e.start ?? ''),
      end: String(e.end ?? ''),
      location: String(e.location ?? ''),
      description: String(e.description ?? ''),
      childName: String(e.childName ?? ''),
      category: e.category ?? 'other',
      status: e.status === 'cancelled' ? 'cancelled' : 'active',
      source: e.source ?? { type: 'manual', id: '', snippet: '' },
      history: Array.isArray(e.history) ? e.history : [],
      exportedAt: String(e.exportedAt ?? ''),
      sequence: Number(e.sequence ?? 0),
    };
  });
}

export async function unpackBackup(buf: Uint8Array): Promise<BackupData & { manifest: BackupManifest }> {
  const entries = await readZip(buf);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const m = byName.get('manifest.json');
  if (!m) throw new Error('「あとで見つかる」のバックアップではありません（manifest.json がありません）');
  const manifest = JSON.parse(dec.decode(m)) as BackupManifest;
  if (manifest.app !== EXPORT_APP) throw new Error('「あとで見つかる」のバックアップではありません');
  if (manifest.version > BACKUP_VERSION) throw new Error('新しいバージョンで作られたバックアップです。アプリを更新してください');
  const rec = byName.get('records.json');
  const records = rec ? fromJSON(dec.decode(rec)) : [];
  const itemsRaw = byName.get('items.json');
  const items = itemsRaw ? validateItems(JSON.parse(dec.decode(itemsRaw))) : [];
  const eventsRaw = byName.get('events.json');
  const events = eventsRaw ? validateEvents(JSON.parse(dec.decode(eventsRaw))) : [];
  const famRaw = byName.get('family.json');
  const family = famRaw ? (JSON.parse(dec.decode(famRaw)) as Family) : undefined;
  const chRaw = byName.get('children.json');
  const children = chRaw ? (JSON.parse(dec.decode(chRaw)) as Child[]).filter((c) => typeof c?.id === 'string' && Array.isArray(c.aliases)) : undefined;
  const filesRaw = byName.get('files.json');
  const files = filesRaw ? (JSON.parse(dec.decode(filesRaw)) as FileMeta[]) : [];
  const blobs: BlobEntry[] = manifest.blobs.map((b) => {
    const data = byName.get(b.path);
    if (!data) throw new Error(`添付ファイルが欠けています（${b.path}）`);
    return { key: b.key, mime: b.mime, data };
  });
  const pdfs: PdfEntry[] = manifest.pdfs.flatMap((p) => {
    const data = byName.get(p.path);
    return data ? [{ hash: p.hash, data }] : [];
  });
  return { manifest, records, items, events, family, children, files, blobs, pdfs };
}

export interface RestorePlan {
  notes: MergePlan;
  itemsToAdd: Item[];
  itemsSame: number;
  /** 同じIDで内容が違う → 既存を残す（上書き事故防止） */
  itemsKeptExisting: Item[];
  eventsToAdd: CalEvent[];
  eventsSame: number;
  eventsKeptExisting: CalEvent[];
  /** バックアップ側にしかいない子ども（名前で照合） */
  childrenToAdd: Child[];
  blobsToAdd: BlobEntry[];
  filesToAdd: FileMeta[];
  pdfsToAdd: PdfEntry[];
}

/**
 * 「同じ内容か」の比較。v0.5 で足した項目（分類・状態・子どもID・版番号など）は比べない。
 * v0.4 のバックアップを v0.5 の端末に戻したとき、移行で足した項目だけの違いを「内容が違う」としないため。
 */
const stable = (x: Item | CalEvent) =>
  'kind' in x
    ? JSON.stringify([x.kind, x.date, x.title, x.body, x.searchText, x.childName, x.event, x.attachments.map((a) => a.id)])
    : JSON.stringify([x.title, x.date, x.endDate, x.start, x.end, x.location, x.description, x.childName, x.category, x.status]);

/**
 * 復元の計画。既存データは消さない・上書きしない。
 *  - 連絡帳：取り込みと同じ比較（内容が違えば承認待ち）
 *  - その他の記録：新しいIDだけ追加。同じIDで内容が違うものは既存を残して報告
 *  - 添付：追加する記録の分だけ
 */
export function planRestore(
  b: BackupData,
  existing: { records: NoteRecord[]; items: Item[]; events?: CalEvent[]; children?: Child[]; fileHashes: Set<string> },
  now: string,
): RestorePlan {
  const notes = planMerge(b.records, new Map(existing.records.map((r) => [r.id, r])), now);
  // 子ども：名前（表記）で照合し、バックアップ側のIDを端末側のIDに読み替える
  const devChildren = [...(existing.children ?? [])];
  const childrenToAdd: Child[] = [];
  const idMap = new Map<string, string>();
  for (const c of b.children ?? []) {
    const hit = [c.displayName, ...c.aliases].map((n) => findChild(devChildren, n)).find(Boolean);
    if (hit) idMap.set(c.id, hit.id);
    else {
      devChildren.push(c);
      childrenToAdd.push(c);
      idMap.set(c.id, c.id);
    }
  }
  const remap = <T extends { childIds?: string[] }>(x: T): T => (x.childIds ? { ...x, childIds: x.childIds.map((id) => idMap.get(id) ?? id) } : x);
  const cur = new Map(existing.items.map((i) => [i.id, i]));
  const itemsToAdd: Item[] = [];
  const itemsKeptExisting: Item[] = [];
  let itemsSame = 0;
  for (const it of b.items) {
    const c = cur.get(it.id);
    if (!c) itemsToAdd.push(remap(it));
    else if (stable(c) === stable(it)) itemsSame++;
    else itemsKeptExisting.push(it);
  }
  const curE = new Map((existing.events ?? []).map((e) => [e.id, e]));
  const eventsToAdd: CalEvent[] = [];
  const eventsKeptExisting: CalEvent[] = [];
  let eventsSame = 0;
  for (const e of b.events ?? []) {
    const c = curE.get(e.id);
    if (!c) eventsToAdd.push(remap(e));
    else if (stable(c) === stable(e)) eventsSame++;
    else eventsKeptExisting.push(e);
  }
  const addIds = new Set(itemsToAdd.flatMap((i) => i.attachments.map((a) => a.id)));
  const blobsToAdd = b.blobs.filter((x) => addIds.has(x.key.split(':')[0]));
  const filesToAdd = b.files.filter((f) => !existing.fileHashes.has(f.hash));
  const fileSet = new Set(filesToAdd.map((f) => f.hash));
  const pdfsToAdd = b.pdfs.filter((p) => fileSet.has(p.hash));
  return { notes, itemsToAdd, itemsSame, itemsKeptExisting, eventsToAdd, eventsSame, eventsKeptExisting, childrenToAdd, blobsToAdd, filesToAdd, pdfsToAdd };
}
