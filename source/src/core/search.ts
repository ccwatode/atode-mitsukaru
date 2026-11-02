import { FIELD_LABELS, KIND_LABELS, type EntryKind, type Item, type NoteRecord } from './types.ts';

/**
 * 検索用の正規化：全角半角(NFKC)・大文字小文字・カタカナ/ひらがな・空白改行の違いを無視する。
 * 元の文字位置への対応表を持たせ、該当箇所を原文のまま切り出せるようにする。
 */
export function fold(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const len = ch.length;
    if (!/\s/.test(ch)) {
      let n = ch.normalize('NFKC').toLowerCase();
      n = n.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
      for (const c of n) {
        if (/\s/.test(c)) continue;
        text += c;
        map.push(i);
      }
    }
    i += len;
  }
  return { text, map };
}

export const foldText = (s: string) => fold(s).text;

/* ---------- 汎用：連絡帳・お知らせ・チラシ・写真を同じ形で検索する ---------- */

export interface SearchField {
  key: string;
  label: string;
  text: string;
}

export interface SearchDoc {
  id: string;
  kind: EntryKind;
  date: string;
  childName: string;
  fields: SearchField[];
}

export interface Snippet {
  field: string;
  label: string;
  before: string;
  match: string;
  after: string;
}

export interface DocHit {
  doc: SearchDoc;
  snippets: Snippet[];
}

export interface SearchOptions {
  from?: string; // YYYY-MM-DD
  to?: string;
  kinds?: EntryKind[];
  child?: string;
}

/** 連絡帳の検索対象（上から優先して該当箇所を表示）。原文は最後 */
export const SEARCH_FIELDS: (keyof NoteRecord)[] = [
  'classNote',
  'personalComment',
  'homeMessage',
  'homeRecord',
  'attendance',
  'sleep',
  'toilet',
  'meal',
  'otherLife',
  'teacher',
  'schoolName',
  'childName',
  'rawText',
];

export function noteToDoc(r: NoteRecord): SearchDoc {
  return {
    id: r.id,
    kind: 'note',
    date: r.date,
    childName: r.childName,
    fields: SEARCH_FIELDS.map((f) => ({ key: f, label: FIELD_LABELS[f] ?? f, text: String(r[f] ?? '') })),
  };
}

export function itemToDoc(it: Item): SearchDoc {
  return {
    id: it.id,
    kind: it.kind,
    date: it.date,
    childName: it.childName,
    fields: [
      { key: 'title', label: 'タイトル', text: it.title },
      { key: 'body', label: it.kind === 'photo' ? '説明' : '本文', text: it.body },
      { key: 'event', label: '行事', text: it.event },
      { key: 'searchText', label: '画像内の文字など', text: it.searchText },
      { key: 'files', label: 'ファイル名', text: it.attachments.map((a) => a.name).join(' ') },
      { key: 'kind', label: '種類', text: KIND_LABELS[it.kind] },
    ],
  };
}

/** 「3/31」「3月31日」「2026-03-31」のような語は日付として扱う */
function dateTerm(term: string): RegExp | null {
  const t = term.normalize('NFKC');
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t);
  if (m) return new RegExp(`^${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}$`);
  m = /^(\d{1,2})[/月](\d{1,2})日?$/.exec(t);
  if (m) return new RegExp(`^\\d{4}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}$`);
  return null;
}

function snippetOf(field: SearchField, folded: { text: string; map: number[] }, ft: string): Snippet | null {
  const src = field.text;
  const at = folded.text.indexOf(ft);
  if (at < 0) return null;
  const start = folded.map[at];
  const lastStart = folded.map[at + ft.length - 1];
  const end = lastStart + ([...src.slice(lastStart)][0]?.length ?? 1);
  const ctxB = Math.max(0, start - 28);
  const ctxA = Math.min(src.length, end + 40);
  return {
    field: field.key,
    label: field.label,
    before: (ctxB > 0 ? '…' : '') + src.slice(ctxB, start).replace(/\s+/g, ' '),
    match: src.slice(start, end),
    after: src.slice(end, ctxA).replace(/\s+/g, ' ') + (ctxA < src.length ? '…' : ''),
  };
}

export function searchDocs(docs: SearchDoc[], query: string, opts: SearchOptions = {}): DocHit[] {
  const terms = query.normalize('NFKC').split(/\s+/).filter(Boolean);
  const hits: DocHit[] = [];
  for (const d of docs) {
    if (opts.from && d.date < opts.from) continue;
    if (opts.to && d.date > opts.to) continue;
    if (opts.kinds && opts.kinds.length && !opts.kinds.includes(d.kind)) continue;
    if (opts.child && d.childName && d.childName !== opts.child) continue;
    if (!terms.length) {
      hits.push({ doc: d, snippets: [] });
      continue;
    }
    const folded = d.fields.map((f) => ({ f, folded: fold(f.text) }));
    const snippets: Snippet[] = [];
    let all = true;
    for (const term of terms) {
      const dt = dateTerm(term);
      if (dt && dt.test(d.date)) continue;
      const ft = foldText(term);
      if (!ft) continue;
      let found: Snippet | null = null;
      for (const x of folded) {
        found = snippetOf(x.f, x.folded, ft);
        if (found) break;
      }
      if (!found) {
        all = false;
        break;
      }
      if (!snippets.some((s) => s.field === found!.field && s.match === found!.match)) snippets.push(found);
    }
    if (all) hits.push({ doc: d, snippets });
  }
  hits.sort((a, b) => (a.doc.date < b.doc.date ? 1 : a.doc.date > b.doc.date ? -1 : 0));
  return hits;
}

/* ---------- 連絡帳だけを検索する従来の関数（互換） ---------- */

export interface SearchHit {
  record: NoteRecord;
  snippets: Snippet[];
}

export function search(records: NoteRecord[], query: string, opts: SearchOptions = {}): SearchHit[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  return searchDocs(records.map(noteToDoc), query, opts).map((h) => ({ record: byId.get(h.doc.id)!, snippets: h.snippets }));
}
