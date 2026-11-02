import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AttachmentRef, FetchStatus, Item, ItemKind, NoteRecord } from '../core/types.ts';
import { KIND_LABELS } from '../core/types.ts';
import { applyPending, type PendingUpdate } from '../core/merge.ts';
import { toCSV, toJSON } from '../core/exportData.ts';
import { itemToDoc, noteToDoc } from '../core/search.ts';
import { newId, titleFromFileName, titleFromText, findDateInText, todayStr } from '../core/textutil.ts';
import * as db from '../db.ts';
import { importJson, importPdf, type ImportReport } from '../importer.ts';
import { createBackup, restoreBackup, type BackupResult, type RestoreReport } from '../backupService.ts';
import { processFile, type ProcessedFile } from '../media.ts';
import { readClipboard, saveFile, textFile } from '../save.ts';
import { daysSince, formatBytes, formatDate, formatDateTime, Modal } from './common.tsx';
import { AddSheet, ItemForm, type AddChoice, type Draft } from './AddFlow.tsx';
import { DataView } from './DataView.tsx';
import { buildEntries, childrenOf, eventsOf, matchChild, type Entry } from './entries.ts';
import { IconBack, IconGear, IconHome, IconPhoto, IconPlus, IconSearch } from './icons.tsx';
import { ItemDetail, Photos, Viewer } from './ItemView.tsx';
import { Detail, PendingView } from './note.tsx';
import { SearchView, type SearchState } from './SearchView.tsx';
import { Timeline, type KindFilter } from './Timeline.tsx';

type Tab = 'home' | 'search' | 'photos' | 'data';
type View = { tab: Tab; screen?: 'note' | 'item' | 'form' | 'pending'; id?: string; draft?: Draft; autoPaste?: boolean };

const TAB_TITLE: Record<Tab, string> = { home: 'あとで見つかる', search: '検索', photos: '写真・チラシ', data: 'データ' };

export function App() {
  const [records, setRecords] = useState<NoteRecord[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<PendingUpdate[]>([]);
  const [files, setFiles] = useState<db.FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  const [lastBackupAt, setLastBackupAt] = useState<string | undefined>();
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [child, setChild] = useState('');
  const [stack, setStack] = useState<View[]>([{ tab: 'home' }]);
  const view = stack[stack.length - 1];
  const [filter, setFilter] = useState<KindFilter>('all');
  const [sq, setSq] = useState<SearchState>({ q: '', from: '', to: '', kind: 'all' });
  const [sheet, setSheet] = useState(false);
  const [viewer, setViewer] = useState<{ atts: AttachmentRef[]; index: number; item?: Item } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reports, setReports] = useState<ImportReport[] | null>(null);
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  const [backupReady, setBackupReady] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const inputs = {
    pdf: useRef<HTMLInputElement>(null),
    flyer: useRef<HTMLInputElement>(null),
    photo: useRef<HTMLInputElement>(null),
    json: useRef<HTMLInputElement>(null),
    zip: useRef<HTMLInputElement>(null),
  };
  const mainRef = useRef<HTMLElement>(null);

  const reload = useCallback(async () => {
    const [rs, its, ps, fs, persistent, lb, ko, ch] = await Promise.all([
      db.getRecords(),
      db.getItems(),
      db.getPending(),
      db.getFiles(),
      db.isPersistentStorage(),
      db.getMeta<string>('lastBackupAt'),
      db.getMeta<boolean>('keepOriginal'),
      db.getMeta<string>('child'),
    ]);
    rs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
    setRecords(rs);
    setItems(its);
    setPending(ps);
    setFiles(fs);
    setMemoryOnly(!persistent);
    setLastBackupAt(lb);
    setKeepOriginal(!!ko);
    setChild(ch ?? '');
    setStorage(await db.storageInfo());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
    const onUpd = () => setUpdated(true);
    window.addEventListener('app-updated', onUpd);
    return () => window.removeEventListener('app-updated', onUpd);
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const children = useMemo(() => childrenOf(records, items), [records, items]);
  const events = useMemo(() => eventsOf(items), [items]);
  const allEntries = useMemo(() => buildEntries(records, items), [records, items]);
  const entries = useMemo(() => allEntries.filter((e) => matchChild(e, child)), [allEntries, child]);
  const entryMap = useMemo(() => new Map(allEntries.map((e) => [e.id, e])), [allEntries]);
  const docs = useMemo(() => [...records.map(noteToDoc), ...items.map(itemToDoc)], [records, items]);
  const recById = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const notesShown = entries.filter((e) => e.note);
  const unfetched = notesShown.filter((e) => e.note!.fetchStatus === '未取得').length;
  const attachmentCount = items.reduce((s, i) => s + i.attachments.length, 0);

  const go = (v: View, replace = false) => setStack((s) => (replace ? [...s.slice(0, -1), v] : [...s, v]));
  const goTab = (tab: Tab) => setStack([{ tab }]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const openEntry = (e: Entry) => go({ tab: view.tab, screen: e.kind === 'note' ? 'note' : 'item', id: e.id });

  /* ---------- 追加 ---------- */

  const newDraft = (kind: ItemKind, patch: Partial<Item> = {}, newFiles: ProcessedFile[] = []): Draft => {
    const now = new Date().toISOString();
    return {
      isNew: true,
      newFiles,
      item: { id: newId('it'), kind, date: todayStr(), title: '', body: '', searchText: '', childName: child, event: '', attachments: [], source: { via: 'file', fileNames: [] }, createdAt: now, updatedAt: now, ...patch },
    };
  };

  const processFiles = async (list: File[]): Promise<ProcessedFile[]> => {
    const out: ProcessedFile[] = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(`画像を準備しています（${i + 1}/${list.length}）`);
      out.push(await processFile(list[i], keepOriginal));
    }
    setBusy(null);
    return out;
  };

  const choose = async (c: AddChoice) => {
    setSheet(false);
    if (c === 'notePdf') inputs.pdf.current?.click();
    else if (c === 'flyer') inputs.flyer.current?.click();
    else if (c === 'photo') inputs.photo.current?.click();
    else if (c === 'memo') go({ tab: view.tab, screen: 'form', draft: newDraft('memo') });
    else {
      // お知らせ：ボタンを押した流れでクリップボードを読み、すぐ本文に入れる（iPhoneでは「ペースト」の確認が出る）
      const t = (await readClipboard())?.trim() ?? '';
      go({ tab: view.tab, screen: 'form', autoPaste: !t, draft: newDraft('notice', t ? { body: t, title: titleFromText(t), date: findDateInText(t) ?? todayStr(), source: { via: 'paste', fileNames: [] } } : { source: { via: 'paste', fileNames: [] } }) });
    }
  };

  const onMediaChosen = async (kind: 'flyer' | 'photo', list: File[]) => {
    if (!list.length) return;
    const processed = await processFiles(list);
    const dates = processed.map((p) => p.ref.takenAt).filter(Boolean).sort() as string[];
    go({
      tab: view.tab,
      screen: 'form',
      draft: newDraft(
        kind,
        {
          date: (kind === 'photo' && dates[0]) || todayStr(),
          title: kind === 'flyer' ? titleFromFileName(list[0].name) : '',
          source: { via: kind === 'photo' ? 'photo' : 'file', fileNames: list.map((f) => f.name) },
        },
        processed,
      ),
    });
  };

  const saveItem = async (item: Item, newFiles: ProcessedFile[], removed: AttachmentRef[]) => {
    await db.saveItem(item, newFiles.flatMap((f) => f.blobs));
    if (removed.length) await db.write([{ store: 'blobs', del: removed.flatMap((a) => a.variants.map((v) => `${a.id}:${v}`)) }]);
    await reload();
    setToast('保存しました');
    go({ tab: view.tab, screen: 'item', id: item.id }, true);
  };

  const onPdfsChosen = async (list: File[]) => {
    if (!list.length) return;
    setError(null);
    const out: ImportReport[] = [];
    let current = records;
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') throw new Error(`${f.name} はPDFではありません`);
        out.push(await importPdf(f, current, (s) => setBusy(list.length > 1 ? `${s}（${i + 1}/${list.length}）` : s)));
        current = await db.getRecords();
      }
      if (!(await db.storageInfo()).persisted) await db.requestPersist();
    } catch (e) {
      setError(`取り込めませんでした：${(e as Error).message}`);
    } finally {
      setBusy(null);
      await reload();
      if (out.length) setReports(out);
    }
  };

  /* ---------- 連絡帳の承認 ---------- */

  const approve = async (ids: string[]) => {
    const now = new Date().toISOString();
    await db.approvePending(ids.map((id) => applyPending(recById.get(id), pending.find((p) => p.id === id)!, now)), ids);
    await reload();
    setToast(`${ids.length}件を反映しました`);
  };

  /* ---------- バックアップ ---------- */

  const doBackup = async (includePdfs: boolean) => {
    setError(null);
    try {
      setBackupReady(await createBackup(includePdfs, setBusy));
    } catch (e) {
      setError(`バックアップを作れませんでした：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const saveBackup = async () => {
    if (!backupReady) return;
    const r = await saveFile(backupReady.file);
    if (r === 'saved' || r === 'started') {
      const now = new Date().toISOString();
      await db.setMeta('lastBackupAt', now);
      setLastBackupAt(now);
      setBackupReady(null);
      setToast(r === 'saved' ? 'バックアップを保存しました' : 'バックアップのダウンロードを開始しました');
    } else if (r === 'declined') setToast('保存をキャンセルしました');
    else setToast('保存できませんでした');
  };

  const onZipChosen = async (f?: File) => {
    if (!f) return;
    setError(null);
    try {
      setRestoreReport(await restoreBackup(f, setBusy));
      await reload();
    } catch (e) {
      setError(`復元できませんでした：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const exportText = async (name: string, text: string, type: string) => {
    const r = await saveFile(textFile(name, text, type));
    setToast(r === 'saved' ? '保存しました' : r === 'started' ? '保存を開始しました' : r === 'declined' ? '保存をキャンセルしました' : '保存できませんでした');
  };

  const deleteAll = async () => {
    await db.clearAll();
    setConfirmDelete(false);
    setStack([{ tab: 'home' }]);
    await reload();
    setToast('この端末のデータを削除しました');
  };

  /* ---------- 画面 ---------- */

  const backupDays = daysSince(lastBackupAt);
  const banners: ReactNode = (
    <>
      {updated && (
        <button className="notice notice-action" onClick={() => location.reload()}>
          <strong>新しい版を受け取りました</strong>
          <span>タップして再読み込みすると反映されます</span>
        </button>
      )}
      {memoryOnly && (
        <p className="notice notice-warn" role="alert">
          {db.openProblem === 'blocked' ? '古い版のアプリが別の画面で開いています。そちらを閉じてから再読み込みしてください。それまでは保存されません。' : 'この表示環境では端末内に保存できません。画面を閉じると記録は消えます。'}
        </p>
      )}
      {pending.length > 0 && (
        <button className="notice notice-action" onClick={() => go({ tab: view.tab, screen: 'pending' })}>
          <strong>連絡帳の更新の確認待ち {pending.length}件</strong>
          <span>新しいPDFとの違いを確認して、反映するか選んでください</span>
        </button>
      )}
      {(records.length > 0 || items.length > 0) && (backupDays == null || backupDays > 30) && (
        <button className="notice notice-soft" onClick={() => goTab('data')}>
          <strong>{backupDays == null ? 'まだバックアップがありません' : `最後のバックアップから${backupDays}日`}</strong>
          <span>iPhoneの故障や機種変更に備えて、ファイルに保存しておきましょう</span>
        </button>
      )}
    </>
  );

  let title = TAB_TITLE[view.tab];
  let content: ReactNode = null;
  if (view.screen === 'pending') {
    title = '連絡帳の更新の確認';
    content = <PendingView pending={pending} current={recById} onApprove={approve} onReject={async (id) => (await db.deletePending(id), await reload(), setToast('反映しませんでした'))} />;
  } else if (view.screen === 'note') {
    const r = recById.get(view.id!);
    const list = notesShown.map((e) => e.id);
    const idx = list.indexOf(view.id!);
    title = '連絡帳';
    content = r ? (
      <Detail record={r} newerId={list[idx - 1]} olderId={list[idx + 1]} onOpen={(id) => go({ ...view, id }, true)} onSave={async (n) => (await db.putRecords([n]), await reload(), setToast('保存しました'))} />
    ) : (
      <p className="empty">記録が見つかりません。</p>
    );
  } else if (view.screen === 'item') {
    const it = itemById.get(view.id!);
    title = it ? KIND_LABELS[it.kind] : '記録';
    content = it ? (
      <ItemDetail
        item={it}
        onEdit={() => go({ tab: view.tab, screen: 'form', draft: { item: it, newFiles: [], isNew: false } })}
        onDelete={async () => {
          await db.deleteItem(it);
          await reload();
          back();
          setToast('削除しました');
        }}
        onEvent={(ev) => {
          setSq({ q: ev, from: '', to: '', kind: 'all' });
          setStack([{ tab: 'search' }]);
        }}
        onView={(atts, index) => setViewer({ atts, index })}
      />
    ) : (
      <p className="empty">記録が見つかりません。</p>
    );
  } else if (view.screen === 'form' && view.draft) {
    title = view.draft.isNew ? `${KIND_LABELS[view.draft.item.kind]}を追加` : '編集';
    content = <ItemForm draft={view.draft} children={children} events={events} autoPaste={view.autoPaste} onAddFiles={processFiles} onSave={saveItem} onCancel={back} />;
  } else if (view.tab === 'home') {
    content = (
      <Timeline
        entries={entries}
        filter={filter}
        onFilter={setFilter}
        onOpen={openEntry}
        onAdd={() => setSheet(true)}
        onSearch={() => goTab('search')}
        banners={banners}
        counts={{ note: notesShown.length, unfetched }}
      />
    );
  } else if (view.tab === 'search') {
    content = <SearchView docs={docs} entries={entryMap} child={child} s={sq} onChange={setSq} onOpen={openEntry} unfetched={unfetched} />;
  } else if (view.tab === 'photos') {
    content = <Photos items={items.filter((i) => matchChild(i, child))} onAdd={() => setSheet(true)} onView={(atts, index, item) => setViewer({ atts, index, item })} />;
  } else {
    content = (
      <DataView
        counts={{ records: records.length, items: items.length, attachments: attachmentCount }}
        files={files}
        storage={storage}
        memoryOnly={memoryOnly}
        lastBackupAt={lastBackupAt}
        keepOriginal={keepOriginal}
        onKeepOriginal={async (v) => (await db.setMeta('keepOriginal', v), setKeepOriginal(v))}
        onBackup={doBackup}
        onRestore={() => inputs.zip.current?.click()}
        onExportJson={() => exportText(`あとで見つかる_連絡帳_${todayStr()}.json`, toJSON(records, new Date().toISOString()), 'application/json')}
        onExportCsv={() => exportText(`あとで見つかる_連絡帳_${todayStr()}.csv`, toCSV(records), 'text/csv')}
        onImportJson={() => inputs.json.current?.click()}
        onPersist={async () => {
          const ok = await db.requestPersist();
          setStorage(await db.storageInfo());
          setToast(ok ? '永続保存が許可されました' : 'このブラウザでは許可されませんでした');
        }}
        onDeleteAll={() => setConfirmDelete(true)}
      />
    );
  }

  const tabBtn = (t: Tab, icon: ReactNode, label: string) => (
    <button className={`tab ${view.tab === t && !view.screen ? 'on' : ''}`} onClick={() => goTab(t)} aria-current={view.tab === t ? 'page' : undefined}>
      {icon}
      <span>{label}</span>
    </button>
  );

  const fileInput = (key: keyof typeof inputs, accept: string, multiple: boolean, testid: string, on: (fs: File[]) => void) => (
    <input
      ref={inputs[key]}
      type="file"
      accept={accept}
      multiple={multiple}
      hidden
      data-testid={testid}
      onChange={(e) => {
        const fs = [...(e.target.files ?? [])];
        e.target.value = '';
        on(fs);
      }}
    />
  );

  return (
    <div className="app">
      <header className="topbar">
        {stack.length > 1 ? (
          <button className="topbar-back" onClick={back} aria-label="戻る">
            <IconBack size={22} />
          </button>
        ) : (
          <span className="topbar-spacer" />
        )}
        <h1 className={`topbar-title ${view.tab === 'home' && !view.screen ? 'brand' : ''}`}>{title}</h1>
        <span className="topbar-spacer" />
      </header>
      {children.length > 1 && !view.screen && (
        <div className="childbar chips" role="group" aria-label="子どもで絞り込み">
          {['', ...children].map((c) => (
            <button key={c || 'all'} className={`chip ${child === c ? 'on' : ''}`} aria-pressed={child === c} onClick={async () => (setChild(c), await db.setMeta('child', c))}>
              {c || '家族全員'}
            </button>
          ))}
        </div>
      )}

      <main className="main" ref={mainRef}>
        {loaded ? content : <p className="empty">読み込み中…</p>}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </main>

      <nav className="tabbar" aria-label="画面の切り替え">
        {tabBtn('home', <IconHome />, 'ホーム')}
        {tabBtn('search', <IconSearch />, '検索')}
        <button className="tab tab-add" onClick={() => setSheet(true)} aria-label="追加">
          <span className="tab-add-circle">
            <IconPlus size={26} />
          </span>
        </button>
        {tabBtn('photos', <IconPhoto />, '写真')}
        {tabBtn('data', <IconGear />, 'データ')}
      </nav>

      {fileInput('pdf', 'application/pdf,.pdf', true, 'pdf-input', (fs) => void onPdfsChosen(fs))}
      {fileInput('flyer', 'image/*,application/pdf,.pdf', true, 'flyer-input', (fs) => void onMediaChosen('flyer', fs))}
      {fileInput('photo', 'image/*', true, 'photo-input', (fs) => void onMediaChosen('photo', fs))}
      {fileInput('json', 'application/json,.json', false, 'json-input', async (fs) => {
        if (!fs[0]) return;
        try {
          setReports([await importJson(fs[0], records)]);
          await reload();
        } catch (e) {
          setError(`読み込めませんでした：${(e as Error).message}`);
        }
      })}
      {fileInput('zip', 'application/zip,.zip', false, 'zip-input', (fs) => void onZipChosen(fs[0]))}

      {sheet && <AddSheet onChoose={(c) => void choose(c)} onClose={() => setSheet(false)} />}

      {viewer && (
        <Viewer
          atts={viewer.atts}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onOpenItem={viewer.item ? () => (setViewer(null), go({ tab: view.tab, screen: 'item', id: viewer.item!.id })) : undefined}
        />
      )}

      {busy && (
        <div className="modal-back">
          <div className="modal busy" role="status" aria-live="polite">
            <div className="spinner" aria-hidden />
            <p>{busy}…</p>
          </div>
        </div>
      )}

      {reports && <ImportReportModal reports={reports} onClose={() => setReports(null)} onPending={() => (setReports(null), go({ tab: view.tab, screen: 'pending' }))} onHome={() => (setReports(null), setFilter('note'), goTab('home'))} />}

      {backupReady && (
        <Modal title="バックアップを作成しました" onClose={() => setBackupReady(null)}>
          <p>
            連絡帳{backupReady.counts.records}日分・記録{backupReady.counts.items}件・添付{backupReady.counts.attachments}件・PDF{backupReady.counts.pdfs}件（{formatBytes(backupReady.size)}）
          </p>
          <p className="small muted">次の画面で「ファイルに保存」→ iCloud Drive などを選んでください。</p>
          <div className="actions">
            <button className="btn" onClick={() => setBackupReady(null)}>
              やめる
            </button>
            <button className="btn btn-primary" onClick={() => void saveBackup()}>
              ファイルに保存
            </button>
          </div>
        </Modal>
      )}

      {restoreReport && (
        <Modal title="復元が終わりました" onClose={() => setRestoreReport(null)}>
          <p className="small muted">{formatDateTime(restoreReport.createdAt)} に作成されたバックアップ</p>
          <ul className="report">
            <li>連絡帳：追加 {restoreReport.notesAdded}日／変更なし {restoreReport.notesUnchanged}日{restoreReport.notesPending ? `／内容が違う ${restoreReport.notesPending}日（確認待ち）` : ''}</li>
            <li>お知らせ・チラシ・写真：追加 {restoreReport.itemsAdded}件／同じ {restoreReport.itemsSame}件</li>
            <li>添付：{restoreReport.attachmentsAdded}件、元PDF：{restoreReport.pdfsAdded}件</li>
          </ul>
          {restoreReport.itemsKeptExisting.length > 0 && (
            <p className="notice notice-warn small">今の端末の内容と違う {restoreReport.itemsKeptExisting.length}件（{restoreReport.itemsKeptExisting.slice(0, 3).join('、')}{restoreReport.itemsKeptExisting.length > 3 ? ' など' : ''}）は、今の内容を残しました。</p>
          )}
          <button className="btn btn-primary btn-block" onClick={() => (setRestoreReport(null), goTab('home'))}>
            ホームで確認
          </button>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="すべて削除しますか？" onClose={() => setConfirmDelete(false)}>
          <p>連絡帳{records.length}日分、記録{items.length}件、画像・PDFをこの端末から削除します。元に戻せません。必要ならバックアップしてから削除してください。</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              やめる
            </button>
            <button className="btn btn-danger" onClick={deleteAll}>
              削除する
            </button>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ImportReportModal({ reports, onClose, onPending, onHome }: { reports: ImportReport[]; onClose: () => void; onPending: () => void; onHome: () => void }) {
  const sum = (f: (r: ImportReport) => number) => reports.reduce((s, r) => s + f(r), 0);
  const counts: Record<FetchStatus, number> = { 取得済み: sum((r) => r.counts.取得済み), 要確認: sum((r) => r.counts.要確認), 未取得: sum((r) => r.counts.未取得) };
  const pending = sum((r) => r.pending);
  const truncated = reports.filter((r) => r.truncation);
  return (
    <Modal title="取り込みが終わりました" onClose={onClose}>
      <p className="small muted">
        {reports.map((r) => r.fileName).join('、')}（{(sum((r) => r.elapsedMs) / 1000).toFixed(1)}秒）
      </p>
      {reports.some((r) => r.alreadyImported) && <p className="notice small">以前にも取り込んだファイルが含まれています。記録は重複しません。</p>}
      <ul className="report">
        <li>
          {reports[0].kind === 'pdf' ? '日付の見出し' : '記録'}：<strong>{sum((r) => r.headingCount)}件</strong>
        </li>
        <li>
          内訳：取得済み {counts.取得済み} ／ 要確認 {counts.要確認} ／ 本文未取得 {counts.未取得}
        </li>
        <li>新しく追加：{sum((r) => r.added)}日</li>
        <li>変更なし：{sum((r) => r.unchanged + r.keptRicher)}日</li>
        {pending > 0 && (
          <li>
            <strong>内容が異なる：{pending}日</strong>（確認してから反映します）
          </li>
        )}
      </ul>
      {truncated.map((r) => (
        <div key={r.fileName} className="notice notice-warn small">
          <strong>{r.truncation!.atHeightLimit ? 'PDFが長すぎて途中で切れています' : 'PDFの最後で記録が途切れています'}</strong>
          <p>
            {formatDate(r.truncation!.lastDate)}の記録は途中までで、それより前の日付はこのPDFに入っていない可能性があります。連絡帳アプリで{formatDate(r.truncation!.lastDate, false)}以前を表示した状態で、もう1つPDFを作って追加してください（展開した日なら1つのPDFに約8〜10日分が目安）。
          </p>
        </div>
      ))}
      {reports.flatMap((r) => r.warnings.filter((w) => !r.truncation || !w.includes('最下端'))).map((w) => (
        <p key={w} className="notice notice-warn small">
          {w}
        </p>
      ))}
      <div className="actions">
        {pending > 0 ? (
          <button className="btn btn-primary" onClick={onPending}>
            違いを確認する
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onHome}>
            連絡帳を見る
          </button>
        )}
        <button className="btn" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Modal>
  );
}
