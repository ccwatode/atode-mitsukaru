import { useMemo, useState } from 'react';
import { CATEGORY_LABELS, KIND_LABELS, type CalEvent, type EntryKind, type EventCategory } from '../core/types.ts';
import { changedSinceExport, eventsOn, eventTimeLabel, formatJpDate, monthGrid, type Candidate, type MatchResult } from '../core/schedule.ts';
import { todayStr } from '../core/textutil.ts';
import { formatDateTime, KindLabel, Modal } from './common.tsx';
import { IconBack, IconCalendar, IconChevron, IconClock, IconEdit, IconExternal, IconPin, IconPlus, IconTrash } from './icons.tsx';

/** 予定の元になる記録（お知らせ・チラシ・メモ・連絡帳） */
export interface SourceRef {
  type: 'item' | 'note';
  id: string;
  kind: EntryKind;
  title: string;
  date: string;
  text: string;
  childName: string;
}

const CATS = Object.keys(CATEGORY_LABELS) as EventCategory[];
const WD = ['日', '月', '火', '水', '木', '金', '土'];

export function CatChip({ c }: { c: EventCategory }) {
  return <span className={`cat cat-${c}`}>{CATEGORY_LABELS[c]}</span>;
}

export function EventRow({ e, onOpen, showDate = true }: { e: CalEvent; onOpen: () => void; showDate?: boolean }) {
  const [, m, d] = e.date.split('-').map(Number);
  const wd = WD[new Date(e.date + 'T00:00:00').getDay()];
  return (
    <button className={`ev-row ${e.status === 'cancelled' ? 'ev-cancelled' : ''}`} onClick={onOpen}>
      {showDate && (
        <span className="entry-day">
          <span className="ev-month">{m}月</span>
          <span className="day-num">{d}</span>
          <span className="day-wd">{wd}</span>
        </span>
      )}
      <span className={`ev-bar cat-bg-${e.category}`} aria-hidden />
      <span className="entry-main">
        <span className="entry-title">
          <span className="entry-title-text ev-title">{e.title}</span>
          {e.status === 'cancelled' && <span className="badge badge-none">中止</span>}
          {e.childName && <span className="entry-child">{e.childName}</span>}
        </span>
        <span className="ev-sub">
          <CatChip c={e.category} />
          <span>{eventTimeLabel(e)}{e.endDate ? `〜${formatJpDate(e.endDate)}` : ''}</span>
          {e.location && <span className="ev-loc">{e.location}</span>}
        </span>
      </span>
      <IconChevron size={18} className="entry-chev" />
    </button>
  );
}

/** ホームに出す「近いうちの予定」 */
export function UpcomingCard({ events, onOpen, onAll }: { events: CalEvent[]; onOpen: (e: CalEvent) => void; onAll: () => void }) {
  if (!events.length) return null;
  return (
    <section className="upcoming">
      <div className="upcoming-head">
        <span className="card-title">
          <IconCalendar size={16} /> 近いうちの予定
        </span>
        <button className="link-btn" onClick={onAll}>
          カレンダー
        </button>
      </div>
      <div className="entries">
        {events.map((e) => (
          <EventRow key={e.id} e={e} onOpen={() => onOpen(e)} />
        ))}
      </div>
    </section>
  );
}

export function CalendarView(props: {
  events: CalEvent[];
  month: { y: number; m: number };
  onMonth: (m: { y: number; m: number }) => void;
  selected: string;
  onSelect: (d: string) => void;
  onOpen: (e: CalEvent) => void;
  onAdd: (date: string) => void;
  onExportMany: (es: CalEvent[]) => void;
}) {
  const { y, m } = props.month;
  const today = todayStr();
  const weeks = useMemo(() => monthGrid(y, m), [y, m]);
  const active = props.events;
  const dayEvents = eventsOn(active, props.selected);
  const upcoming = active.filter((e) => (e.endDate || e.date) >= today && e.status === 'active').sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
  const toExport = upcoming.filter((e) => !e.exportedAt || changedSinceExport(e));
  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    props.onMonth({ y: d.getFullYear(), m: d.getMonth() + 1 });
  };

  return (
    <div className="screen">
      <section className="card cal">
        <div className="cal-head">
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="前の月">
            <IconBack size={20} />
          </button>
          <h2 className="cal-title">
            {y}年<span className="month-num">{m}</span>月
          </h2>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="次の月">
            <IconChevron size={20} />
          </button>
        </div>
        <div className="cal-grid" role="grid" aria-label={`${y}年${m}月`}>
          {WD.map((w, i) => (
            <span key={w} className={`cal-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}`}>
              {w}
            </span>
          ))}
          {weeks.flat().map((d, i) => {
            const es = eventsOn(active, d);
            const inMonth = Number(d.slice(5, 7)) === m;
            return (
              <button
                key={d}
                role="gridcell"
                className={`cal-day ${inMonth ? '' : 'out'} ${d === today ? 'today' : ''} ${d === props.selected ? 'sel' : ''} ${i % 7 === 0 ? 'sun' : i % 7 === 6 ? 'sat' : ''}`}
                onClick={() => props.onSelect(d)}
                aria-label={`${formatJpDate(d)} 予定${es.length}件`}
                aria-selected={d === props.selected}
              >
                <span className="cal-num">{Number(d.slice(8))}</span>
                <span className="cal-dots">
                  {es.slice(0, 3).map((e) => (
                    <i key={e.id} className={`cat-bg-${e.category} ${e.status === 'cancelled' ? 'dot-x' : ''}`} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <button className="link-btn cal-today" onClick={() => (props.onMonth({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }), props.onSelect(today))}>
          今日
        </button>
      </section>

      <section className="month">
        <h2 className="month-head">{formatJpDate(props.selected)}</h2>
        {dayEvents.length ? (
          <div className="entries">
            {dayEvents.map((e) => (
              <EventRow key={e.id} e={e} showDate={false} onOpen={() => props.onOpen(e)} />
            ))}
          </div>
        ) : (
          <p className="small muted ev-none">この日の予定はありません</p>
        )}
        <button className="btn btn-ghost btn-small" onClick={() => props.onAdd(props.selected)}>
          <IconPlus size={18} /> この日に予定を追加
        </button>
      </section>

      <section className="month">
        <h2 className="month-head">これからの予定</h2>
        {upcoming.length ? (
          <div className="entries">
            {upcoming.slice(0, 30).map((e) => (
              <EventRow key={e.id} e={e} onOpen={() => props.onOpen(e)} />
            ))}
          </div>
        ) : active.length ? (
          <p className="small muted ev-none">これから先の予定はありません</p>
        ) : (
          <div className="empty-hero">
            <IconCalendar size={36} />
            <h2>予定はまだありません</h2>
            <p className="small">お知らせやチラシを開いて「予定を取り出す」を押すと、日付や時刻の候補を確認して登録できます。</p>
          </div>
        )}
        {toExport.length > 0 && (
          <button className="btn btn-small" onClick={() => props.onExportMany(toExport)}>
            <IconExternal size={18} /> まだカレンダーに入れていない予定 {toExport.length}件をまとめて追加（.ics）
          </button>
        )}
      </section>
    </div>
  );
}

export function EventDetail(props: {
  e: CalEvent;
  source: SourceRef | null;
  /** 変更のきっかけになった記録の名前 */
  sourceTitle: (id: string) => string | undefined;
  googleUrl: string;
  onOpenSource: () => void;
  onEdit: () => void;
  onToggleCancel: () => void;
  onDelete: () => void;
  onIcs: () => void;
  onGoogle: () => void;
}) {
  const e = props.e;
  const [confirm, setConfirm] = useState(false);
  const changed = changedSinceExport(e);
  return (
    <div className="screen detail">
      <header className="detail-head">
        <CatChip c={e.category} />
        <h1 className={`detail-title ${e.status === 'cancelled' ? 'strike' : ''}`}>{e.title}</h1>
        {e.status === 'cancelled' && <span className="badge badge-none">中止</span>}
      </header>

      <section className="card ev-facts">
        <p>
          <IconCalendar size={18} />
          <span>
            {formatJpDate(e.date)}
            {e.endDate ? ` 〜 ${formatJpDate(e.endDate)}` : ''}
            <span className="muted">（{e.date.slice(0, 4)}年）</span>
          </span>
        </p>
        <p>
          <IconClock size={18} />
          <span>{eventTimeLabel(e)}</span>
        </p>
        {e.location && (
          <p>
            <IconPin size={18} />
            <span>{e.location}</span>
          </p>
        )}
        {e.childName && <p className="small muted">対象：{e.childName}</p>}
        {e.description && <p className="pre ev-desc">{e.description}</p>}
      </section>

      <section className="card">
        <h2 className="card-title">元のお知らせ</h2>
        {props.source ? (
          <button className="src-link" onClick={props.onOpenSource}>
            <KindLabel kind={props.source.kind} />
            <span className="src-title">{props.source.title || KIND_LABELS[props.source.kind]}</span>
            <span className="small muted">{formatJpDate(props.source.date)}</span>
            <IconChevron size={18} className="entry-chev" />
          </button>
        ) : e.source.type === 'manual' ? (
          <p className="small muted">手で追加した予定です。</p>
        ) : (
          <p className="small muted">元の記録はこの端末から削除されています。</p>
        )}
        {e.source.snippet && (
          <blockquote className="src-quote small" title="最初に登録したときの文">
            {e.source.snippet}
          </blockquote>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">カレンダーに追加</h2>
        {changed && <p className="notice notice-warn small">カレンダーに入れた後に内容が変わっています。もう一度追加し、古い予定はカレンダー側で削除してください。</p>}
        <div className="btn-col">
          <button className="btn btn-primary" onClick={props.onIcs}>
            <IconCalendar size={18} /> iPhoneのカレンダーに追加
          </button>
          <a className="btn" href={props.googleUrl} target="_blank" rel="noopener noreferrer" onClick={props.onGoogle}>
            <IconExternal size={18} /> Googleカレンダーで開く
          </a>
        </div>
        <p className="small muted ev-help">
          iPhoneの「カレンダー」にGoogleアカウントを追加していれば、上のボタンで保存先にGoogleのカレンダーも選べます。「Googleカレンダーで開く」は予定の名前・日時・場所・説明をGoogleに送って作成画面を開きます。チラシのファイル自体はカレンダーに添付されません（原本はこのアプリで開けます）。
        </p>
        {e.exportedAt && <p className="small muted">最後に追加：{formatDateTime(e.exportedAt)}</p>}
      </section>

      <div className="actions">
        <button className="btn" onClick={props.onEdit}>
          <IconEdit size={18} /> 編集
        </button>
        <button className="btn" onClick={props.onToggleCancel}>
          {e.status === 'cancelled' ? '中止を取り消す' : '中止にする'}
        </button>
        <button className="btn btn-danger-ghost" onClick={() => setConfirm(true)}>
          <IconTrash size={18} /> 削除
        </button>
      </div>

      {e.history.length > 0 && (
        <section className="card meta">
          <h2 className="card-title">変更の記録</h2>
          <ul className="plain small">
            {[...e.history].reverse().map((h, i) => (
              <li key={i}>
                <span className="muted">{formatDateTime(h.at)}</span> {h.changes.join('／')}
                {h.sourceId && props.sourceTitle(h.sourceId) && <span className="muted">（{props.sourceTitle(h.sourceId)}より）</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirm && (
        <Modal title="この予定を削除しますか？" onClose={() => setConfirm(false)}>
          <p>「{e.title}」をこのアプリから削除します。iPhoneやGoogleのカレンダーに追加済みの予定は、そちらで削除してください。元のお知らせは消えません。</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm(false)}>
              やめる
            </button>
            <button className="btn btn-danger" onClick={props.onDelete}>
              削除する
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ChildSelect({ value, children, onChange }: { value: string; children: string[]; onChange: (v: string) => void }) {
  const [other, setOther] = useState(!!value && !children.includes(value));
  return other ? (
    <input value={value} placeholder="名前" onChange={(e) => onChange(e.target.value)} />
  ) : (
    <select value={value} onChange={(e) => (e.target.value === '__other' ? setOther(true) : onChange(e.target.value))}>
      <option value="">家族全体・指定なし</option>
      {children.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option value="__other">ほかの名前を入力…</option>
    </select>
  );
}

export function EventForm(props: { event: CalEvent; isNew: boolean; children: string[]; onSave: (e: CalEvent) => void; onCancel: () => void }) {
  const [e, setE] = useState(props.event);
  const [multi, setMulti] = useState(!!props.event.endDate);
  const [allDay, setAllDay] = useState(!props.event.start);
  const set = (p: Partial<CalEvent>) => setE((x) => ({ ...x, ...p }));
  const problems: string[] = [];
  if (!e.title.trim()) problems.push('名前を入れてください');
  if (!e.date) problems.push('日付を入れてください');
  if (multi && e.endDate && e.endDate < e.date) problems.push('終了日が開始日より前です');
  if (!allDay && !e.start) problems.push('開始時刻を入れるか「終日」にしてください');
  if (!allDay && e.start && e.end && e.end <= e.start) problems.push('終了時刻が開始時刻より前です');
  const save = () => {
    if (problems.length) return;
    props.onSave({ ...e, title: e.title.trim(), endDate: multi ? e.endDate : '', start: allDay ? '' : e.start, end: allDay ? '' : e.end });
  };
  return (
    <div className="screen form">
      <label className="field">
        <span>予定の名前</span>
        <input value={e.title} placeholder="例：運動会" onChange={(x) => set({ title: x.target.value })} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{multi ? '開始日' : '日付'}</span>
          <input type="date" value={e.date} onChange={(x) => set({ date: x.target.value })} />
        </label>
        {multi && (
          <label className="field">
            <span>終了日</span>
            <input type="date" value={e.endDate} min={e.date} onChange={(x) => set({ endDate: x.target.value })} />
          </label>
        )}
      </div>
      <div className="chips">
        <label className="toggle">
          <input type="checkbox" checked={allDay} onChange={(x) => setAllDay(x.target.checked)} /> 終日
        </label>
        <label className="toggle">
          <input type="checkbox" checked={multi} onChange={(x) => setMulti(x.target.checked)} /> 複数日
        </label>
      </div>
      {!allDay && (
        <div className="field-row">
          <label className="field">
            <span>開始</span>
            <input type="time" value={e.start} onChange={(x) => set({ start: x.target.value })} />
          </label>
          <label className="field">
            <span>終了（任意）</span>
            <input type="time" value={e.end} onChange={(x) => set({ end: x.target.value })} />
          </label>
        </div>
      )}
      <label className="field">
        <span>場所（任意）</span>
        <input value={e.location} onChange={(x) => set({ location: x.target.value })} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>種類</span>
          <select value={e.category} onChange={(x) => set({ category: x.target.value as EventCategory })}>
            {CATS.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>子ども</span>
          <ChildSelect value={e.childName} children={props.children} onChange={(v) => set({ childName: v })} />
        </label>
      </div>
      <label className="field">
        <span>メモ（持ち物など・任意）</span>
        <textarea rows={3} value={e.description} onChange={(x) => set({ description: x.target.value })} />
      </label>
      {problems.length > 0 && <p className="small muted">{problems[0]}</p>}
      <div className="actions sticky-actions">
        <button className="btn" onClick={props.onCancel}>
          やめる
        </button>
        <button className="btn btn-primary" onClick={save} disabled={problems.length > 0}>
          {props.isNew ? '登録' : '保存'}
        </button>
      </div>
    </div>
  );
}

/* ---------- 候補の確認 ---------- */

export type RowAction = 'add' | 'update' | 'cancel' | 'skip';
export interface ReviewRow {
  key: string;
  c: Candidate;
  match: MatchResult;
  action: RowAction;
}

export function initialAction(c: Candidate, m: MatchResult): RowAction {
  if (m.status === 'same') return 'skip';
  if (m.status === 'changed') return 'update';
  if (m.status === 'cancel') return 'cancel';
  return c.dateCertain && c.date ? 'add' : 'skip';
}

export function ReviewView(props: {
  source: SourceRef;
  rows: ReviewRow[];
  children: string[];
  onRegister: (rows: ReviewRow[], child: string) => void;
  onManual: () => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState(props.rows);
  const [child, setChild] = useState(props.source.childName);
  const upd = (key: string, f: (r: ReviewRow) => ReviewRow) => setRows((rs) => rs.map((r) => (r.key === key ? f(r) : r)));
  const setC = (key: string, p: Partial<Candidate>) => upd(key, (r) => ({ ...r, c: { ...r.c, ...p } }));
  const chosen = rows.filter((r) => r.action !== 'skip');
  const missingDate = chosen.filter((r) => r.action !== 'cancel' && !r.c.date);

  return (
    <div className="screen">
      <section className="card">
        <p className="small muted">元の記録</p>
        <p>
          <KindLabel kind={props.source.kind} /> <strong>{props.source.title || KIND_LABELS[props.source.kind]}</strong>
        </p>
        <p className="small muted">文章の中の日付から予定の候補を作りました。内容を確かめ、必要なら直してから登録してください。はっきりしない日付は選択していません。</p>
      </section>

      {rows.length === 0 && (
        <div className="notice notice-soft">
          <strong>予定の候補が見つかりませんでした</strong>
          <span>日付が「11月5日」「11/5」のように書かれていないか、画像の中にだけ書かれている可能性があります。チラシの画像なら、写真アプリで文字を長押しして「すべてを選択」→コピーし、記録の「画像の中の文字」に貼り付けると取り出せます。</span>
        </div>
      )}

      {rows.map((r) => (
        <section key={r.key} className={`card cand ${r.action === 'skip' ? 'cand-off' : ''}`}>
          <div className="cand-head">
            {r.match.status === 'new' ? (
              <label className="toggle cand-check">
                <input type="checkbox" checked={r.action === 'add'} onChange={(e) => upd(r.key, (x) => ({ ...x, action: e.target.checked ? 'add' : 'skip' }))} />
                <span>登録する</span>
              </label>
            ) : (
              <span className={`badge ${r.match.status === 'same' ? 'badge-ok' : 'badge-warn'}`}>
                {r.match.status === 'same' ? '登録済み' : r.match.status === 'changed' ? '登録済みの予定と違いがあります' : '登録済みの予定の中止'}
              </span>
            )}
            <CatChip c={r.c.category} />
          </div>

          {r.match.status === 'same' ? (
            <p className="small">
              「{r.match.event.title}」{formatJpDate(r.match.event.date)} として登録済みです。重複して登録しません。
            </p>
          ) : (
            <>
              {r.match.status === 'changed' && (
                <div className="cand-diff">
                  <p className="small">「{r.match.event.title}」（登録済み）との違い</p>
                  <ul className="plain small">
                    {r.match.diffs.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {r.match.status === 'cancel' && (
                <p className="small">
                  「{r.match.event.title}」{formatJpDate(r.match.event.date)}（登録済み）が中止と書かれています。
                </p>
              )}
              {r.match.status !== 'new' && (
                <div className="seg cand-seg" role="radiogroup">
                  {(r.match.status === 'changed' ? (['update', 'add', 'skip'] as RowAction[]) : (['cancel', 'skip'] as RowAction[])).map((a) => (
                    <button key={a} role="radio" aria-checked={r.action === a} className={`seg-btn ${r.action === a ? 'on' : ''}`} onClick={() => upd(r.key, (x) => ({ ...x, action: a }))}>
                      {a === 'update' ? '登録済みを更新' : a === 'add' ? '別の予定として追加' : a === 'cancel' ? '中止にする' : '何もしない'}
                    </button>
                  ))}
                </div>
              )}
              {r.action !== 'cancel' && (
                <div className="cand-fields">
                  <label className="field">
                    <span>名前</span>
                    <input value={r.action === 'update' && r.match.status === 'changed' ? r.match.event.title : r.c.title} onChange={(e) => setC(r.key, { title: e.target.value })} disabled={r.action === 'update'} />
                  </label>
                  <div className="field-row">
                    <label className="field">
                      <span>日付</span>
                      <input type="date" value={r.c.date} onChange={(e) => setC(r.key, { date: e.target.value, dateCertain: true })} />
                    </label>
                    <label className="field">
                      <span>開始</span>
                      <input type="time" value={r.c.start} onChange={(e) => setC(r.key, { start: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>終了</span>
                      <input type="time" value={r.c.end} onChange={(e) => setC(r.key, { end: e.target.value })} />
                    </label>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>場所</span>
                      <input value={r.c.location} onChange={(e) => setC(r.key, { location: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>種類</span>
                      <select value={r.c.category} onChange={(e) => setC(r.key, { category: e.target.value as EventCategory })}>
                        {CATS.map((c) => (
                          <option key={c} value={c}>
                            {CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              )}
              {r.c.notes.length > 0 && (
                <ul className="cand-notes small">
                  {r.c.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          <blockquote className="src-quote small">{r.c.snippet}</blockquote>
        </section>
      ))}

      <button className="btn btn-ghost btn-small" onClick={props.onManual}>
        <IconPlus size={18} /> 手で予定を追加
      </button>

      {rows.some((r) => r.match.status !== 'same') && (
        <label className="field">
          <span>対象の子ども（新しく登録する予定）</span>
          <ChildSelect value={child} children={props.children} onChange={setChild} />
        </label>
      )}
      {missingDate.length > 0 && <p className="notice notice-warn small">日付が入っていない候補があります。日付を入れるか、選択を外してください。</p>}
      <div className="actions sticky-actions">
        <button className="btn" onClick={props.onCancel}>
          やめる
        </button>
        <button className="btn btn-primary" disabled={!chosen.length || missingDate.length > 0} onClick={() => props.onRegister(rows, child)}>
          {chosen.length ? `${chosen.length}件を反映` : '選択なし'}
        </button>
      </div>
    </div>
  );
}

/** 記録の詳細の下に出す「この記録からの予定」 */
export function SourceEvents(props: { linked: CalEvent[]; pendingCount: number; onExtract: () => void; onOpen: (e: CalEvent) => void }) {
  return (
    <section className="card src-events">
      <h2 className="card-title">
        <IconCalendar size={16} /> 予定
      </h2>
      {props.linked.length > 0 && (
        <div className="entries">
          {props.linked.map((e) => (
            <EventRow key={e.id} e={e} onOpen={() => props.onOpen(e)} />
          ))}
        </div>
      )}
      <button className={`btn ${props.pendingCount ? 'btn-primary' : 'btn-ghost'} btn-small`} onClick={props.onExtract}>
        {props.pendingCount ? `予定の候補 ${props.pendingCount}件を確認する` : props.linked.length ? '予定を取り出し直す・追加する' : '予定を取り出す'}
      </button>
    </section>
  );
}
