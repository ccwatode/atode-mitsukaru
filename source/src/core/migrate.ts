import { foldText } from './search.ts';
import type { AttachmentRef, CalEvent, Child, Family, Item, NoteRecord, Purpose } from './types.ts';

/**
 * v0.5 の移行（D3：データベースの版は上げず、項目を足すだけ）。
 *  - 連絡帳（records）は一切書き換えない。子どもとの対応は名前から画面側で引く
 *  - 記録（items）と予定（events）は、無い項目だけを埋める。既にある値は変えない
 *  - 何度実行しても結果は同じ（2回目は変更0件）
 */

export const SCHEMA_VERSION = 5;

/* ---------- 分類（D4：保護者向けの区分） ---------- */

/**
 * タイトルの決まった形から保護者向けの区分を推定する。外れたら利用者が直す。
 * 例：「今日の◯◯組」→思い出、「今日の給食」→日々の記録、「【◯◯】配信します」→資料、「お詫びと訂正」→予定
 */
export function classifyPurposes(title: string, kind?: Item['kind'], body = ''): Purpose[] {
  const t = title.normalize('NFKC');
  const out = new Set<Purpose>();
  if (/お詫び|訂正|変更|中止|延期|休園|臨時/.test(t)) out.add('schedule');
  if (/配信します|だより|献立表|お便り|案内/.test(t)) out.add('documents');
  if (/給食|おやつ/.test(t) && !/献立表|だより/.test(t)) out.add('daily');
  if (/^今日の(?!給食)|の様子|活動/.test(t)) out.add('memories');
  if (/運動会|遠足|参観|発表会|懇談|面談|健診|検診|説明会|行事|締切|提出|持ち物/.test(t) && !out.has('memories')) out.add('schedule');
  if (!out.size) {
    if (kind === 'photo') out.add('memories');
    else if (kind === 'flyer') out.add('documents');
    else if (kind === 'notice' && /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}/.test(body.normalize('NFKC'))) out.add('schedule');
  }
  return [...out];
}

/* ---------- 子ども ---------- */

const same = (a: string, b: string) => foldText(a) === foldText(b);

/** 名前（表記）から子どもを探す。見つからなければ undefined */
export function findChild(children: Child[], name: string): Child | undefined {
  if (!name.trim()) return undefined;
  return children.find((c) => same(c.displayName, name) || c.aliases.some((a) => same(a, name)));
}

/** 記録に出てくる名前から子どもの一覧を作る（既存の子どもは保つ） */
export function collectChildren(names: string[], existing: Child[], newId: () => string, now: string): { children: Child[]; added: Child[] } {
  const children = existing.map((c) => ({ ...c, aliases: [...c.aliases] }));
  const added: Child[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || findChild(children, name)) continue;
    const c: Child = { id: newId(), displayName: name, aliases: [name], createdAt: now };
    children.push(c);
    added.push(c);
  }
  return { children, added };
}

/** 同じ子どもの別表記をまとめる（b を a に統合）。記録側の childIds は呼び出し側で付け替える */
export function mergeChildren(children: Child[], keepId: string, mergeId: string): Child[] {
  const keep = children.find((c) => c.id === keepId);
  const merge = children.find((c) => c.id === mergeId);
  if (!keep || !merge || keepId === mergeId) return children;
  const aliases = [...keep.aliases];
  for (const a of [merge.displayName, ...merge.aliases]) if (!aliases.some((x) => same(x, a))) aliases.push(a);
  return children.filter((c) => c.id !== mergeId).map((c) => (c.id === keepId ? { ...c, aliases } : c));
}

/* ---------- 移行 ---------- */

export interface MigrationInput {
  records: NoteRecord[];
  items: Item[];
  events: CalEvent[];
  family?: Family;
  children?: Child[];
}

export interface MigrationResult {
  family: Family;
  children: Child[];
  /** 変更のあった記録・予定だけ（保存対象） */
  items: Item[];
  events: CalEvent[];
  report: { childrenAdded: number; itemsUpdated: number; eventsUpdated: number };
}

function attachmentDefaults(a: AttachmentRef, kind: Item['kind']): AttachmentRef {
  const isPdf = a.mime === 'application/pdf';
  return {
    ...a,
    role: a.role ?? (kind === 'photo' && !isPdf ? 'photo' : 'document'),
    provenance: a.provenance ?? 'single',
    state: a.state ?? 'saved',
  };
}

const ids = (children: Child[], name: string) => {
  const c = findChild(children, name);
  return c ? [c.id] : [];
};

export function migrate(input: MigrationInput, newId: () => string, now: string): MigrationResult {
  const family: Family = input.family ?? { id: newId(), name: 'わが家', deviceUserId: newId(), createdAt: now };
  const names = [...input.records.map((r) => r.childName), ...input.items.map((i) => i.childName), ...input.events.map((e) => e.childName)];
  const { children, added } = collectChildren(names, input.children ?? [], newId, now);

  const items: Item[] = [];
  for (const it of input.items) {
    const next: Item = {
      ...it,
      purposes: it.purposes ?? classifyPurposes(it.title, it.kind, it.body),
      importedAt: it.importedAt ?? it.createdAt,
      childIds: it.childIds ?? ids(children, it.childName),
      status: it.status ?? 'filed',
      important: it.important ?? false,
      bodyState: it.bodyState ?? 'unknown',
      history: it.history ?? [],
      familyId: it.familyId ?? family.id,
      createdBy: it.createdBy ?? family.deviceUserId,
      rev: it.rev ?? 1,
      attachments: it.attachments.map((a) => attachmentDefaults(a, it.kind)),
    };
    if (JSON.stringify(next) !== JSON.stringify(it)) items.push(next);
  }

  const events: CalEvent[] = [];
  for (const e of input.events) {
    const next: CalEvent = {
      ...e,
      childIds: e.childIds ?? ids(children, e.childName),
      familyId: e.familyId ?? family.id,
      rev: e.rev ?? 1,
    };
    if (JSON.stringify(next) !== JSON.stringify(e)) events.push(next);
  }

  return { family, children, items, events, report: { childrenAdded: added.length, itemsUpdated: items.length, eventsUpdated: events.length } };
}

/** 新しく作る記録・予定に、家族・作成者・版番号などの v0.5 の項目を付ける */
export function stampNew<T extends { familyId?: string; rev?: number }>(x: T, family: Family | undefined): T {
  return { ...x, familyId: x.familyId ?? family?.id, rev: x.rev ?? 1 };
}

/** 更新したときに版番号を上げる */
export const bump = <T extends { rev?: number }>(x: T): T => ({ ...x, rev: (x.rev ?? 1) + 1 });
