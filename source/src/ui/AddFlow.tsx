import { useEffect, useRef, useState } from 'react';
import { KIND_LABELS, type AttachmentRef, type Item, type ItemKind } from '../core/types.ts';
import { findDateInText, titleFromText } from '../core/textutil.ts';
import type { ProcessedFile } from '../media.ts';
import { readClipboard } from '../save.ts';
import { formatBytes, KindIcon, Modal, Thumb } from './common.tsx';
import { IconBook, IconClipboard, IconClose, IconDoc, IconMegaphone, IconNote, IconPhoto, IconPlus } from './icons.tsx';

export type AddChoice = 'listPdf' | 'notePdf' | 'paste' | 'flyer' | 'photo' | 'memo';

export function AddSheet({ onChoose, onClose, coverage }: { onChoose: (c: AddChoice) => void; onClose: () => void; coverage?: string }) {
  const opts: { c: AddChoice; icon: JSX.Element; title: string; sub: string }[] = [
    { c: 'listPdf', icon: <IconMegaphone />, title: 'お知らせ一覧のPDF', sub: coverage ? `まとめて取り込み。${coverage}` : 'Safariで保存した一覧をまとめて取り込み' },
    { c: 'photo', icon: <IconPhoto />, title: '写真', sub: '写真ライブラリから複数まとめて' },
    { c: 'flyer', icon: <IconDoc />, title: 'チラシ・配布資料', sub: 'スクリーンショット・写真・PDF' },
    { c: 'paste', icon: <IconClipboard />, title: 'お知らせの文章', sub: 'コピーした文章を貼り付け' },
    { c: 'notePdf', icon: <IconBook />, title: '連絡帳PDF', sub: '複数のPDFもまとめて選べます' },
    { c: 'memo', icon: <IconNote />, title: 'メモ', sub: '持ち物・予定などを自分で書く' },
  ];
  return (
    <Modal title="何を追加しますか？" onClose={onClose}>
      <div className="add-grid">
        {opts.map((o) => (
          <button key={o.c} className={`add-opt add-${o.c}`} onClick={() => onChoose(o.c)}>
            <span className="add-icon">{o.icon}</span>
            <span className="add-text">
              <span className="add-title">{o.title}</span>
              <span className="add-sub">{o.sub}</span>
            </span>
          </button>
        ))}
      </div>
      <details className="fold add-help">
        <summary>お知らせ一覧のPDFの作り方</summary>
        <ol className="small">
          <li>Safariで、はいチーズ！ノートの「お知らせ」を開く</li>
          <li>取り込みたい日付まで、下へスクロールして読み込む（全文がほしい記事は「もっとみる」を開いておく）</li>
          <li>共有ボタン →「オプション」→「PDF」を選んで戻る</li>
          <li>「"ファイル"に保存」→ このアプリで「お知らせ一覧のPDF」から選ぶ</li>
        </ol>
        <p className="small muted">取り込み済みの記事は重複しません。添付のPDFは、あとから追加できます。</p>
      </details>
      <button className="btn btn-block" onClick={onClose}>
        やめる
      </button>
    </Modal>
  );
}

export interface Draft {
  item: Item;
  /** これから保存する添付（処理済み） */
  newFiles: ProcessedFile[];
  isNew: boolean;
}

const KINDS: ItemKind[] = ['notice', 'flyer', 'photo', 'memo'];

export function ItemForm(props: {
  draft: Draft;
  children: string[];
  events: string[];
  onAddFiles: (files: File[]) => Promise<ProcessedFile[]>;
  onSave: (item: Item, newFiles: ProcessedFile[], removed: AttachmentRef[]) => Promise<void>;
  onCancel: () => void;
  autoPaste?: boolean;
}) {
  const [it, setIt] = useState<Item>(props.draft.item);
  const [files, setFiles] = useState<ProcessedFile[]>(props.draft.newFiles);
  const [removed, setRemoved] = useState<AttachmentRef[]>([]);
  const [touched, setTouched] = useState<{ title: boolean; date: boolean }>({ title: !props.draft.isNew, date: !props.draft.isNew });
  const [otherChild, setOtherChild] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const set = (patch: Partial<Item>) => setIt((x) => ({ ...x, ...patch }));

  /** 本文が変わったら、利用者が触っていないタイトルと日付を自動で埋める */
  const setBody = (body: string) => {
    setIt((x) => {
      const n = { ...x, body };
      if (x.kind === 'notice' || x.kind === 'memo') {
        if (!touched.title) n.title = titleFromText(body);
        if (!touched.date) {
          const d = findDateInText(body);
          if (d) n.date = d;
        }
      }
      return n;
    });
  };

  const paste = async (target: 'body' | 'searchText') => {
    const t = await readClipboard();
    if (!t) {
      setMsg('貼り付けできませんでした。入力欄を長押しして「ペースト」を選んでください。');
      return;
    }
    setMsg(null);
    if (target === 'body') setBody(it.body ? `${it.body}\n${t}` : t);
    else set({ searchText: it.searchText ? `${it.searchText}\n${t}` : t });
  };

  useEffect(() => {
    if (props.autoPaste) bodyRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allAtts = [...it.attachments.filter((a) => !removed.some((r) => r.id === a.id)), ...files.map((f) => f.ref)];
  const takenDates = files.map((f) => f.ref.takenAt).filter(Boolean) as string[];
  const multiDay = new Set(takenDates).size > 1;
  const canSave = !!it.date && (it.title.trim() || it.body.trim() || allAtts.length > 0);
  const totalNew = files.reduce((s, f) => s + f.blobs.reduce((t, b) => t + b.size, 0), 0);

  const save = async () => {
    setSaving(true);
    try {
      const title = it.title.trim() || (it.kind === 'photo' ? `写真 ${allAtts.length}枚` : KIND_LABELS[it.kind]);
      await props.onSave({ ...it, title, attachments: allAtts, updatedAt: new Date().toISOString() }, files, removed);
    } catch (e) {
      setMsg(`保存できませんでした：${(e as Error).message}`);
      setSaving(false);
    }
  };

  return (
    <div className="screen form-screen">
      <div className="seg" role="radiogroup" aria-label="種類">
        {KINDS.map((k) => (
          <button key={k} role="radio" aria-checked={it.kind === k} className={`seg-btn ${it.kind === k ? 'on' : ''}`} onClick={() => set({ kind: k })}>
            <KindIcon kind={k} size={16} />
            {KIND_LABELS[k].replace('・資料', '')}
          </button>
        ))}
      </div>

      {(allAtts.length > 0 || it.kind === 'photo' || it.kind === 'flyer') && (
        <section className="card">
          <div className="att-grid">
            {allAtts.map((a) => {
              const f = files.find((x) => x.ref.id === a.id);
              return (
                <span key={a.id} className="att-cell">
                  {f?.thumbUrl ? <span className="thumb"><img src={f.thumbUrl} alt={a.name} /></span> : <Thumb att={a} />}
                  <button
                    className="att-remove"
                    aria-label={`${a.name}を外す`}
                    onClick={() => (f ? setFiles((xs) => xs.filter((x) => x !== f)) : setRemoved((r) => [...r, a]))}
                  >
                    <IconClose size={14} />
                  </button>
                </span>
              );
            })}
            <button className="att-add" onClick={() => pick.current?.click()} disabled={busy}>
              <IconPlus size={22} />
              <span>{busy ? '処理中…' : '追加'}</span>
            </button>
          </div>
          {totalNew > 0 && <p className="small muted">新しく保存する容量：約{formatBytes(totalNew)}</p>}
          {multiDay && <p className="small muted">撮影日が複数の日にまたがっています。日付は最も早い日にしました。</p>}
          <input
            ref={pick}
            type="file"
            hidden
            multiple
            accept={it.kind === 'photo' ? 'image/*' : 'image/*,application/pdf,.pdf'}
            onChange={async (e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = '';
              if (!list.length) return;
              setBusy(true);
              const added = await props.onAddFiles(list);
              setFiles((xs) => [...xs, ...added]);
              setBusy(false);
            }}
          />
        </section>
      )}

      <label className="field">
        <span>日付</span>
        <input type="date" value={it.date} onChange={(e) => (setTouched((t) => ({ ...t, date: true })), set({ date: e.target.value }))} />
      </label>
      <label className="field">
        <span>タイトル</span>
        <input value={it.title} placeholder={it.kind === 'photo' ? '例：運動会' : '例：作品展のお知らせ'} onChange={(e) => (setTouched((t) => ({ ...t, title: true })), set({ title: e.target.value }))} />
      </label>

      <label className="field">
        <span>{it.kind === 'photo' ? '説明（任意）' : '本文'}</span>
        <textarea ref={bodyRef} rows={it.kind === 'notice' || it.kind === 'memo' ? 8 : 3} value={it.body} placeholder={it.kind === 'notice' ? 'お知らせの文章を貼り付け' : ''} onChange={(e) => setBody(e.target.value)} />
      </label>
      {(it.kind === 'notice' || it.kind === 'memo') && (
        <button className="btn btn-small btn-ghost" onClick={() => paste('body')}>
          <IconClipboard size={18} /> コピーした文章を貼り付け
        </button>
      )}

      <div className="field-row">
        <label className="field">
          <span>行事（任意）</span>
          <input list="event-list" value={it.event} placeholder="例：運動会" onChange={(e) => set({ event: e.target.value })} />
          <datalist id="event-list">
            {props.events.map((e) => (
              <option key={e} value={e} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>子ども</span>
          {otherChild || (it.childName && !props.children.includes(it.childName)) ? (
            <input value={it.childName} placeholder="名前" onChange={(e) => set({ childName: e.target.value })} />
          ) : (
            <select
              value={it.childName}
              onChange={(e) => {
                if (e.target.value === '__other') setOtherChild(true);
                else set({ childName: e.target.value });
              }}
            >
              <option value="">家族全体・指定なし</option>
              {props.children.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__other">ほかの名前を入力…</option>
            </select>
          )}
        </label>
      </div>

      {(it.kind === 'flyer' || it.kind === 'photo') && (
        <details className="card fold" open={!!it.searchText}>
          <summary>画像の中の文字（検索できるようにする・任意）</summary>
          <p className="small muted">写真アプリで画像を開き、文字を長押し→「すべてを選択」→「コピー」してから、下のボタンで貼り付けます。</p>
          <textarea rows={4} value={it.searchText} onChange={(e) => set({ searchText: e.target.value })} />
          <button className="btn btn-small btn-ghost" onClick={() => paste('searchText')}>
            <IconClipboard size={18} /> 貼り付け
          </button>
        </details>
      )}

      {msg && (
        <p className="notice notice-warn" role="alert">
          {msg}
        </p>
      )}

      <div className="actions sticky-actions">
        <button className="btn" onClick={props.onCancel} disabled={saving}>
          やめる
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave || saving || busy}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
