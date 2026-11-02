import { useEffect, useState } from 'react';
import { EDITABLE_FIELDS, FIELD_LABELS, type EditableField, type FetchStatus, type NoteRecord } from '../core/types.ts';
import type { PendingUpdate } from '../core/merge.ts';
import { formatDate, formatDateTime, KindLabel, ReviewBadge, StatusBadge } from './common.tsx';

/* ================= 詳細 ================= */

function Block({ label, text, className }: { label: string; text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={`block ${className ?? ''}`}>
      <h3 className="block-label">{label}</h3>
      <p className="pre">{text}</p>
    </div>
  );
}

function LifeTable({ rows }: { rows: [string, string][] }) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <dl className="life">
      {shown.map(([k, v]) => (
        <div key={k} className="life-row">
          <dt>{k}</dt>
          <dd className="pre">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Detail(props: {
  record: NoteRecord;
  newerId?: string;
  olderId?: string;
  onOpen: (id: string) => void;
  onSave: (r: NoteRecord) => Promise<void>;
}) {
  const r = props.record;
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [r.id]);
  if (editing) return <EditForm record={r} onCancel={() => setEditing(false)} onSave={async (n) => { await props.onSave(n); setEditing(false); }} />;
  const markChecked = () => props.onSave({ ...r, reviewStatus: '確認済み', updatedAt: new Date().toISOString() });
  return (
    <div className="screen detail">
      <header className="detail-head">
        <KindLabel kind="note" />
        <h1 className="detail-date">{formatDate(r.date)}</h1>
        <div className="badges">
          <StatusBadge s={r.fetchStatus} />
          <ReviewBadge s={r.reviewStatus} />
        </div>
        {r.childName && <p className="muted">{r.childName}</p>}
        {r.fetchStatus !== '取得済み' && <p className={`notice ${r.fetchStatus === '要確認' ? 'notice-warn' : 'notice-none'}`}>{r.statusReason}</p>}
      </header>

      {r.fetchStatus === '未取得' && (
        <section className="card">
          <p>この日の本文はPDFに含まれていません。</p>
          <p className="small muted">取り込むには：連絡帳アプリでこの日の「さらに表示」を開いてからPDFに保存し、「追加 → 連絡帳PDF」から選びます。同じ日付は自動でまとめられ、重複しません。</p>
        </section>
      )}

      {(r.classNote || r.personalComment) && (
        <section className="card">
          <h2 className="card-title">先生からの連絡</h2>
          {(r.schoolName || r.teacher) && (
            <p className="muted small">
              {r.schoolName} {r.teacher}
            </p>
          )}
          <p className="pre body-text">{r.classNote}</p>
          <Block label="個別コメント" text={r.personalComment} className="personal" />
          {r.personalComment && !r.editedFields.includes('personalComment') && (
            <p className="small muted hint">「先生からの連絡」と「個別コメント」は段落の区切りから自動で分けています。違っていたら「修正する」で直せます。</p>
          )}
        </section>
      )}

      {(r.attendance || r.sleep || r.toilet || r.meal || r.otherLife) && (
        <section className="card">
          <h2 className="card-title">生活記録（園）</h2>
          <LifeTable
            rows={[
              ['登降園', r.attendance],
              ['睡眠', r.sleep],
              ['排泄', r.toilet],
              ['食事', r.meal],
              ['その他', r.otherLife],
            ]}
          />
        </section>
      )}

      {(r.homeMessage || r.homeRecord) && (
        <section className="card card-home">
          <h2 className="card-title">家庭からの連絡</h2>
          {r.homeMessage && <p className="pre body-text">{r.homeMessage}</p>}
          {r.homeRecord && <LifeTable rows={r.homeRecord.split('\n').reduce<[string, string][]>((acc, line) => {
            const m = /^(\S+)\s+(.*)$/.exec(line);
            if (m && ['検温', '睡眠', '排泄', '夕食', '朝食', '昼食', '食事', 'おやつ'].includes(m[1])) acc.push([m[1], m[2]]);
            else if (acc.length) acc[acc.length - 1] = [acc[acc.length - 1][0], acc[acc.length - 1][1] + '\n' + line];
            else acc.push(['', line]);
            return acc;
          }, [])} />}
        </section>
      )}

      <div className="actions">
        <button className="btn" onClick={() => setEditing(true)}>
          修正する
        </button>
        {r.reviewStatus === '未確認' && r.fetchStatus !== '未取得' && (
          <button className="btn" onClick={markChecked}>
            内容を確認した
          </button>
        )}
      </div>

      <details className="card raw">
        <summary>元の抽出テキスト（PDFから取り出したまま）</summary>
        <pre className="raw-text">{r.rawText}</pre>
      </details>

      <section className="card meta">
        <h2 className="card-title">取り込み元</h2>
        <ul className="plain small">
          {r.sources.map((s) => (
            <li key={s.fileHash + s.importedAt}>
              {s.fileName}（{formatDateTime(s.importedAt)}）
            </li>
          ))}
        </ul>
        {r.editedFields.length > 0 && <p className="small muted">修正した項目：{r.editedFields.map((f) => FIELD_LABELS[f] ?? f).join('、')}</p>}
      </section>

      <nav className="pager">
        <button className="btn" disabled={!props.newerId} onClick={() => props.newerId && props.onOpen(props.newerId)}>
          新しい日
        </button>
        <button className="btn" disabled={!props.olderId} onClick={() => props.olderId && props.onOpen(props.olderId)}>
          古い日
        </button>
      </nav>
    </div>
  );
}

function EditForm({ record, onSave, onCancel }: { record: NoteRecord; onSave: (r: NoteRecord) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<NoteRecord>(record);
  const [saving, setSaving] = useState(false);
  const order: EditableField[] = ['classNote', 'personalComment', 'attendance', 'sleep', 'toilet', 'meal', 'otherLife', 'homeMessage', 'homeRecord', 'teacher', 'schoolName', 'childName'];
  const save = async () => {
    const changed = EDITABLE_FIELDS.filter((f) => draft[f] !== record[f]) as string[];
    if (draft.fetchStatus !== record.fetchStatus) changed.push('fetchStatus');
    if (!changed.length) return onCancel();
    setSaving(true);
    await onSave({
      ...draft,
      reviewStatus: '修正済み',
      editedFields: [...new Set([...record.editedFields, ...changed])],
      updatedAt: new Date().toISOString(),
    });
  };
  return (
    <div className="screen">
      <h1 className="detail-date">{formatDate(record.date)} を修正</h1>
      <p className="muted small">元の抽出テキストは変更されません。修正した記録には「修正済み」と表示されます。</p>
      <label className="field">
        <span>取得状態</span>
        <select value={draft.fetchStatus} onChange={(e) => setDraft({ ...draft, fetchStatus: e.target.value as FetchStatus })}>
          <option>取得済み</option>
          <option>要確認</option>
          <option value="未取得">未取得</option>
        </select>
      </label>
      {order.map((f) => {
        const multi = !['teacher', 'schoolName', 'childName'].includes(f);
        return (
          <label key={f} className="field">
            <span>{FIELD_LABELS[f]}</span>
            {multi ? (
              <textarea rows={Math.min(10, Math.max(2, Math.ceil((draft[f].length || 1) / 20) + draft[f].split('\n').length))} value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
            ) : (
              <input value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
            )}
          </label>
        );
      })}
      <div className="actions sticky-actions">
        <button className="btn" onClick={onCancel} disabled={saving}>
          やめる
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          保存
        </button>
      </div>
    </div>
  );
}

/* ================= 更新の確認 ================= */

export function PendingView(props: { pending: PendingUpdate[]; current: Map<string, NoteRecord>; onApprove: (ids: string[]) => void; onReject: (id: string) => void }) {
  const list = [...props.pending].sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return <div className="screen"><p className="empty">確認待ちの更新はありません。</p></div>;
  return (
    <div className="screen">
      <p className="muted">同じ日付の記録が、新しく取り込んだデータと異なります。違いを確認して、反映するか選んでください。反映するまで今の記録は変わりません。</p>
      {list.length > 1 && (
        <button className="btn btn-primary btn-block" onClick={() => props.onApprove(list.map((p) => p.id))}>
          {list.length}件すべて反映する
        </button>
      )}
      {list.map((p) => {
        const cur = props.current.get(p.id);
        return (
          <section key={p.id} className="card">
            <h2 className="card-title">
              {formatDate(p.date)} {cur && <StatusBadge s={cur.fetchStatus} />} → <StatusBadge s={p.incoming.fetchStatus} />
            </h2>
            {p.incomingHasMore && <p className="small">新しいデータのほうが文章が多く含まれています。</p>}
            {p.currentEdited && <p className="notice notice-warn">この記録は手で修正しています。反映すると修正内容は新しいデータで置き換わります。</p>}
            {p.diffs
              .filter((d) => d.field !== 'rawText' && d.field !== 'fetchStatus')
              .map((d) => (
                <div key={d.field} className="diff">
                  <h3 className="block-label">{d.label}</h3>
                  <div className="diff-before">
                    <span className="diff-tag">今</span>
                    <span className="pre">{d.before || '（空欄）'}</span>
                  </div>
                  <div className="diff-after">
                    <span className="diff-tag">新</span>
                    <span className="pre">{d.after || '（空欄）'}</span>
                  </div>
                </div>
              ))}
            <p className="small muted">取り込み元：{p.incoming.sources.map((s) => s.fileName).join('、')}</p>
            <div className="actions">
              <button className="btn" onClick={() => props.onReject(p.id)}>
                反映しない
              </button>
              <button className="btn btn-primary" onClick={() => props.onApprove([p.id])}>
                反映する
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

