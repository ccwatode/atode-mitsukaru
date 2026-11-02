import { useEffect, useMemo, useRef } from 'react';
import { KIND_LABELS, type EntryKind } from '../core/types.ts';
import { searchDocs, type SearchDoc } from '../core/search.ts';
import { formatDate, Highlight, KindIcon, preview, StatusBadge } from './common.tsx';
import type { Entry } from './entries.ts';

export interface SearchState {
  q: string;
  from: string;
  to: string;
  kind: 'all' | EntryKind;
}

export function SearchView(props: { docs: SearchDoc[]; entries: Map<string, Entry>; child: string; s: SearchState; onChange: (s: SearchState) => void; onOpen: (e: Entry) => void; unfetched: number }) {
  const { s } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.q) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const active = !!(s.q.trim() || s.from || s.to || s.kind !== 'all');
  const hits = useMemo(
    () => (active ? searchDocs(props.docs, s.q, { from: s.from || undefined, to: s.to || undefined, kinds: s.kind === 'all' ? undefined : [s.kind], child: props.child || undefined }) : []),
    [props.docs, s, active, props.child],
  );
  const set = (p: Partial<SearchState>) => props.onChange({ ...s, ...p });
  return (
    <div className="screen">
      <form className="search-bar" role="search" onSubmit={(e) => (e.preventDefault(), inputRef.current?.blur())}>
        <input ref={inputRef} type="search" enterKeyHint="search" placeholder="キーワード（スペースで絞り込み）" value={s.q} onChange={(e) => set({ q: e.target.value })} aria-label="キーワード" />
      </form>
      <div className="chips chips-scroll" role="group" aria-label="種類">
        {(['all', 'note', 'notice', 'flyer', 'photo', 'memo'] as const).map((k) => (
          <button key={k} className={`chip ${s.kind === k ? 'on' : ''}`} aria-pressed={s.kind === k} onClick={() => set({ kind: k })}>
            {k === 'all' ? 'すべて' : KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="date-range">
        <label>
          <span>いつから</span>
          <input type="date" value={s.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label>
          <span>いつまで</span>
          <input type="date" value={s.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        {(s.from || s.to) && (
          <button className="btn btn-small btn-ghost" onClick={() => set({ from: '', to: '' })}>
            期間を解除
          </button>
        )}
      </div>
      {active ? (
        <>
          <p className="muted small" aria-live="polite">
            {hits.length}件見つかりました
            {props.unfetched > 0 && s.q.trim() && (s.kind === 'all' || s.kind === 'note') && `（本文未取得の連絡帳${props.unfetched}日分は本文を検索できません）`}
          </p>
          <ul className="results">
            {hits.map((h) => {
              const e = props.entries.get(h.doc.id);
              if (!e) return null;
              const title = e.note ? '連絡帳' : e.item!.title || KIND_LABELS[e.kind];
              return (
                <li key={h.doc.id}>
                  <button className="result" onClick={() => props.onOpen(e)}>
                    <span className="result-head">
                      <KindIcon kind={e.kind} size={15} />
                      <span className="result-title">{title}</span>
                      <span className="result-date">{formatDate(e.date)}</span>
                    </span>
                    {e.note && e.note.fetchStatus !== '取得済み' && <StatusBadge s={e.note.fetchStatus} />}
                    {h.snippets.length ? (
                      h.snippets.map((sn, i) => (
                        <span key={i} className="snippet">
                          <span className="snippet-label">{sn.label}</span>
                          <Highlight {...sn} />
                        </span>
                      ))
                    ) : (
                      <span className="result-sub">{e.note ? (e.note.fetchStatus === '未取得' ? '本文はPDFに含まれていません' : preview(e.note.classNote || e.note.rawText)) : preview(e.item!.body)}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="muted">連絡帳、お知らせ、チラシ（画像の中の文字を含む）、写真の説明、行事名を探します。「3/31」のように日付でも探せます。</p>
      )}
    </div>
  );
}
