import { useMemo, useState, type ReactNode } from 'react';
import { KIND_LABELS, type EntryKind } from '../core/types.ts';
import { dayParts, GenreTag, KindIcon, preview, StatusBadge, Thumb } from './common.tsx';
import { IconAlert, IconChevron, IconPlus, IconSearch, IconShield } from './icons.tsx';
import type { Entry } from './entries.ts';

/** 'all'／種類（連絡帳・ジャンルのない記録）／'g:ジャンル名' */
export type KindFilter = 'all' | EntryKind | `g:${string}`;
const KINDS: EntryKind[] = ['note', 'notice', 'flyer', 'photo', 'memo'];

export const matchFilter = (e: Entry, f: KindFilter) => f === 'all' || (f.startsWith('g:') ? e.item?.genre === f.slice(2) : e.kind === f && !e.item?.genre);

type Row = { type: 'entry'; e: Entry } | { type: 'unfetched'; list: Entry[] };

function EntryRow({ e, onOpen }: { e: Entry; onOpen: (e: Entry) => void }) {
  const { day, wd } = dayParts(e.date);
  let title: ReactNode;
  let sub: string;
  let extra: ReactNode = null;
  if (e.note) {
    const n = e.note;
    title = '連絡帳';
    sub = n.fetchStatus === '未取得' ? '本文はPDFに含まれていません' : preview(n.classNote || n.personalComment || n.homeMessage || n.rawText, 70);
    if (n.fetchStatus !== '取得済み') extra = <StatusBadge s={n.fetchStatus} />;
  } else {
    const it = e.item!;
    title = it.title || KIND_LABELS[it.kind];
    sub = preview(it.body || it.searchText || (it.event ? `行事：${it.event}` : ''), 70);
    const saved = it.attachments.filter((a) => a.state !== 'missing');
    if (saved.length) {
      extra = (
        <span className="strip">
          {saved.slice(0, 3).map((a) => (
            <Thumb key={a.id} att={a} className="thumb-s" />
          ))}
          {saved.length > 3 && <span className="strip-more">+{saved.length - 3}</span>}
        </span>
      );
    }
  }
  return (
    <button className={`entry entry-${e.kind}`} onClick={() => onOpen(e)}>
      <span className="entry-day" aria-label={`${day}日（${wd}）`}>
        <span className="day-num">{day}</span>
        <span className="day-wd">{wd}</span>
      </span>
      <span className="entry-main">
        <span className="entry-title">
          <KindIcon kind={e.kind} size={15} />
          <span className="entry-title-text">{title}</span>
          {e.item?.genre && <GenreTag name={e.item.genre} />}
          {e.childName && !e.item?.genre && <span className="entry-child">{e.childName}</span>}
        </span>
        {sub && <span className="entry-sub">{sub}</span>}
        {extra}
      </span>
      <IconChevron size={18} className="entry-chev" />
    </button>
  );
}

function UnfetchedRow({ list, onOpen }: { list: Entry[]; onOpen: (e: Entry) => void }) {
  const [open, setOpen] = useState(false);
  const first = dayParts(list[0].date);
  const last = dayParts(list[list.length - 1].date);
  if (open)
    return (
      <>
        {list.map((e) => (
          <EntryRow key={e.id} e={e} onOpen={onOpen} />
        ))}
        <button className="unfetched" onClick={() => setOpen(false)}>
          閉じる
        </button>
      </>
    );
  return (
    <button className="unfetched" onClick={() => setOpen(true)} aria-expanded={false}>
      <span className="unfetched-dots" aria-hidden />
      本文未取得の連絡帳 {list.length}日
      <span className="muted">
        （{list.length > 1 ? `${last.day}日〜${first.day}日` : `${first.day}日`}）
      </span>
    </button>
  );
}

export function Timeline(props: {
  entries: Entry[];
  filter: KindFilter;
  onFilter: (f: KindFilter) => void;
  onOpen: (e: Entry) => void;
  onAdd: () => void;
  onSearch: () => void;
  banners: ReactNode;
  counts: { note: number; unfetched: number };
}) {
  const shown = props.entries.filter((e) => matchFilter(e, props.filter));
  // 絞り込みのボタン：連絡帳 → ジャンル（多い順）→ ジャンルのない記録の種類
  const filters = useMemo(() => {
    const g = new Map<string, number>();
    const k = new Set<EntryKind>();
    for (const e of props.entries) {
      if (e.item?.genre) g.set(e.item.genre, (g.get(e.item.genre) ?? 0) + 1);
      else k.add(e.kind);
    }
    const genres = [...g.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => `g:${name}` as KindFilter);
    return ['all' as KindFilter, ...KINDS.filter((x) => x === 'note' && k.has(x)), ...genres, ...KINDS.filter((x) => x !== 'note' && k.has(x))];
  }, [props.entries]);
  const months = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const e of shown) {
      const key = e.date.slice(0, 7);
      if (!m.has(key)) m.set(key, []);
      const rows = m.get(key)!;
      const last = rows[rows.length - 1];
      if (e.note?.fetchStatus === '未取得') {
        if (last?.type === 'unfetched') last.list.push(e);
        else rows.push({ type: 'unfetched', list: [e] });
      } else rows.push({ type: 'entry', e });
    }
    return [...m.entries()];
  }, [shown]);

  return (
    <div className="screen">
      <button className="search-launch" onClick={props.onSearch}>
        <IconSearch size={20} />
        <span>連絡帳・お知らせ・チラシを探す</span>
      </button>
      {props.banners}
      <div className="chips chips-scroll" role="group" aria-label="種類で絞り込み">
        {filters.map((f) => (
          <button key={f} className={`chip ${props.filter === f ? 'on' : ''}`} aria-pressed={props.filter === f} onClick={() => props.onFilter(f)}>
            {f === 'all' ? 'すべて' : f.startsWith('g:') ? f.slice(2) : KIND_LABELS[f as EntryKind]}
          </button>
        ))}
      </div>
      {!props.entries.length ? (
        <div className="empty-hero">
          <IconShield size={40} />
          <h2>保育園の情報を、ここにためていきましょう</h2>
          <p>連絡帳のPDF、お知らせの文章、チラシや写真を追加すると、日付順に並び、あとから検索できます。データはこのiPhoneの中だけに保存されます。</p>
          <button className="btn btn-primary btn-xl" onClick={props.onAdd}>
            <IconPlus size={20} /> 最初の記録を追加
          </button>
        </div>
      ) : !shown.length ? (
        <p className="empty">この種類の記録はまだありません。</p>
      ) : (
        months.map(([month, rows]) => (
          <section key={month} className="month">
            <h2 className="month-head">
              {+month.slice(0, 4)}年<span className="month-num">{+month.slice(5)}</span>月
            </h2>
            <div className="entries">
              {rows.map((r, i) => (r.type === 'entry' ? <EntryRow key={r.e.id} e={r.e} onOpen={props.onOpen} /> : <UnfetchedRow key={`u-${i}-${r.list[0].id}`} list={r.list} onOpen={props.onOpen} />))}
            </div>
          </section>
        ))
      )}
      {props.counts.unfetched > 0 && (props.filter === 'all' || props.filter === 'note') && (
        <p className="small muted footnote">
          <IconAlert size={14} /> 連絡帳{props.counts.note}日分のうち{props.counts.unfetched}日は本文未取得です。連絡帳アプリで「さらに表示」を開いて保存したPDFを追加すると埋まります。
        </p>
      )}
    </div>
  );
}
