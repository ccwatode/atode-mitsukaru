import { FIELD_LABELS, type NoteRecord, type ParsedRecord, type SourceRef } from './types.ts';

/** 再取り込み時に比較する項目 */
export const COMPARE_FIELDS = [
  'childName',
  'schoolName',
  'teacher',
  'classNote',
  'personalComment',
  'attendance',
  'sleep',
  'toilet',
  'meal',
  'otherLife',
  'homeMessage',
  'homeRecord',
  'fetchStatus',
  'rawText',
] as const;

export interface FieldDiff {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface PendingUpdate {
  id: string;
  date: string;
  incoming: NoteRecord;
  diffs: FieldDiff[];
  /** 新しいデータの本文のほうが長い */
  incomingHasMore: boolean;
  /** 既存の記録を利用者が編集している */
  currentEdited: boolean;
  createdAt: string;
}

export interface MergePlan {
  added: NoteRecord[];
  /** 出典だけ追加して内容は変えない記録 */
  touched: NoteRecord[];
  unchanged: number;
  keptRicher: number;
  pending: PendingUpdate[];
}

const contentLength = (r: Pick<NoteRecord, 'rawText'>) => r.rawText.replace(/\s/g, '').length;

export function toNoteRecord(p: ParsedRecord, source: SourceRef, now: string): NoteRecord {
  return { ...p, sources: [source], reviewStatus: '未確認', editedFields: [], updatedAt: now };
}

function addSource(r: NoteRecord, s: SourceRef): NoteRecord | null {
  if (r.sources.some((x) => x.fileHash === s.fileHash)) return null;
  return { ...r, sources: [...r.sources, s] };
}

export function diffRecords(current: NoteRecord, incoming: NoteRecord): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of COMPARE_FIELDS) {
    const a = String(current[f] ?? '');
    const b = String(incoming[f] ?? '');
    if (a !== b) out.push({ field: f, label: FIELD_LABELS[f] ?? f, before: a, after: b });
  }
  return out;
}

/**
 * 取り込んだ記録と保存済みの記録を突き合わせる。
 *  - 新しい日付 → 追加
 *  - 内容が同じ → 変更なし（出典ファイルだけ記録）
 *  - 新しい側が「未取得」で既存に本文がある → 既存を残す（情報の少ない版で上書きしない）
 *  - それ以外の違い → 上書きせず「承認待ち」にして差分を見せる
 */
export function planMerge(incoming: NoteRecord[], existing: Map<string, NoteRecord>, now: string): MergePlan {
  const plan: MergePlan = { added: [], touched: [], unchanged: 0, keptRicher: 0, pending: [] };
  for (const inc of incoming) {
    const cur = existing.get(inc.id);
    if (!cur) {
      plan.added.push(inc);
      continue;
    }
    const src = inc.sources[0];
    const diffs = diffRecords(cur, inc);
    if (!diffs.length || (inc.fetchStatus === '未取得' && cur.fetchStatus !== '未取得')) {
      if (diffs.length) plan.keptRicher++;
      else plan.unchanged++;
      const t = src ? addSource(cur, src) : null;
      if (t) plan.touched.push(t);
      continue;
    }
    plan.pending.push({
      id: inc.id,
      date: inc.date,
      incoming: inc,
      diffs,
      incomingHasMore: contentLength(inc) > contentLength(cur),
      currentEdited: cur.reviewStatus === '修正済み',
      createdAt: now,
    });
  }
  return plan;
}

/** 承認：解析結果の項目を新しいものに置き換え、出典はまとめる。確認状態は未確認に戻す */
export function applyPending(cur: NoteRecord | undefined, p: PendingUpdate, now: string): NoteRecord {
  if (!cur) return { ...p.incoming, updatedAt: now };
  const sources = [...cur.sources];
  for (const s of p.incoming.sources) if (!sources.some((x) => x.fileHash === s.fileHash)) sources.push(s);
  return { ...p.incoming, sources, reviewStatus: '未確認', editedFields: [], updatedAt: now };
}
