import { useEffect, useMemo, useState } from 'react';
import { KIND_LABELS, type AttachmentRef, type Item } from '../core/types.ts';
import { bestVariant } from '../media.ts';
import { getBlob } from '../db.ts';
import { formatBytes, formatDate, formatDateTime, KindLabel, Modal, Thumb, useBlobUrl } from './common.tsx';
import { IconBack, IconChevron, IconClose, IconEdit, IconTrash } from './icons.tsx';

export function ItemDetail(props: { item: Item; onEdit: () => void; onDelete: () => Promise<void>; onEvent: (ev: string) => void; onView: (atts: AttachmentRef[], index: number) => void }) {
  const it = props.item;
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="screen detail">
      <header className="detail-head">
        <KindLabel kind={it.kind} />
        <h1 className="detail-title">{it.title || KIND_LABELS[it.kind]}</h1>
        <p className="muted">
          {formatDate(it.date)}
          {it.childName && `・${it.childName}`}
        </p>
        {it.event && (
          <button className="chip chip-event" onClick={() => props.onEvent(it.event)}>
            行事：{it.event}
            <IconChevron size={14} />
          </button>
        )}
      </header>

      {it.attachments.length > 0 && (
        <section className={`gallery ${it.attachments.length === 1 ? 'gallery-one' : ''}`}>
          {it.attachments.map((a, i) => (
            <Thumb key={a.id} att={a} className={it.attachments.length === 1 ? 'thumb-l' : ''} onClick={() => props.onView(it.attachments, i)} />
          ))}
        </section>
      )}

      {it.body && (
        <section className="card">
          <p className="pre body-text">{it.body}</p>
        </section>
      )}

      {it.searchText && (
        <details className="card fold">
          <summary>画像の中の文字</summary>
          <p className="pre small">{it.searchText}</p>
        </details>
      )}

      <div className="actions">
        <button className="btn" onClick={props.onEdit}>
          <IconEdit size={18} /> 編集
        </button>
        <button className="btn btn-danger-ghost" onClick={() => setConfirm(true)}>
          <IconTrash size={18} /> 削除
        </button>
      </div>

      <section className="card meta">
        <ul className="plain small muted">
          <li>追加：{formatDateTime(it.createdAt)}</li>
          {it.attachments.length > 0 && <li>添付：{it.attachments.length}件（元の容量 {formatBytes(it.attachments.reduce((s, a) => s + a.size, 0))}）</li>}
        </ul>
      </section>

      {confirm && (
        <Modal title="この記録を削除しますか？" onClose={() => setConfirm(false)}>
          <p>「{it.title || KIND_LABELS[it.kind]}」と添付{it.attachments.length}件をこの端末から削除します。元に戻せません。</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm(false)}>
              やめる
            </button>
            <button className="btn btn-danger" onClick={() => void props.onDelete()}>
              削除する
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 全画面の画像ビューア。ピンチで拡大（ページ自体の拡大）、左右ボタンで前後へ */
export function Viewer(props: { atts: AttachmentRef[]; index: number; onClose: () => void; onOpenItem?: () => void }) {
  const [i, setI] = useState(props.index);
  const a = props.atts[i];
  const isImage = a.mime.startsWith('image/') || a.variants.includes('view');
  const key = isImage ? bestVariant(a, 'view') : null;
  const url = useBlobUrl(key);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  useEffect(() => {
    if (isImage) return;
    let u: string | null = null;
    void getBlob(`${a.id}:orig`).then((row) => {
      if (row) {
        u = URL.createObjectURL(row.blob);
        setPdfUrl(u);
      }
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
      setPdfUrl(null);
    };
  }, [a.id, isImage]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(props.atts.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props]);
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="画像を表示">
      <div className="viewer-bar">
        <button className="icon-btn" onClick={props.onClose} aria-label="閉じる">
          <IconClose />
        </button>
        <span className="viewer-count">
          {i + 1} / {props.atts.length}
        </span>
        {props.onOpenItem ? (
          <button className="viewer-link" onClick={props.onOpenItem}>
            記録を開く
          </button>
        ) : (
          <span />
        )}
      </div>
      <div className="viewer-stage">
        {isImage ? (
          url ? <img src={url} alt={a.name} /> : <p className="muted">読み込み中…</p>
        ) : (
          <div className="viewer-file">
            <Thumb att={a} className="thumb-l" />
            <p>{a.name}</p>
            {pdfUrl && (
              <a className="btn btn-primary" href={pdfUrl} target="_blank" rel="noopener">
                PDFを開く
              </a>
            )}
          </div>
        )}
      </div>
      {props.atts.length > 1 && (
        <div className="viewer-nav">
          <button className="icon-btn" disabled={i === 0} onClick={() => setI(i - 1)} aria-label="前へ">
            <IconBack />
          </button>
          <button className="icon-btn" disabled={i === props.atts.length - 1} onClick={() => setI(i + 1)} aria-label="次へ">
            <IconChevron />
          </button>
        </div>
      )}
    </div>
  );
}

/** 写真・チラシの一覧（月ごとのグリッド） */
export function Photos(props: { items: Item[]; onView: (atts: AttachmentRef[], index: number, item: Item) => void; onAdd: () => void }) {
  const [kind, setKind] = useState<'photo' | 'flyer'>('photo');
  const groups = useMemo(() => {
    const m = new Map<string, { item: Item; att: AttachmentRef; index: number }[]>();
    for (const it of props.items) {
      if (it.kind !== kind) continue;
      it.attachments.forEach((att, index) => {
        const key = it.date.slice(0, 7);
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push({ item: it, att, index });
      });
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [props.items, kind]);
  return (
    <div className="screen">
      <div className="seg" role="radiogroup" aria-label="表示する種類">
        {(['photo', 'flyer'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} className={`seg-btn ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
            {k === 'photo' ? '写真' : 'チラシ・資料'}
          </button>
        ))}
      </div>
      {!groups.length && (
        <div className="empty-hero">
          <p>{kind === 'photo' ? '写真' : 'チラシ'}はまだありません。</p>
          <button className="btn btn-primary" onClick={props.onAdd}>
            追加する
          </button>
        </div>
      )}
      {groups.map(([month, cells]) => (
        <section key={month} className="month">
          <h2 className="month-head">
            {+month.slice(0, 4)}年<span className="month-num">{+month.slice(5)}</span>月 <span className="muted small">{cells.length}枚</span>
          </h2>
          <div className="photo-grid">
            {cells.map((c) => (
              <Thumb key={c.att.id} att={c.att} onClick={() => props.onView(c.item.attachments, c.index, c.item)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
