import { useEffect, useMemo, useState } from 'react';
import { genreChoices, titleKey, type GenreChoice, type ListParseResult, type MissingRef, type PostPlan } from '../core/oshirase.ts';
import type { Item } from '../core/types.ts';
import type { ListImage } from '../listpdf.ts';
import type { PostChoice } from '../listImport.ts';
import { formatBytes, formatDate, Modal, preview } from './common.tsx';
import { IconAlert, IconCheck, IconChevron, IconClose, IconDoc, IconPhoto, IconPlus, IconUpload } from './icons.tsx';

const WHY: Record<GenreChoice['why'], string> = { past: '前回', suggest: '提案', used: '' };

/** ジャンルをボタンで選ぶ。候補にないときは「新しく作る」 */
export function GenrePicker(props: { choices: GenreChoice[]; value: string; onChange: (g: string) => void; max?: number }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [all, setAll] = useState(false);
  const max = props.max ?? 5;
  let shown = all ? props.choices : props.choices.slice(0, max);
  if (props.value && !shown.some((c) => c.name === props.value)) shown = [...shown, props.choices.find((c) => c.name === props.value) ?? { name: props.value, why: 'used' as const }];
  const commit = () => {
    const g = name.trim();
    if (g) props.onChange(g);
    setAdding(false);
    setName('');
  };
  return (
    <div className="genre-picker" role="radiogroup" aria-label="ジャンル">
      {shown.map((c) => (
        <button key={c.name} role="radio" aria-checked={props.value === c.name} className={`gchip ${props.value === c.name ? 'on' : ''}`} onClick={() => props.onChange(c.name)}>
          {props.value === c.name && <IconCheck size={14} />}
          <span>{c.name}</span>
          {WHY[c.why] && <small>{WHY[c.why]}</small>}
        </button>
      ))}
      {!all && props.choices.length > shown.length && (
        <button className="gchip gchip-ghost" onClick={() => setAll(true)}>
          ほか{props.choices.length - shown.length}
        </button>
      )}
      {adding ? (
        <span className="genre-new">
          <input autoFocus value={name} placeholder="新しいジャンル" aria-label="新しいジャンルの名前" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit()} />
          <button className="btn btn-small btn-primary" onClick={commit} disabled={!name.trim()}>
            決定
          </button>
        </span>
      ) : (
        <button className="gchip gchip-ghost" onClick={() => setAdding(true)}>
          <IconPlus size={14} /> 新しく作る
        </button>
      )}
    </div>
  );
}

function BlobThumbs({ blobs, total }: { blobs: Blob[]; total: number }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = blobs.map((b) => URL.createObjectURL(b));
    setUrls(u);
    return () => u.forEach((x) => URL.revokeObjectURL(x));
  }, [blobs]);
  if (!total) return null;
  return (
    <span className="strip">
      {urls.map((u, i) => (
        <span key={i} className="thumb thumb-s">
          <img src={u} alt="" loading="lazy" />
        </span>
      ))}
      {total > urls.length && <span className="strip-more">+{total - urls.length}</span>}
    </span>
  );
}

export function ListReview(props: {
  fileName: string;
  parsed: ListParseResult;
  images: ListImage[];
  assign: number[][];
  plan: PostPlan[];
  existing: Item[];
  onCommit: (choices: PostChoice[]) => void;
  onCancel: () => void;
}) {
  const { posts } = props.parsed;
  const exById = useMemo(() => new Map(props.existing.map((i) => [i.id, i])), [props.existing]);
  const cands = useMemo(() => posts.map((p) => genreChoices({ title: p.title, body: p.body, hasPdf: p.attachments.length > 0 }, props.existing)), [posts, props.existing]);
  const [choices, setChoices] = useState<PostChoice[]>(() =>
    posts.map((_, i) => {
      const pl = props.plan[i];
      if (pl.status === 'new') return { action: 'add', genre: cands[i][0]?.name ?? 'お知らせ' };
      return { action: pl.status === 'fuller' ? 'update' : 'skip', genre: exById.get(pl.existingId ?? '')?.genre ?? '' };
    }),
  );
  // まだ自分で選んでいない記事（同じ題名の記事を選んだら一緒に変える）
  const [auto, setAuto] = useState<boolean[]>(() => posts.map(() => true));
  const [note, setNote] = useState('');
  const [only, setOnly] = useState('');

  const newIdx = posts.map((_, i) => i).filter((i) => props.plan[i].status === 'new');
  const fullerIdx = posts.map((_, i) => i).filter((i) => props.plan[i].status === 'fuller');
  const sameCount = props.plan.filter((p) => p.status === 'same').length;
  const adding = newIdx.filter((i) => choices[i].action === 'add');
  const updating = fullerIdx.filter((i) => choices[i].action === 'update');
  const byGenre = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of adding) m.set(choices[i].genre, (m.get(choices[i].genre) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [choices]); // eslint-disable-line react-hooks/exhaustive-deps
  const photoCount = [...adding, ...updating.filter((i) => props.plan[i].morePhotos)].reduce((s, i) => s + props.assign[i].length, 0);

  const setGenre = (i: number, g: string) => {
    const key = titleKey(posts[i].title);
    const mates = newIdx.filter((j) => j !== i && auto[j] && key && titleKey(posts[j].title) === key && choices[j].genre !== g);
    setChoices((cs) => cs.map((c, j) => (j === i || mates.includes(j) ? { ...c, genre: g } : c)));
    setAuto((a) => a.map((v, j) => (j === i ? false : v)));
    setNote(mates.length ? `同じ題名の${mates.length}件も「${g}」にしました` : '');
  };
  const toggle = (i: number, on: boolean, action: PostChoice['action']) => setChoices((cs) => cs.map((c, j) => (j === i ? { ...c, action: on ? action : 'skip' } : c)));

  const visible = newIdx.filter((i) => !only || choices[i].genre === only);
  const total = adding.length + updating.length;

  return (
    <div className="screen list-review">
      <section className="card">
        <p className="lr-range">
          {props.parsed.range ? `${formatDate(props.parsed.range.from)} 〜 ${formatDate(props.parsed.range.to, false)}` : '日付なし'}
        </p>
        <p className="lr-counts">
          <strong>{newIdx.length}</strong>件が新しい記事{fullerIdx.length > 0 && `・${fullerIdx.length}件は内容が増えています`}
          {sameCount > 0 && <span className="muted">・取り込み済み{sameCount}件は重複させません</span>}
        </p>
        <p className="small muted">ジャンルは内容から仮に選んであります。違うものはボタンで直してください。同じ題名の記事はまとめて変わります。</p>
        {props.parsed.warnings.map((w) => (
          <p key={w} className="notice notice-warn small">
            {w}
          </p>
        ))}
      </section>

      {byGenre.length > 1 && (
        <div className="chips chips-scroll" role="group" aria-label="ジャンルで絞り込み">
          <button className={`chip ${only === '' ? 'on' : ''}`} aria-pressed={only === ''} onClick={() => setOnly('')}>
            すべて {adding.length}
          </button>
          {byGenre.map(([g, n]) => (
            <button key={g} className={`chip ${only === g ? 'on' : ''}`} aria-pressed={only === g} onClick={() => setOnly(only === g ? '' : g)}>
              {g} {n}
            </button>
          ))}
        </div>
      )}
      {note && (
        <p className="small lr-note" role="status">
          <IconCheck size={14} /> {note}
        </p>
      )}

      {fullerIdx.length > 0 && !only && (
        <section className="card lr-fuller">
          <h2 className="card-title">取り込み済みで、内容が増えた記事</h2>
          {fullerIdx.map((i) => (
            <label key={i} className="toggle lr-fuller-row">
              <input type="checkbox" checked={choices[i].action === 'update'} onChange={(e) => toggle(i, e.target.checked, 'update')} />
              <span>
                <strong>{posts[i].title}</strong>
                <span className="small muted">
                  {' '}
                  {formatDate(posts[i].date)}・{[props.plan[i].betterBody && '本文が全文に', props.plan[i].morePhotos && `写真が${props.assign[i].length}枚に`].filter(Boolean).join('・')}
                </span>
              </span>
            </label>
          ))}
        </section>
      )}

      {visible.map((i) => {
        const p = posts[i];
        const on = choices[i].action === 'add';
        const imgs = props.assign[i];
        return (
          <article key={i} className={`card post-card ${on ? '' : 'post-off'}`} data-testid="post-card">
            <header className="post-head">
              <span className="post-date">{formatDate(p.date)}</span>
              {p.childName && <span className="entry-child">{p.childName}</span>}
              <button className="icon-btn post-skip" aria-label={on ? 'この記事を取り込まない' : 'この記事を取り込む'} aria-pressed={!on} onClick={() => toggle(i, !on, 'add')}>
                {on ? <IconClose size={18} /> : <IconPlus size={18} />}
              </button>
            </header>
            <h3 className="post-title">{p.title}</h3>
            {p.body && <p className="post-body">{preview(p.body, 90)}</p>}
            <div className="post-meta">
              {p.bodyState === 'truncated' && <span className="badge badge-warn">本文は途中まで</span>}
              {imgs.length > 0 && (
                <span className="post-fact">
                  <IconPhoto size={14} /> {imgs.length}枚
                </span>
              )}
              {p.attachments.map((a) => (
                <span key={a.displayName} className="post-fact">
                  <IconDoc size={14} /> {a.displayName}（{a.displaySize}・あとで追加）
                </span>
              ))}
            </div>
            {on && imgs.length > 0 && <BlobThumbs blobs={imgs.slice(0, 4).map((k) => props.images[k].blob)} total={imgs.length} />}
            {on ? <GenrePicker choices={cands[i]} value={choices[i].genre} onChange={(g) => setGenre(i, g)} /> : <p className="small muted">取り込みません</p>}
          </article>
        );
      })}

      {!newIdx.length && !fullerIdx.length && (
        <div className="empty-hero">
          <IconCheck size={36} />
          <h2>新しい記事はありません</h2>
          <p className="small">このPDFの{sameCount}件は、すべて取り込み済みです。</p>
        </div>
      )}

      <div className="actions sticky-actions">
        <button className="btn" onClick={props.onCancel}>
          やめる
        </button>
        <button className="btn btn-primary" disabled={!total} onClick={() => props.onCommit(choices)}>
          {total ? `${total}件を取り込む${photoCount ? `（写真${photoCount}枚）` : ''}` : '取り込む記事なし'}
        </button>
      </div>
    </div>
  );
}

/** まだ保存していない添付の一覧と、まとめて追加する入口 */
export function MissingView(props: { missing: (MissingRef & { date: string; title: string })[]; onPickMany: () => void; onPickOne: (m: MissingRef) => void; onOpen: (itemId: string) => void }) {
  return (
    <div className="screen">
      <section className="card">
        <h2 className="card-title">
          <IconDoc size={16} /> あとで追加する添付 {props.missing.length}件
        </h2>
        <p className="small muted">
          お知らせ一覧のPDFには、添付ファイルの名前と大きさしか入りません。はいチーズ！ノートで添付を開いて「共有 → "ファイル"に保存」したものを、ここでまとめて選んでください。保存するとファイル名が変わりますが、大きさから元の記事を探して入れます。
        </p>
        <button className="btn btn-primary" onClick={props.onPickMany} disabled={!props.missing.length}>
          <IconUpload size={18} /> 保存したファイルをまとめて選ぶ
        </button>
      </section>
      {props.missing.length === 0 ? (
        <p className="empty">未保存の添付はありません。</p>
      ) : (
        <div className="entries">
          {props.missing.map((m) => (
            <div key={m.attachmentId} className="miss-row">
              <button className="miss-main" onClick={() => props.onOpen(m.itemId)}>
                <span className="miss-name">{m.displayName}</span>
                <span className="small muted">
                  {m.displaySize}・{formatDate(m.date)}・{m.title}
                </span>
              </button>
              <button className="btn btn-small" onClick={() => props.onPickOne(m)}>
                選ぶ
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 容量が同じ添付が複数あって決められないとき、どの記事のものかをボタンで選ぶ */
export function AskMatch(props: { file: File; candidates: (MissingRef & { date?: string; title?: string })[]; exact: boolean; left: number; onChoose: (m: MissingRef | null) => void }) {
  return (
    <Modal title="どの記事の添付ですか？">
      <p className="small muted">
        {props.file.name}（{formatBytes(props.file.size)}）{props.exact ? 'は、大きさが同じ添付が複数あります。' : props.candidates.length ? 'に、大きさの合う添付が見つかりませんでした。入れる場所を選んでください。' : 'を入れる場所（未保存の添付）がありません。'}
        {props.left > 0 && ` あと${props.left}件`}
      </p>
      <div className="btn-col">
        {props.candidates.map((m) => (
          <button key={m.attachmentId} className="btn ask-opt" onClick={() => props.onChoose(m)}>
            <span>{m.displayName}</span>
            <span className="small muted">
              {m.displaySize}
              {m.date && `・${formatDate(m.date)}`}
              {m.title && `・${m.title}`}
            </span>
          </button>
        ))}
        <button className="btn btn-ghost" onClick={() => props.onChoose(null)}>
          {props.candidates.length ? 'どれでもない（入れない）' : '閉じる'}
        </button>
      </div>
    </Modal>
  );
}

/** 記事の詳細に出す：ジャンル・本文の状態・未保存の添付 */
export function PostExtras(props: { item: Item; choices: GenreChoice[]; onGenre: (g: string) => void; onFill: (attachmentId: string) => void; onEditBody: () => void }) {
  const it = props.item;
  const missing = it.attachments.filter((a) => a.state === 'missing');
  const [open, setOpen] = useState(false);
  if (!it.genre && !missing.length && it.bodyState !== 'truncated' && it.source.via !== 'listpdf') {
    return (
      <section className="card post-extras">
        <button className="link-btn" onClick={() => setOpen(true)}>
          <IconPlus size={14} /> ジャンルを付ける
        </button>
        {open && <GenrePicker choices={props.choices} value="" onChange={(g) => (props.onGenre(g), setOpen(false))} max={8} />}
      </section>
    );
  }
  return (
    <section className="card post-extras">
      <div className="pe-row">
        <span className="small muted">ジャンル</span>
        <button className="gchip on" onClick={() => setOpen(!open)} aria-expanded={open}>
          {it.genre || '未設定'} <IconChevron size={14} />
        </button>
      </div>
      {open && <GenrePicker choices={props.choices} value={it.genre ?? ''} onChange={(g) => (props.onGenre(g), setOpen(false))} max={8} />}
      {it.bodyState === 'truncated' && (
        <div className="notice notice-soft">
          <strong>
            <IconAlert size={14} /> 本文は途中までです
          </strong>
          <span>はいチーズ！ノートで「もっとみる」を開いて一覧PDFを取り込み直すと全文に変わります。本文をコピーして貼り付けても構いません。</span>
          <button className="btn btn-small" onClick={props.onEditBody}>
            全文を貼り付ける
          </button>
        </div>
      )}
      {missing.length > 0 && (
        <div className="pe-missing">
          <p className="small muted">あとで追加する添付</p>
          {missing.map((a) => (
            <div key={a.id} className="miss-row">
              <span className="miss-main">
                <span className="miss-name">{a.displayName}</span>
                <span className="small muted">{a.displaySize}・未保存</span>
              </span>
              <button className="btn btn-small" onClick={() => props.onFill(a.id)}>
                ファイルを選ぶ
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
