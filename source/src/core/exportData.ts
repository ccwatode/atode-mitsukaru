import type { NoteRecord } from './types.ts';

export const EXPORT_APP = 'atode-mitsukaru';
export const EXPORT_VERSION = 1;

export interface ExportFile {
  app: typeof EXPORT_APP;
  version: number;
  exportedAt: string;
  records: NoteRecord[];
}

export function toJSON(records: NoteRecord[], now: string): string {
  const data: ExportFile = { app: EXPORT_APP, version: EXPORT_VERSION, exportedAt: now, records };
  return JSON.stringify(data, null, 2);
}

const REQUIRED: (keyof NoteRecord)[] = ['id', 'date', 'rawText', 'fetchStatus'];
const STR_FIELDS: (keyof NoteRecord)[] = [
  'childName', 'schoolName', 'teacher', 'classNote', 'personalComment', 'attendance', 'sleep', 'toilet', 'meal', 'otherLife', 'homeMessage', 'homeRecord', 'statusReason', 'updatedAt',
];

/** JSONを検証して記録に戻す。壊れたファイルは理由つきで拒否する */
export function fromJSON(text: string): NoteRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み込めませんでした');
  }
  const d = data as Partial<ExportFile>;
  if (!d || d.app !== EXPORT_APP || !Array.isArray(d.records)) throw new Error('「あとで見つかる」で書き出したJSONではありません');
  if ((d.version ?? 0) > EXPORT_VERSION) throw new Error('新しいバージョンで書き出されたファイルです');
  return d.records.map((r, i) => {
    for (const k of REQUIRED) if (typeof (r as unknown as Record<string, unknown>)[k] !== 'string') throw new Error(`${i + 1}件目の「${k}」が不正です`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`${i + 1}件目の日付が不正です`);
    if (!['取得済み', '要確認', '未取得'].includes(r.fetchStatus)) throw new Error(`${i + 1}件目の取得状態が不正です`);
    const out = { ...r } as NoteRecord;
    for (const k of STR_FIELDS) if (typeof out[k] !== 'string') (out as unknown as Record<string, unknown>)[k] = '';
    out.sources = Array.isArray(r.sources) ? r.sources : [];
    out.editedFields = Array.isArray(r.editedFields) ? r.editedFields : [];
    out.reviewStatus = ['未確認', '確認済み', '修正済み'].includes(r.reviewStatus) ? r.reviewStatus : '未確認';
    return out;
  });
}

const CSV_COLUMNS: [keyof NoteRecord | 'sourceFiles', string][] = [
  ['date', '日付'],
  ['childName', '園児名'],
  ['schoolName', '園名'],
  ['teacher', '担当教諭'],
  ['fetchStatus', '取得状態'],
  ['reviewStatus', '確認・修正状態'],
  ['classNote', '先生からの連絡'],
  ['personalComment', '個別コメント'],
  ['attendance', '登降園'],
  ['sleep', '睡眠'],
  ['toilet', '排泄'],
  ['meal', '食事'],
  ['otherLife', 'その他の記録'],
  ['homeMessage', '家庭からの連絡'],
  ['homeRecord', '家庭での記録'],
  ['statusReason', '判定理由'],
  ['sourceFiles', '取り込み元ファイル'],
];

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** Excel/Numbersで文字化けしないようBOM付きUTF-8、改行はCRLF */
export function toCSV(records: NoteRecord[]): string {
  const lines = [CSV_COLUMNS.map(([, h]) => q(h)).join(',')];
  for (const r of [...records].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push(
      CSV_COLUMNS.map(([k]) => q(k === 'sourceFiles' ? r.sources.map((s) => s.fileName).join(' / ') : String(r[k] ?? ''))).join(','),
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
