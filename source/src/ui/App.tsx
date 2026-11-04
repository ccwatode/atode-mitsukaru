import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AttachmentRef, CalEvent, Child, Family, FetchStatus, Item, ItemKind, NoteRecord } from '../core/types.ts';
import { mergeChildren, migrate, SCHEMA_VERSION } from '../core/migrate.ts';
import { EDITABLE_FIELDS } from '../core/types.ts';
import { applyCandidate, cancelEvent, editEvent, extractCandidates, googleCalendarUrl, matchCandidate, newEventFromCandidate, toICS, type ExportContext } from '../core/schedule.ts';
import { CalendarView, EventDetail, EventForm, initialAction, ReviewView, SourceEvents, UpcomingCard, type ReviewRow, type SourceRef } from './Calendar.tsx';
import { KIND_LABELS } from '../core/types.ts';
import { applyPending, type PendingUpdate } from '../core/merge.ts';
import { toCSV, toJSON } from '../core/exportData.ts';
import { itemToDoc, noteToDoc } from '../core/search.ts';
import { newId, titleFromFileName, titleFromText, findDateInText, todayStr } from '../core/textutil.ts';
import * as db from '../db.ts';
import { importJson, importPdf, type ImportReport } from '../importer.ts';
import { createBackup, restoreBackup, type BackupResult, type RestoreReport } from '../backupService.ts';
import { processFile, type ProcessedFile } from '../media.ts';
import { openCalendarFile, readClipboard, saveFile, textFile } from '../save.ts';
import { daysSince, formatBytes, formatDate, formatDateTime, Modal } from './common.tsx';
import { AddSheet, ItemForm, type AddChoice, type Draft } from './AddFlow.tsx';
import { DataView } from './DataView.tsx';
import { buildEntries, childrenOf, eventsOf, matchChild, type Entry } from './entries.ts';
import { IconBack, IconCalendar, IconGear, IconHome, IconPhoto, IconPlus } from './icons.tsx';
import { ItemDetail, Photos, Viewer } from './ItemView.tsx';
import { Detail, PendingView } from './note.tsx';
import { SearchView, type SearchState } from './SearchView.tsx';
import { Timeline, type KindFilter } from './Timeline.tsx';

type Tab = 'home' | 'search' | 'calendar' | 'photos' | 'data';
type View = {
  tab: Tab;
  screen?: 'note' | 'item' | 'form' | 'pending' | 'event' | 'eventForm' | 'review';
  id?: string;
  draft?: Draft;
  autoPaste?: boolean;
  evDraft?: { event: CalEvent; isNew: boolean };
  review?: { source: SourceRef; rows: ReviewRow[] };
};

const TAB_TITLE: Record<Tab, string> = { home: 'あとで見つかる', search: '検索', calendar: '予定', photos: '写真・チラシ', data: 'データ' };
const APP_URL = typeof location !== 'undefined' ? location.origin + location.pathname : '';

/** 予定を取り出す対象の文章 */
const itemText = (it: Item) => [it.title, it.body, it.searchText].filter(Boolean).join('\n');
const noteText = (r: NoteRecord) => EDITABLE_FIELDS.map((f) => (r as unknown as Record<string, string>)[f]).filter(Boolean).join('\n');
const itemSource = (it: Item): SourceRef => ({ type: 'item', id: it.id, kind: it.kind, title: it.title, date: it.date, text: itemText(it), childName: it.childName });
const noteSource = (r: NoteRecord): SourceRef => ({ type: 'note', id: r.id, kind: 'note', title: `連絡帳 ${r.date}`, date: r.date, text: noteText(r), childName: r.childName });

export function App() {
  const [records, setRecords] = useState<NoteRecord[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [calEvents, setCalEvents] = useState<CalEvent[]>([]);
  const [family, setFamily] = useState<Family | undefined>();
  const [kids, setKids] = useState<Child[]>([]);
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [migrationPrompt, setMigrationPrompt] = useState(false);
  const [migrateAfterBackup, setMigrateAfterBackup] = useState(false);
  const [calMonth, setCalMonth] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() + 1 }));
  const [calSel, setCalSel] = useState(todayStr());
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
    const [rs, its, evs, ps, fs, persistent, lb, ko, ch, fam, kidList, sv] = await Promise.all([
      db.getRecords(),
      db.getItems(),
      db.getEvents(),
      db.getPending(),
      db.getFiles(),
      db.isPersistentStorage(),
      db.getMeta<string>('lastBackupAt'),
      db.getMeta<boolean>('keepOriginal'),
      db.getMeta<string>('child'),
      db.getFamily(),
      db.getChildren(),
      db.getSchemaVersion(),
    ]);
    setFamily(fam);
    setKids(kidList);
    setSchemaVersion(sv);
    rs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
    setRecords(rs);
    setItems(its);
    setCalEvents(evs);
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

  // 予定へのリンク（#e=予定ID）。カレンダーの予定の説明から開いた場合など
  useEffect(() => {
    if (!loaded) return;
    const m = /^#e=([\w-]+)$/.exec(location.hash);
    if (m && calEvents.some((e) => e.id === m[1])) {
      setStack([{ tab: 'calendar' }, { tab: 'calendar', screen: 'event', id: m[1] }]);
      history.replaceState(null, '', location.pathname);
    }
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const eventById = useMemo(() => new Map(calEvents.map((e) => [e.id, e])), [calEvents]);
  const visibleEvents = useMemo(() => calEvents.filter((e) => !child || !e.childName || e.childName === child), [calEvents, child]);
  const notesShown = entries.filter((e) => e.note);
  const unfetched = notesShown.filter((e) => e.note!.fetchStatus === '未取得').length;
  const attachmentCount = items.reduce((s, i) => s + i.attachments.length, 0);

  const go = (v: View, replace = false) => setStack((s) => (replace ? [...s.slice(0, -1), v] : [...s, v]));
  const goTab = (tab: Tab) => setStack([{ tab }]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const openEntry = (e: Entry) => go({ tab: view.tab, screen: e.kind === 'note' ? 'note' : 'item', id: e.id });

  /* ---------- v0.5：移行（D3：版を上げず項目を足すだけ。何度実行しても同じ結果） ---------- */

  const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : newId('id'));

  const runMigration = useCallback(async (quiet = false) => {
    const [rs, its, evs, fam, kidList] = await Promise.all([db.getRecords(), db.getItems(), db.getEvents(), db.getFamily(), db.getChildren()]);
    const r = migrate({ records: rs, items: its, events: evs, family: fam, children: kidList }, uuid, new Date().toISOString());
    await db.write([
      { store: 'items', put: r.items },
      { store: 'events', put: r.events },
      {
        store: 'meta',
        put: [
          { key: 'family', value: r.family },
          { key: 'children', value: r.children },
          { key: 'schemaVersion', value: SCHEMA_VERSION },
          ...(fam ? [] : [{ key: 'migratedAt', value: new Date().toISOString() }]),
        ],
      },
    ]);
    await reload();
    if (!quiet) setToast('データの形式を更新しました（今までの記録はそのままです）');
  }, [reload]);

  // 初回起動：データがなければそのまま、あれば先にバックアップを案内する
  useEffect(() => {
    if (!loaded || schemaVersion == null || schemaVersion >= SCHEMA_VERSION || migrationPrompt) return;
    if (!records.length && !items.length && !calEvents.length) void runMigration(true);
    else setMigrationPrompt(true);
  }, [loaded, schemaVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 保存する記録・予定に v0.5 の項目（子どもID・分類・家族・版番号）を付ける。childIds は名前から付け直す */
  const withV5 = async (its: Item[], evs: CalEvent[]): Promise<{ items: Item[]; events: CalEvent[] }> => {
    const r = migrate(
      { records: [], items: its.map((i) => ({ ...i, childIds: undefined })), events: evs.map((e) => ({ ...e, childIds: undefined })), family, children: kids },
      uuid,
      new Date().toISOString(),
    );
    if (r.report.childrenAdded || !family) {
      await db.write([{ store: 'meta', put: [{ key: 'children', value: r.children }, ...(family ? [] : [{ key: 'family', value: r.family }])] }]);
    }
    const pick = <T extends { id: string }>(xs: T[], done: T[]) => xs.map((x) => done.find((d) => d.id === x.id) ?? x);
    return { items: pick(its, r.items), events: pick(evs, r.events) };
  };

  const renameChild = async (id: string, name: string) => {
    const next = kids.map((c) => (c.id === id && name.trim() ? { ...c, displayName: name.trim(), aliases: c.aliases.includes(name.trim()) ? c.aliases : [...c.aliases, name.trim()] } : c));
    await db.setMeta('children', next);
    setKids(next);
  };

  /** 別表記の子どもをまとめる。記録・予定の子どもIDも付け替える */
  const mergeChild = async (keepId: string, mergeId: string) => {
    const next = mergeChildren(kids, keepId, mergeId);
    const fix = <T extends { childIds?: string[]; rev?: number }>(x: T): T | null =>
      x.childIds?.includes(mergeId) ? { ...x, childIds: [...new Set(x.childIds.map((c) => (c === mergeId ? keepId : c)))], rev: (x.rev ?? 1) + 1 } : null;
    await db.write([
      { store: 'meta', put: [{ key: 'children', value: next }] },
      { store: 'items', put: items.map(fix).filter(Boolean) as Item[] },
      { store: 'events', put: calEvents.map(fix).filter(Boolean) as CalEvent[] },
    ]);
    await reload();
    setToast('同じ子どもとしてまとめました');
  };

  /* ---------- 予定 ---------- */

  const sourceOfEvent = (e: CalEvent): SourceRef | null => {
    if (e.source.type === 'item') {
      const it = itemById.get(e.source.id);
      return it ? itemSource(it) : null;
    }
    if (e.source.type === 'note') {
      const r = recById.get(e.source.id);
      return r ? noteSource(r) : null;
    }
    return null;
  };
  const exportCtx: ExportContext = { sourceTitle: (e) => sourceOfEvent(e)?.title ?? '', appUrl: APP_URL };

  const candidateRows = (src: SourceRef): ReviewRow[] =>
    extractCandidates(src.text, src.date, src.type === 'item' ? src.title : '').map((c, i) => {
      const match = matchCandidate(c, calEvents);
      return { key: `r${i}`, c, match, action: initialAction(c, match) };
    });
  const pendingCandidates = (src: SourceRef) => candidateRows(src).filter((r) => r.match.status !== 'same').length;
  const linkedEvents = (id: string) => calEvents.filter((e) => e.source.id === id).sort((a, b) => a.date.localeCompare(b.date));
  const openReview = (src: SourceRef) => go({ tab: view.tab, screen: 'review', review: { source: src, rows: candidateRows(src) } });

  const blankEvent = (patch: Partial<CalEvent> = {}): CalEvent => {
    const now = new Date().toISOString();
    return {
      id: newId('ev'), title: '', date: calSel || todayStr(), endDate: '', start: '', end: '', location: '', description: '', childName: child, category: 'event', status: 'active',
      source: { type: 'manual', id: '', snippet: '' }, history: [], exportedAt: '', sequence: 0, createdAt: now, updatedAt: now, ...patch,
    };
  };

  const register = async (rows: ReviewRow[], childName: string, src: SourceRef) => {
    const now = new Date().toISOString();
    const puts: CalEvent[] = [];
    for (const r of rows) {
      const snippet = r.c.snippet.slice(0, 300);
      if (r.action === 'add') puts.push(newEventFromCandidate(r.c, { type: src.type, id: src.id, snippet }, childName, newId('ev'), now));
      else if (r.action === 'update' && r.match.status === 'changed') puts.push(applyCandidate(r.match.event, r.c, now, src.id));
      else if (r.action === 'cancel' && r.match.status === 'cancel') puts.push(cancelEvent(r.match.event, now, src.id));
    }
    await db.putEvents((await withV5([], puts.map((p) => (p.createdAt === now ? p : { ...p, rev: (p.rev ?? 1) + 1 })))).events);
    await reload();
    back();
    setToast(`予定を${puts.length}件反映しました`);
  };

  const saveEvent = async (e: CalEvent, isNew: boolean) => {
    const now = new Date().toISOString();
    const prev = eventById.get(e.id);
    const edited = isNew || !prev ? { ...e, createdAt: now, updatedAt: now } : { ...editEvent(prev, e, now), rev: (prev.rev ?? 1) + 1 };
    const next = (await withV5([], [edited])).events[0];
    await db.putEvents([next]);
    await reload();
    setCalSel(next.date);
    setCalMonth({ y: Number(next.date.slice(0, 4)), m: Number(next.date.slice(5, 7)) });
    setToast(isNew ? '予定を登録しました' : '保存しました');
    go({ tab: view.tab, screen: 'event', id: next.id }, true);
  };

  const markExported = async (es: CalEvent[]) => {
    const now = new Date().toISOString();
    await db.putEvents(es.map((e) => ({ ...e, exportedAt: now })));
    await reload();
  };

  const exportIcs = async (es: CalEvent[]) => {
    const ics = toICS(es, new Date(), exportCtx);
    const name = es.length === 1 ? `予定_${es[0].date}.ics` : `予定_${es.length}件_${todayStr()}.ics`;
    const r = openCalendarFile(name, ics);
    await markExported(es);
    setToast(r === 'opened' ? 'カレンダーの画面で「追加」を押してください' : '予定ファイル（.ics）を保存しました。開くとカレンダーに追加できます');
  };

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
          searchText: processed.map((p) => p.text ?? '').filter(Boolean).join('\n\n'),
          source: { via: kind === 'photo' ? 'photo' : 'file', fileNames: list.map((f) => f.name) },
        },
        processed,
      ),
    });
  };

  const saveItem = async (item: Item, newFiles: ProcessedFile[], removed: AttachmentRef[]) => {
    const prev = itemById.get(item.id);
    const stamped = (await withV5([prev ? { ...item, rev: (prev.rev ?? 1) + 1, updatedAt: new Date().toISOString() } : item], [])).items[0];
    await db.saveItem(stamped, newFiles.flatMap((f) => f.blobs));
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
      if (migrateAfterBackup) {
        setMigrateAfterBackup(false);
        await runMigration();
      }
    } else if (r === 'declined') setToast('保存をキャンセルしました');
    else setToast('保存できませんでした');
  };

  const onZipChosen = async (f?: File) => {
    if (!f) return;
    setError(null);
    try {
      setRestoreReport(await restoreBackup(f, setBusy));
      await runMigration(true);
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
  const today = todayStr();
  const soon = visibleEvents
    .filter((e) => e.status === 'active' && (e.endDate || e.date) >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''))
    .slice(0, 3);
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
      <UpcomingCard events={soon} onOpen={(e) => go({ tab: 'home', screen: 'event', id: e.id })} onAll={() => goTab('calendar')} />
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
      <>
        <Detail record={r} newerId={list[idx - 1]} olderId={list[idx + 1]} onOpen={(id) => go({ ...view, id }, true)} onSave={async (n) => (await db.putRecords([n]), await reload(), setToast('保存しました'))} />
        {r.fetchStatus !== '未取得' && (
          <SourceEvents linked={linkedEvents(r.id)} pendingCount={pendingCandidates(noteSource(r))} onExtract={() => openReview(noteSource(r))} onOpen={(e) => go({ tab: view.tab, screen: 'event', id: e.id })} />
        )}
      </>
    ) : (
      <p className="empty">記録が見つかりません。</p>
    );
  } else if (view.screen === 'item') {
    const it = itemById.get(view.id!);
    title = it ? KIND_LABELS[it.kind] : '記録';
    content = it ? (
      <>
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
          go({ tab: 'search' });
        }}
        onView={(atts, index) => setViewer({ atts, index })}
      />
      {it.kind !== 'photo' && (
        <SourceEvents linked={linkedEvents(it.id)} pendingCount={pendingCandidates(itemSource(it))} onExtract={() => openReview(itemSource(it))} onOpen={(e) => go({ tab: view.tab, screen: 'event', id: e.id })} />
      )}
      </>
    ) : (
      <p className="empty">記録が見つかりません。</p>
    );
  } else if (view.screen === 'event') {
    const e = eventById.get(view.id!);
    title = '予定';
    content = e ? (
      <EventDetail
        e={e}
        source={sourceOfEvent(e)}
        sourceTitle={(id) => itemById.get(id)?.title ?? (recById.get(id) ? `連絡帳 ${recById.get(id)!.date}` : undefined)}
        googleUrl={googleCalendarUrl(e, exportCtx)}
        onOpenSource={() => e.source.type !== 'manual' && go({ tab: view.tab, screen: e.source.type, id: e.source.id })}
        onEdit={() => go({ tab: view.tab, screen: 'eventForm', evDraft: { event: e, isNew: false } })}
        onToggleCancel={async () => {
          const now = new Date().toISOString();
          await db.putEvents([e.status === 'cancelled' ? editEvent(e, { ...e, status: 'active' }, now) : cancelEvent(e, now)]);
          await reload();
          setToast(e.status === 'cancelled' ? '中止を取り消しました' : '中止にしました');
        }}
        onDelete={async () => {
          await db.deleteEvent(e.id);
          await reload();
          back();
          setToast('予定を削除しました');
        }}
        onIcs={() => void exportIcs([e])}
        onGoogle={() => void markExported([e])}
      />
    ) : (
      <p className="empty">予定が見つかりません。</p>
    );
  } else if (view.screen === 'eventForm' && view.evDraft) {
    title = view.evDraft.isNew ? '予定を追加' : '予定の編集';
    content = <EventForm event={view.evDraft.event} isNew={view.evDraft.isNew} children={children} onSave={(e) => void saveEvent(e, view.evDraft!.isNew)} onCancel={back} />;
  } else if (view.screen === 'review' && view.review) {
    const src = view.review.source;
    title = '予定の候補';
    content = (
      <ReviewView
        source={src}
        rows={view.review.rows}
        children={children}
        onRegister={(rows, ch) => void register(rows, ch, src)}
        onManual={() => go({ tab: view.tab, screen: 'eventForm', evDraft: { event: blankEvent({ date: src.date, childName: src.childName, source: { type: src.type, id: src.id, snippet: '' } }), isNew: true } }, true)}
        onCancel={back}
      />
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
        onSearch={() => go({ tab: 'search' })}
        banners={banners}
        counts={{ note: notesShown.length, unfetched }}
      />
    );
  } else if (view.tab === 'calendar') {
    content = (
      <CalendarView
        events={visibleEvents}
        month={calMonth}
        onMonth={setCalMonth}
        selected={calSel}
        onSelect={setCalSel}
        onOpen={(e) => go({ tab: 'calendar', screen: 'event', id: e.id })}
        onAdd={(date) => go({ tab: 'calendar', screen: 'eventForm', evDraft: { event: blankEvent({ date }), isNew: true } })}
        onExportMany={(es) => void exportIcs(es)}
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
        kids={kids}
        kidUsage={(id) => items.filter((i) => i.childIds?.includes(id)).length + calEvents.filter((e) => e.childIds?.includes(id)).length}
        onRenameChild={(id, name) => void renameChild(id, name)}
        onMergeChild={(a, b) => void mergeChild(a, b)}
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
        {tabBtn('calendar', <IconCalendar />, '予定')}
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
          await runMigration(true);
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
        <Modal title="バックアップを作成しました" onClose={() => (setBackupReady(null), migrateAfterBackup && (setMigrateAfterBackup(false), setMigrationPrompt(true)))}>
          <p>
            連絡帳{backupReady.counts.records}日分・記録{backupReady.counts.items}件・添付{backupReady.counts.attachments}件・PDF{backupReady.counts.pdfs}件・予定{backupReady.counts.events ?? 0}件（{formatBytes(backupReady.size)}）
          </p>
          <p className="small muted">次の画面で「ファイルに保存」→ iCloud Drive などを選んでください。</p>
          <div className="actions">
            <button className="btn" onClick={() => (setBackupReady(null), migrateAfterBackup && (setMigrateAfterBackup(false), setMigrationPrompt(true)))}>
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
            {restoreReport.childrenAdded > 0 && <li>子ども：追加 {restoreReport.childrenAdded}人</li>}
            <li>予定：追加 {restoreReport.eventsAdded}件／同じ {restoreReport.eventsSame}件{restoreReport.eventsKeptExisting.length ? `／内容が違う ${restoreReport.eventsKeptExisting.length}件（今の内容を残しました）` : ''}</li>
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

      {migrationPrompt && !backupReady && !busy && (
        <Modal title="データの形式を更新します">
          <p>お知らせの分類（思い出・予定・資料・日々の記録）や、子どもごとの整理ができるように、記録に項目を足します。</p>
          <p className="small muted">今の連絡帳・お知らせ・写真・予定は消えず、書き換えもしません。前の版のアプリでもそのまま開けます。念のため、先にバックアップを保存しておくと安心です。</p>
          <div className="btn-col">
            <button
              className="btn btn-primary"
              onClick={() => {
                setMigrationPrompt(false);
                setMigrateAfterBackup(true);
                void doBackup(true);
              }}
            >
              バックアップを保存してから更新
            </button>
            <button className="btn" onClick={() => (setMigrationPrompt(false), void runMigration())}>
              このまま更新
            </button>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="すべて削除しますか？" onClose={() => setConfirmDelete(false)}>
          <p>連絡帳{records.length}日分、記録{items.length}件、予定{calEvents.length}件、画像・PDFをこの端末から削除します。元に戻せません。必要ならバックアップしてから削除してください。</p>
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
