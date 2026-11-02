import { parseNotebook } from './core/parse.ts';
import { planMerge, toNoteRecord, type MergePlan } from './core/merge.ts';
import { fromJSON } from './core/exportData.ts';
import type { FetchStatus, NoteRecord, SourceRef } from './core/types.ts';
import { getFiles, putFile, putPending, putRecords } from './db.ts';

export interface ImportReport {
  kind: 'pdf' | 'json';
  fileName: string;
  alreadyImported: boolean;
  headingCount: number;
  counts: Record<FetchStatus, number>;
  added: number;
  unchanged: number;
  keptRicher: number;
  pending: number;
  warnings: string[];
  pdfSaved?: boolean;
  /** PDFが最下端で切れている可能性（次に取り込む範囲の案内用） */
  truncation?: { atHeightLimit: boolean; lastDate: string } | null;
  elapsedMs: number;
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function commit(plan: MergePlan): Promise<void> {
  await putRecords([...plan.added, ...plan.touched]);
  await putPending(plan.pending);
}

function countStatus(rs: { fetchStatus: FetchStatus }[]): Record<FetchStatus, number> {
  const c: Record<FetchStatus, number> = { 取得済み: 0, 要確認: 0, 未取得: 0 };
  for (const r of rs) c[r.fetchStatus]++;
  return c;
}

export async function importPdf(file: File, existing: NoteRecord[], onStep: (s: string) => void): Promise<ImportReport> {
  const t0 = performance.now();
  onStep('PDFを読み込んでいます');
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  const files = await getFiles();
  const already = files.some((f) => f.hash === hash);
  onStep('文字を取り出しています');
  // 抽出処理は端末内のみ。PDF.jsにバッファを渡すと移譲されるため複製を渡す
  const { extractFromPdf } = await import('./pdf.ts');
  const doc = await extractFromPdf(new Uint8Array(buf.slice(0)));
  onStep('日付ごとに分けています');
  const res = parseNotebook(doc);
  const now = new Date().toISOString();
  const src: SourceRef = { fileName: file.name, fileHash: hash, importedAt: now };
  const incoming = res.records.map((r) => toNoteRecord(r, src, now));
  const plan = planMerge(incoming, new Map(existing.map((r) => [r.id, r])), now);
  onStep('保存しています');
  await commit(plan);
  let pdfSaved: boolean | undefined;
  if (!already && res.records.length) {
    const saved = await putFile({ hash, name: file.name, size: file.size, importedAt: now, recordCount: res.records.length, blob: file, blobSaved: true });
    pdfSaved = saved.blobSaved;
  }
  return {
    kind: 'pdf',
    fileName: file.name,
    alreadyImported: already,
    headingCount: res.headingCount,
    counts: countStatus(res.records),
    added: plan.added.length,
    unchanged: plan.unchanged,
    keptRicher: plan.keptRicher,
    pending: plan.pending.length,
    warnings: res.warnings,
    pdfSaved,
    truncation: res.truncation,
    elapsedMs: performance.now() - t0,
  };
}

export async function importJson(file: File, existing: NoteRecord[]): Promise<ImportReport> {
  const t0 = performance.now();
  const text = await file.text();
  const records = fromJSON(text);
  const hash = await sha256(new TextEncoder().encode(text).buffer as ArrayBuffer);
  const now = new Date().toISOString();
  const incoming = records.map((r) => (r.sources.length ? r : { ...r, sources: [{ fileName: file.name, fileHash: hash, importedAt: now }] }));
  const plan = planMerge(incoming, new Map(existing.map((r) => [r.id, r])), now);
  await commit(plan);
  return {
    kind: 'json',
    fileName: file.name,
    alreadyImported: false,
    headingCount: records.length,
    counts: countStatus(records),
    added: plan.added.length,
    unchanged: plan.unchanged,
    keptRicher: plan.keptRicher,
    pending: plan.pending.length,
    warnings: [],
    elapsedMs: performance.now() - t0,
  };
}
