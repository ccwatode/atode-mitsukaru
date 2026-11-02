import type { EntryKind, Item, NoteRecord } from '../core/types.ts';

/** 画面で連絡帳とその他の記録を同じ列に並べるための形 */
export interface Entry {
  id: string;
  kind: EntryKind;
  date: string;
  childName: string;
  note?: NoteRecord;
  item?: Item;
}

export function buildEntries(records: NoteRecord[], items: Item[]): Entry[] {
  const out: Entry[] = [
    ...records.map((r) => ({ id: r.id, kind: 'note' as const, date: r.date, childName: r.childName, note: r })),
    ...items.map((i) => ({ id: i.id, kind: i.kind, date: i.date, childName: i.childName, item: i })),
  ];
  // 新しい日付が上。同じ日はお知らせ・チラシ・写真を連絡帳より上に（新しく入ったものが見つけやすい）
  return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.kind === 'note' ? 1 : b.kind === 'note' ? -1 : (b.item?.createdAt ?? '').localeCompare(a.item?.createdAt ?? '')));
}

export function childrenOf(records: NoteRecord[], items: Item[]): string[] {
  const s = new Set<string>();
  for (const r of records) if (r.childName) s.add(r.childName);
  for (const i of items) if (i.childName) s.add(i.childName);
  return [...s].sort((a, b) => a.localeCompare(b, 'ja'));
}

export function eventsOf(items: Item[]): string[] {
  return [...new Set(items.map((i) => i.event).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 子どもの絞り込み。名前のない記録（家族全体）は常に表示 */
export const matchChild = (e: { childName: string }, child: string) => !child || !e.childName || e.childName === child;
