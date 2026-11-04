import { packBackup, unpackBackup, planRestore, type BackupData, type BlobEntry } from './core/backup.ts';
import * as db from './db.ts';

export interface BackupResult {
  file: File;
  counts: { records: number; items: number; attachments: number; pdfs: number; events?: number };
  size: number;
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

/** 端末内の全データ（連絡帳・お知らせ・チラシ・写真・元PDF）をZIPにまとめる */
export async function createBackup(includePdfs: boolean, onStep: (s: string) => void): Promise<BackupResult> {
  onStep('記録を集めています');
  const [records, items, events, files, blobKeys, family, children] = await Promise.all([db.getRecords(), db.getItems(), db.getEvents(), db.getFiles(), db.getBlobKeys(), db.getFamily(), db.getChildren()]);
  const needed = new Set(items.flatMap((i) => i.attachments.flatMap((a) => a.variants.map((v) => `${a.id}:${v}`))));
  const blobs: BlobEntry[] = [];
  let n = 0;
  for (const key of blobKeys) {
    if (!needed.has(key)) continue; // 記録から外れた添付は含めない
    const row = await db.getBlob(key);
    if (!row) continue;
    blobs.push({ key, mime: row.mime, data: new Uint8Array(await row.blob.arrayBuffer()) });
    if (++n % 20 === 0) onStep(`添付ファイルを読み込んでいます（${n}件）`);
  }
  const pdfs = includePdfs
    ? await Promise.all(files.filter((f) => f.blob).map(async (f) => ({ hash: f.hash, data: new Uint8Array(await f.blob!.arrayBuffer()) })))
    : [];
  onStep('ファイルにまとめています');
  const now = new Date();
  const data: BackupData = {
    records,
    items,
    events,
    family,
    children,
    files: files.map(({ hash, name, size, importedAt, recordCount }) => ({ hash, name, size, importedAt, recordCount })),
    blobs,
    pdfs,
  };
  const { parts, manifest } = packBackup(data, now.toISOString());
  const file = new File(parts as BlobPart[], `atode-mitsukaru-backup-${stamp(now)}.zip`, { type: 'application/zip' });
  return { file, counts: manifest.counts, size: file.size };
}

export interface RestoreReport {
  createdAt: string;
  notesAdded: number;
  notesUnchanged: number;
  notesPending: number;
  itemsAdded: number;
  itemsSame: number;
  itemsKeptExisting: string[];
  eventsAdded: number;
  eventsSame: number;
  eventsKeptExisting: string[];
  childrenAdded: number;
  attachmentsAdded: number;
  pdfsAdded: number;
}

/** バックアップから復元。既存データは消さず、上書きもしない（違いは承認待ち・既存優先） */
export async function restoreBackup(file: File, onStep: (s: string) => void): Promise<RestoreReport> {
  onStep('バックアップを読み込んでいます');
  const b = await unpackBackup(new Uint8Array(await file.arrayBuffer()));
  const [records, items, events, files, children, family] = await Promise.all([db.getRecords(), db.getItems(), db.getEvents(), db.getFiles(), db.getChildren(), db.getFamily()]);
  const now = new Date().toISOString();
  const plan = planRestore(b, { records, items, events, children, fileHashes: new Set(files.map((f) => f.hash)) }, now);
  onStep('保存しています');
  const pdfByHash = new Map(plan.pdfsToAdd.map((p) => [p.hash, p.data]));
  await db.write([
    { store: 'blobs', put: plan.blobsToAdd.map((x) => ({ key: x.key, mime: x.mime, size: x.data.length, blob: new Blob([x.data as BlobPart], { type: x.mime }) })) },
    { store: 'items', put: plan.itemsToAdd.map((i) => ({ ...i, source: i.source ?? { via: 'restore', fileNames: [] } })) },
    { store: 'events', put: plan.eventsToAdd },
    {
      store: 'meta',
      put: [
        ...(plan.childrenToAdd.length ? [{ key: 'children', value: [...children, ...plan.childrenToAdd] }] : []),
        ...(!family && b.family ? [{ key: 'family', value: b.family }] : []),
      ],
    },
    { store: 'records', put: [...plan.notes.added, ...plan.notes.touched] },
    { store: 'pending', put: plan.notes.pending },
    {
      store: 'files',
      put: plan.filesToAdd.map((f) => {
        const data = pdfByHash.get(f.hash);
        return { ...f, blob: data ? new Blob([data as BlobPart], { type: 'application/pdf' }) : undefined, blobSaved: !!data };
      }),
    },
  ]);
  return {
    createdAt: b.manifest.createdAt,
    notesAdded: plan.notes.added.length,
    notesUnchanged: plan.notes.unchanged + plan.notes.keptRicher,
    notesPending: plan.notes.pending.length,
    itemsAdded: plan.itemsToAdd.length,
    itemsSame: plan.itemsSame,
    itemsKeptExisting: plan.itemsKeptExisting.map((i) => i.title || i.date),
    eventsAdded: plan.eventsToAdd.length,
    childrenAdded: plan.childrenToAdd.length,
    eventsSame: plan.eventsSame,
    eventsKeptExisting: plan.eventsKeptExisting.map((e) => `${e.date} ${e.title}`),
    attachmentsAdded: new Set(plan.blobsToAdd.map((x) => x.key.split(':')[0])).size,
    pdfsAdded: plan.pdfsToAdd.length,
  };
}
