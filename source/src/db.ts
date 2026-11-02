import type { CalEvent, Item, NoteRecord } from './core/types.ts';
import type { PendingUpdate } from './core/merge.ts';

/** 取り込んだPDFファイルの記録 */
export interface FileEntry {
  hash: string;
  name: string;
  size: number;
  importedAt: string;
  recordCount: number;
  /** 元PDF。容量不足などで保存できなかった場合は undefined */
  blob?: Blob;
  blobSaved: boolean;
}

/** 添付ファイルの実体。key = `${attachmentId}:${variant}` */
export interface BlobRow {
  key: string;
  mime: string;
  size: number;
  blob: Blob;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

const DB_NAME = 'atode-mitsukaru';
/**
 * v1：records / files / pending（MVP）
 * v2：items / blobs / meta を追加。既存ストアには触れない（データ移行なし）
 * v3：events（予定）を追加。既存ストアには触れない
 */
const DB_VERSION = 3;
type StoreName = 'records' | 'files' | 'pending' | 'items' | 'blobs' | 'meta' | 'events';
const ALL: StoreName[] = ['records', 'files', 'pending', 'items', 'blobs', 'meta', 'events'];
const KEY: Record<StoreName, string> = { records: 'id', files: 'hash', pending: 'id', items: 'id', blobs: 'key', meta: 'key', events: 'id' };

/** IndexedDBが使えない環境ではメモリ上に保存し、その旨を表示する */
let memory: Record<StoreName, Map<string, unknown>> | null = null;
const newMemory = () => Object.fromEntries(ALL.map((s) => [s, new Map()])) as Record<StoreName, Map<string, unknown>>;

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** 保存先を開けなかった理由（画面での案内用） */
export let openProblem: null | 'blocked' | 'unavailable' = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ALL) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEY[s] });
      };
      req.onsuccess = () => {
        const db = req.result;
        // 別タブで新しい版が開かれたら閉じて譲る（更新が止まらないように）
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => {
        openProblem = 'unavailable';
        resolve(null);
      };
      // 古い版が別のタブで開いていると更新が待たされる。少し待っても進まなければ案内する
      req.onblocked = () => {
        setTimeout(() => {
          openProblem = 'blocked';
          resolve(null);
        }, 5000);
      };
    } catch {
      openProblem = 'unavailable';
      resolve(null);
    }
  }).then((db) => {
    if (db) openProblem = null;
    if (!db) memory = newMemory();
    return db;
  });
  dbPromise = p;
  return p;
}

export async function isPersistentStorage(): Promise<boolean> {
  return (await open()) !== null;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました'));
  });
}

async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  if (!db) return [...memory![store].values()] as T[];
  return req(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return memory![store].get(key) as T | undefined;
  return req(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

async function getKeys(store: StoreName): Promise<string[]> {
  const db = await open();
  if (!db) return [...memory![store].keys()];
  return (await req(db.transaction(store).objectStore(store).getAllKeys())) as string[];
}

/** 複数ストアへの書き込み・削除を1つの処理で行う（途中で失敗したら全部取り消し） */
export interface WriteOp {
  store: StoreName;
  put?: object[];
  del?: string[];
}

export async function write(ops: WriteOp[]): Promise<void> {
  const used = ops.filter((o) => (o.put?.length ?? 0) + (o.del?.length ?? 0) > 0);
  if (!used.length) return;
  const db = await open();
  if (!db) {
    for (const o of used) {
      for (const v of o.put ?? []) memory![o.store].set((v as Record<string, string>)[KEY[o.store]], v);
      for (const k of o.del ?? []) memory![o.store].delete(k);
    }
    return;
  }
  const tx = db.transaction([...new Set(used.map((o) => o.store))], 'readwrite');
  for (const o of used) {
    const os = tx.objectStore(o.store);
    for (const v of o.put ?? []) os.put(v);
    for (const k of o.del ?? []) os.delete(k);
  }
  await done(tx);
}

/* ---------- 連絡帳（v1 から変更なし） ---------- */

export const getRecords = () => getAll<NoteRecord>('records');
export const putRecords = (rs: NoteRecord[]) => write([{ store: 'records', put: rs }]);
export const getPending = () => getAll<PendingUpdate>('pending');
export const putPending = (ps: PendingUpdate[]) => write([{ store: 'pending', put: ps }]);
export const deletePending = (id: string) => write([{ store: 'pending', del: [id] }]);
export const getFiles = () => getAll<FileEntry>('files');

/** 元PDFも保存を試み、容量制限で失敗したら本体なしで記録だけ残す */
export async function putFile(entry: FileEntry): Promise<FileEntry> {
  try {
    await write([{ store: 'files', put: [entry] }]);
    return entry;
  } catch {
    const slim = { ...entry, blob: undefined, blobSaved: false };
    await write([{ store: 'files', put: [slim] }]);
    return slim;
  }
}

/** 承認：記録の更新と承認待ちの削除を1つの処理で行う */
export const approvePending = (records: NoteRecord[], pendingIds: string[]) =>
  write([
    { store: 'records', put: records },
    { store: 'pending', del: pendingIds },
  ]);

/* ---------- v2：お知らせ・チラシ・写真 ---------- */

export const getItems = () => getAll<Item>('items');
export const getBlob = (key: string) => getOne<BlobRow>('blobs', key);
export const getBlobKeys = () => getKeys('blobs');

/** 記録と添付をまとめて保存（どちらかが失敗したら両方取り消し） */
export const saveItem = (item: Item, blobs: BlobRow[] = []) =>
  write([
    { store: 'blobs', put: blobs },
    { store: 'items', put: [item] },
  ]);

export async function deleteItem(item: Item): Promise<void> {
  const keys = item.attachments.flatMap((a) => a.variants.map((v) => `${a.id}:${v}`));
  await write([
    { store: 'items', del: [item.id] },
    { store: 'blobs', del: keys },
  ]);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await getOne<MetaRow>('meta', key))?.value as T | undefined;
}
export const setMeta = (key: string, value: unknown) => write([{ store: 'meta', put: [{ key, value }] }]);

/* ---------- v3：予定 ---------- */

export const getEvents = () => getAll<CalEvent>('events');
export const putEvents = (es: CalEvent[]) => write([{ store: 'events', put: es }]);
export const deleteEvent = (id: string) => write([{ store: 'events', del: [id] }]);

/* ---------- 全体 ---------- */

export async function clearAll(): Promise<void> {
  const db = await open();
  if (!db) {
    memory = newMemory();
    return;
  }
  const tx = db.transaction(ALL, 'readwrite');
  for (const s of ALL) tx.objectStore(s).clear();
  await done(tx);
}

export async function storageInfo(): Promise<{ usage?: number; quota?: number; persisted?: boolean }> {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    return { usage: est?.usage, quota: est?.quota, persisted };
  } catch {
    return {};
  }
}

/** 永続保存をブラウザに依頼（Safariではホーム画面のアプリで許可されやすい） */
export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
