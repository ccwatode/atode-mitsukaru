import { useEffect, useState, type ReactNode } from 'react';
import { KIND_LABELS, type AttachmentRef, type EntryKind, type FetchStatus, type ReviewStatus } from '../core/types.ts';
import { getBlob } from '../db.ts';
import { bestVariant } from '../media.ts';
import { IconAlert, IconBook, IconCheck, IconDoc, IconDots, IconMegaphone, IconNote, IconPhoto } from './icons.tsx';

const WD = ['日', '月', '火', '水', '木', '金', '土'];

const parts = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? { y: +m[1], m: +m[2], d: +m[3], wd: WD[new Date(+m[1], +m[2] - 1, +m[3]).getDay()] } : null;
};

export function formatDate(d: string, withYear = true): string {
  const p = parts(d);
  if (!p) return d;
  return `${withYear ? `${p.y}年` : ''}${p.m}月${p.d}日（${p.wd}）`;
}

export function dayParts(d: string): { day: string; wd: string; month: string } {
  const p = parts(d);
  return p ? { day: String(p.d), wd: p.wd, month: `${p.y}年${p.m}月` } : { day: d, wd: '', month: '' };
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(+d)) return iso;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatBytes(n?: number): string {
  if (n == null) return '不明';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function daysSince(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 864e5);
}

const STATUS_META: Record<FetchStatus, { cls: string; icon: ReactNode; text: string }> = {
  取得済み: { cls: 'ok', icon: <IconCheck size={14} />, text: '取得済み' },
  要確認: { cls: 'warn', icon: <IconAlert size={14} />, text: '要確認' },
  未取得: { cls: 'none', icon: <IconDots size={14} />, text: '本文未取得' },
};

export function StatusBadge({ s }: { s: FetchStatus }) {
  const m = STATUS_META[s];
  return (
    <span className={`badge badge-${m.cls}`}>
      {m.icon}
      {m.text}
    </span>
  );
}

export function ReviewBadge({ s }: { s: ReviewStatus }) {
  if (s === '未確認') return null;
  return <span className="badge badge-review">{s}</span>;
}

export function KindIcon({ kind, size = 18 }: { kind: EntryKind; size?: number }) {
  const I = kind === 'note' ? IconBook : kind === 'notice' ? IconMegaphone : kind === 'flyer' ? IconDoc : kind === 'photo' ? IconPhoto : IconNote;
  return (
    <span className={`kind-icon kind-${kind}`} aria-hidden>
      <I size={size} />
    </span>
  );
}

export function KindLabel({ kind }: { kind: EntryKind }) {
  return (
    <span className={`kind-label kind-${kind}`}>
      <KindIcon kind={kind} size={14} />
      {KIND_LABELS[kind]}
    </span>
  );
}

/** ジャンルの札。色は名前から決める（同じ名前はいつも同じ色） */
export function GenreTag({ name }: { name: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 997;
  return (
    <span className="genre-tag" style={{ ['--g' as string]: `var(--g${h % 6})` }}>
      {name}
    </span>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Highlight({ before, match, after }: { before: string; match: string; after: string }) {
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

export function preview(text: string, n = 64): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ---------- 添付画像の表示 ---------- */

const thumbCache = new Map<string, string>();

/** 保存済みの添付をURLにして表示する。サムネイルはキャッシュ、大きな画像は使い終わったら解放 */
export function useBlobUrl(key: string | null, cache = false): string | null {
  const [url, setUrl] = useState<string | null>(key && cache ? thumbCache.get(key) ?? null : null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    if (cache && thumbCache.has(key)) {
      setUrl(thumbCache.get(key)!);
      return;
    }
    let made: string | null = null;
    let alive = true;
    void getBlob(key).then((row) => {
      if (!alive || !row) return;
      made = URL.createObjectURL(row.blob);
      if (cache) thumbCache.set(key, made);
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made && !cache) URL.revokeObjectURL(made);
    };
  }, [key, cache]);
  return url;
}

export function Thumb({ att, className, onClick }: { att: AttachmentRef; className?: string; onClick?: () => void }) {
  const key = bestVariant(att, 'thumb');
  const url = useBlobUrl(key, true);
  const isPdf = att.mime === 'application/pdf';
  const inner = url ? (
    <img src={url} alt={att.name} loading="lazy" />
  ) : (
    <span className="thumb-file">
      <IconDoc size={22} />
      <span>{isPdf ? 'PDF' : 'ファイル'}</span>
    </span>
  );
  return onClick ? (
    <button className={`thumb ${className ?? ''}`} onClick={onClick} aria-label={`${att.name}を開く`}>
      {inner}
      {isPdf && url && <span className="thumb-tag">PDF</span>}
    </button>
  ) : (
    <span className={`thumb ${className ?? ''}`}>{inner}</span>
  );
}
