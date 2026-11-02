import { buildZip, readZip, type ZipEntry } from './zip.ts';
import { fromJSON, EXPORT_APP } from './exportData.ts';
import { planMerge, type MergePlan } from './merge.ts';
import type { Item, NoteRecord } from './types.ts';

/**
 * 完全バックアップ（ZIP）。JSONだけでは画像が入らないため、
 * 記録（JSON）と添付・元PDF（バイナリ）を1つのZIPにまとめる。
 */

export const BACKUP_VERSION = 2;

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
  files: FileMeta[];
  blobs: BlobEntry[];
  pdfs: PdfEntry[];
}

export interface BackupManifest {
  app: typeof EXPORT_APP;
  version: number;
  createdAt: string;
  counts: { records: number; items: number; attachments: number; pdfs: number };
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
    createdAt: now,
    counts: { records: d.records.length, items: d.items.length, attachments: new Set(d.blobs.map((b) => b.key.split(':')[0])).size, pdfs: d.pdfs.length },
    blobs,
    pdfs,
  };
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: json(manifest) },
    // 連絡帳は既存のJSON書き出しと同じ形（JSON単体の読み込みとも互換）
    { name: 'records.json', data: json({ app: EXPORT_APP, version: 1, exportedAt: now, records: d.records }) },
    { name: 'items.json', data: json(d.items) },
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
  return { manifest, records, items, files, blobs, pdfs };
}

export interface RestorePlan {
  notes: MergePlan;
  itemsToAdd: Item[];
  itemsSame: number;
  /** 同じIDで内容が違う → 既存を残す（上書き事故防止） */
  itemsKeptExisting: Item[];
  blobsToAdd: BlobEntry[];
  filesToAdd: FileMeta[];
  pdfsToAdd: PdfEntry[];
}

const stable = (it: Item) => JSON.stringify({ ...it, source: undefined, updatedAt: undefined, createdAt: undefined });

/**
 * 復元の計画。既存データは消さない・上書きしない。
 *  - 連絡帳：取り込みと同じ比較（内容が違えば承認待ち）
 *  - その他の記録：新しいIDだけ追加。同じIDで内容が違うものは既存を残して報告
 *  - 添付：追加する記録の分だけ
 */
export function planRestore(
  b: BackupData,
  existing: { records: NoteRecord[]; items: Item[]; fileHashes: Set<string> },
  now: string,
): RestorePlan {
  const notes = planMerge(b.records, new Map(existing.records.map((r) => [r.id, r])), now);
  const cur = new Map(existing.items.map((i) => [i.id, i]));
  const itemsToAdd: Item[] = [];
  const itemsKeptExisting: Item[] = [];
  let itemsSame = 0;
  for (const it of b.items) {
    const c = cur.get(it.id);
    if (!c) itemsToAdd.push(it);
    else if (stable(c) === stable(it)) itemsSame++;
    else itemsKeptExisting.push(it);
  }
  const addIds = new Set(itemsToAdd.flatMap((i) => i.attachments.map((a) => a.id)));
  const blobsToAdd = b.blobs.filter((x) => addIds.has(x.key.split(':')[0]));
  const filesToAdd = b.files.filter((f) => !existing.fileHashes.has(f.hash));
  const fileSet = new Set(filesToAdd.map((f) => f.hash));
  const pdfsToAdd = b.pdfs.filter((p) => fileSet.has(p.hash));
  return { notes, itemsToAdd, itemsSame, itemsKeptExisting, blobsToAdd, filesToAdd, pdfsToAdd };
}
