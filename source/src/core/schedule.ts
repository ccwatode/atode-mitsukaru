import { foldText } from './search.ts';
import { CATEGORY_LABELS, type CalEvent, type EventCategory, type EventSource } from './types.ts';

/**
 * お知らせの文章から予定の候補を取り出す。
 * 方針：はっきり書かれた日付だけを候補にし、あいまいなもの（「中旬」「未定」、曜日の食い違い）は
 * 日付を確定せずに「要確認」として出す。候補は利用者が確認・修正してから登録する。
 */

export interface Candidate {
  title: string;
  /** YYYY-MM-DD。確定できないときは空 */
  date: string;
  endDate: string;
  start: string;
  end: string;
  location: string;
  category: EventCategory;
  /** 根拠になった文 */
  snippet: string;
  /** 日付をそのまま信じてよいか。false なら初期状態で未選択にし、確認を促す */
  dateCertain: boolean;
  /** 年を文章から読めず推定した */
  yearInferred: boolean;
  /** 中止の記載がある */
  cancelled: boolean;
  /** 利用者に見せる注意 */
  notes: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function valid(y: number, m: number, d: number) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
const weekday = (y: number, m: number, d: number) => WD[new Date(y, m - 1, d).getDay()];
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
const dayDiff = (a: string, b: string) => {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 864e5);
};

export function formatJpDate(date: string): string {
  if (!date) return '日付未定';
  const [y, m, d] = date.split('-').map(Number);
  return `${m}月${d}日（${weekday(y, m, d)}）`;
}

/* ---------- 正規表現 ---------- */

// 日付：2026年10月12日（土）／10月12日(土)／10/12（土）。時刻の「10:30」とは区別する
const DATE_RE =
  /(?<![\d/])(?:(20\d{2})\s*[年/]\s*)?(\d{1,2})\s*(月|\/)\s*(\d{1,2})(?![\d:])\s*日?(?:\s*[(（]\s*([月火水木金土日])[^)）]{0,5}[)）])?/g;
// 範囲の後半：〜14日／〜10月14日／〜10/14
const DATE_ONE = new RegExp(DATE_RE.source);
const RANGE_TAIL_RE = /^\s*(?:[〜~～\-－]|から)\s*(?:(\d{1,2})\s*(?:月|\/)\s*)?(\d{1,2})(?![\d:])\s*日?(?:\s*[(（]\s*([月火水木金土日])[^)）]{0,5}[)）])?/;
const TIME_ONE = String.raw`(午前|午後|AM|PM|am|pm)?\s*(\d{1,2})\s*(?:時\s*(?:(\d{1,2})\s*分|(半))?|:(\d{2}))`;
const TIME_RE = new RegExp(TIME_ONE + String.raw`(?:\s*(?:[〜~～\-－]|から)\s*` + TIME_ONE + ')?');
const VAGUE_RE = /(\d{1,2})\s*月\s*(上旬|中旬|下旬|頃|ごろ|中|末|予定)(?!\s*\d)/;
const LOC_RE = /(?:場所|会場|集合場所|開催場所|集合)\s*[:：]\s*([^\n。、]{1,40})/;

const KEYWORDS: [EventCategory, RegExp][] = [
  ['backup', /予備日|雨天|荒天|雨の場合|順延/],
  ['deadline', /締め?切|〆切|提出|までに|期限|申し?込/],
  ['closed', /休園|臨時休|お休み|閉園/],
  ['lunch', /給食|お弁当|弁当|おやつ/],
  [
    'event',
    /運動会|遠足|参観|発表会|懇談|面談|健康診断|健診|内科検診|歯科検診|誕生会|お誕生|避難訓練|入園式|卒園式|修了式|進級|お遊戯会|生活発表|音楽会|作品展|夏祭り|お祭り|クリスマス|節分|豆まき|ひなまつり|ひな祭り|七夕|プール|見学|説明会|保護者会|行事|試食会|いも掘り|芋掘り|親子|フェスティバル|式/,
  ],
  ['prepare', /持ち物|持参|準備|ご用意|お持ち|用意/],
];
const EVENT_WORD_RE = KEYWORDS.find(([c]) => c === 'event')![1];

function toTime(ampm: string | undefined, h: string, m?: string, half?: string, colon?: string): string | null {
  let hh = Number(h);
  const mm = Number(colon ?? m ?? (half ? 30 : 0));
  if (/午後|pm/i.test(ampm ?? '') && hh < 12) hh += 12;
  if (hh > 23 || mm > 59) return null;
  return `${pad(hh)}:${pad(mm)}`;
}

function findTime(s: string): { start: string; end: string } | null {
  const t = TIME_RE.exec(s);
  if (!t) return null;
  const start = toTime(t[1], t[2], t[3], t[4], t[5]);
  if (!start) return null;
  // 「午後1時〜3時」の後半は前半の午前/午後を引き継ぐ
  const end = t[7] ? toTime(t[6] ?? t[1], t[7], t[8], t[9], t[10]) : null;
  return { start, end: end && end > start ? end : '' };
}

/** 見出し・タイトルから「のお知らせ」などを除いた行事名 */
export function cleanTitle(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[【】「」『』［］\[\]<>＜＞]/g, ' ')
    .replace(/(について|のお知らせ|のご案内|お知らせ|ご案内|のお願い|開催|実施)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STRIP_HEAD = /^(?:日時|日程|期日|時間|期間|日\s*時|と\s*き|開催日|実施日|予定日|締切日?|提出期限|期限)?\s*[:：]?\s*(?:は|に|を|が|で|より|から|まで(?:に)?|の|、|・|\s)*/;
const STRIP_TAIL =
  /(?:を|は|が|に|で|の|、|・|\s)*(?:(?:に|へ)?変更(?:します|いたします|致します|となります|になります|しました)?|行います|おこないます|実施します|実施いたします|開催します|開催いたします|予定しています|予定です|予定|あります|ございます|です|となります|になります|します|いたします|して(?:ください|下さい)|(?:ください|下さい)|お願い(?:します|いたします|致します)?|ます)?[。!！\s]*$/;

function titleFromSegment(seg: string): string {
  let s = seg
    .replace(DATE_RE, '\u0000')
    .replace(/[(（][^)）]{0,6}[)）]/g, ' ')
    .replace(/(?:は|が|の|、)?\s*\u0000(?:\s*[〜~～\-－]\s*\u0000)?\s*(?:は|に|を|が|で|の|まで(?:に)?|から|より|、)?/g, ' ')
    .replace(new RegExp(TIME_RE.source, 'g'), ' ');
  s = s.replace(/[(（][^)）]{0,6}[)）]/g, ' ').replace(/[〜~～\-－]/g, ' ');
  s = s.replace(/[【】「」『』]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) s = s.replace(STRIP_HEAD, '').replace(STRIP_TAIL, '').trim();
  // 場所などの別項目が続く場合は切る
  s = s.split(/\s(?:場所|会場|持ち物|対象|集合)\s*[:：]/)[0].trim();
  return s;
}

function categoryOf(seg: string): EventCategory | null {
  for (const [c, re] of KEYWORDS) if (re.test(seg)) return c;
  return null;
}

const NOISE_TITLE = /各位|園長|保育園$|こども園$|幼稚園$|発行|作成|^No\.|^第?\d+号/;

/**
 * @param text お知らせ本文（画像の文字を貼り付けたものも含めてよい）
 * @param baseDate お知らせの日付（年の推定に使う） YYYY-MM-DD
 * @param contextTitle お知らせのタイトル（行事名の補完に使う）
 */
export function extractCandidates(text: string, baseDate: string, contextTitle = ''): Candidate[] {
  const t = text.normalize('NFKC');
  const ctx = cleanTitle(contextTitle);
  const ctxEvent = (EVENT_WORD_RE.exec(ctx) ?? EVENT_WORD_RE.exec(t))?.[0] ?? '';
  const globalLoc = LOC_RE.exec(t)?.[1].trim() ?? '';
  const [by, bm, bd] = baseDate.split('-').map(Number);
  const segs = t
    .split(/\n|(?<=。)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Candidate[] = [];

  segs.forEach((seg, si) => {
    const matches = [...seg.matchAll(DATE_RE)].filter((m) => {
      const mo = Number(m[2]);
      const d = Number(m[4]);
      // 「1/2」のような分数や年号の一部を避ける：月日として成り立つものだけ
      return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && !(m[3] === '/' && !m[1] && /\d\s*\/\s*\d+\s*\//.test(seg.slice(m.index!, m.index! + 10)));
    });

    if (!matches.length) {
      // あいまいな日付（「11月中旬」など）は、行事の言葉があれば日付未定の候補にする
      const v = VAGUE_RE.exec(seg);
      const cat = categoryOf(seg);
      if (v && cat && cat !== 'prepare') {
        const title = titleFromSegment(seg.replace(VAGUE_RE, ' ')) || ctx;
        out.push({
          title: shortTitle(title, ctx, cat),
          date: '',
          endDate: '',
          start: '',
          end: '',
          location: '',
          category: cat,
          snippet: seg,
          dateCertain: false,
          yearInferred: false,
          cancelled: false,
          notes: [`日付があいまいです（${v[0]}）。決まったら日付を入れてください`],
        });
      }
      return;
    }

    // 「1月8日〜1月9日」のように日付が2つ並ぶ範囲は、後ろを終了日として扱う
    const rangeEnd = new Map<number, RegExpExecArray | RegExpMatchArray>();
    const skip = new Set<number>();
    for (let i = 0; i + 1 < matches.length; i++) {
      const between = seg.slice(matches[i].index! + matches[i][0].length, matches[i + 1].index!);
      if (/^\s*(?:[〜~～\-－]|から)\s*$/.test(between)) {
        rangeEnd.set(i, matches[i + 1]);
        skip.add(i + 1);
      }
    }
    matches.forEach((m, mi) => {
      if (skip.has(mi)) return;
      const notes: string[] = [];
      const mo = Number(m[2]);
      const d = Number(m[4]);
      let y = m[1] ? Number(m[1]) : by;
      const yearInferred = !m[1];
      let dateCertain = true;
      if (yearInferred) {
        // お知らせは先の予定を書くことが多い：基準日より3か月以上前なら翌年とみなす
        if (valid(y, mo, d) && dayDiff(ymd(y, mo, d), ymd(by, bm, bd)) < -90) y += 1;
      }
      if (!valid(y, mo, d)) return;
      const wd = m[5];
      if (wd && weekday(y, mo, d) !== wd) {
        const alt = [y - 1, y + 1].find((yy) => yearInferred && valid(yy, mo, d) && weekday(yy, mo, d) === wd);
        if (alt) {
          y = alt;
        } else {
          notes.push(`曜日が合いません（文章は${wd}曜、${y}年${mo}月${d}日は${weekday(y, mo, d)}曜）`);
          dateCertain = false;
        }
      }
      if (yearInferred) notes.push(`年は書かれていないため${y}年としました`);
      const date = ymd(y, mo, d);

      // この日付から次の日付までがこの予定の説明
      const from = m.index! + m[0].length;
      const nextIdx = [...Array(matches.length).keys()].find((j) => j > mi && !skip.has(j));
      const to = nextIdx !== undefined ? matches[nextIdx].index! : seg.length;
      let tail = seg.slice(from, to);
      let endDate = '';
      const re2 = rangeEnd.get(mi);
      if (re2) {
        const em = Number(re2[2]);
        const ed = Number(re2[4]);
        const ey = re2[1] ? Number(re2[1]) : em < mo ? y + 1 : y;
        if (valid(ey, em, ed) && ymd(ey, em, ed) > ymd(y, mo, d)) endDate = ymd(ey, em, ed);
        tail = seg.slice(re2.index! + re2[0].length, to);
      }
      const r = re2 ? null : RANGE_TAIL_RE.exec(tail);
      if (r) {
        const em = r[1] ? Number(r[1]) : mo;
        const ed = Number(r[2]);
        const ey = em < mo ? y + 1 : y;
        if (valid(ey, em, ed) && ymd(ey, em, ed) > date) {
          endDate = ymd(ey, em, ed);
          tail = tail.slice(r[0].length);
        }
      }
      let time = findTime(tail);
      // 時刻が次の行（「時間：9:00〜12:00」）にある場合
      if (!time && si + 1 < segs.length && !DATE_ONE.test(segs[si + 1])) {
        if (/^(?:時間|時刻|集合|開始|受付|開場|と\s*き)/.test(segs[si + 1]) || segs[si + 1].length <= 20) time = findTime(segs[si + 1]);
      }

      // 発行日らしい日付（年あり・曜日なし・時刻なしで、後ろに何も続かない）は予定にしない
      if (m[1] && !m[5] && !rangeEnd.has(mi) && !tail.trim() && !findTime(tail)) {
        const after = segs[si + 1] ?? '';
        if (!(/^(?:時間|時刻|集合|開始|受付)/.test(after) && findTime(after))) return;
      }
      const prevIdx = [...Array(mi).keys()].reverse().find((j) => !skip.has(j));
      const prevEnd = prevIdx === undefined ? 0 : (rangeEnd.get(prevIdx) ?? matches[prevIdx]).index! + (rangeEnd.get(prevIdx) ?? matches[prevIdx])[0].length;
      const piece = seg.slice(prevEnd, to);
      let cat = categoryOf(piece) ?? categoryOf(seg);
      const cancelled = /中止|取りやめ|取り止め/.test(piece) && !/雨天|荒天|雨の場合/.test(piece);
      if (cancelled) notes.push('「中止」の記載があります');
      if (/延期/.test(piece) && cat !== 'backup') notes.push('「延期」の記載があります。日付を確認してください');

      let title = titleFromSegment(piece);
      if (cat === 'backup') title = `${ctxEvent || ctx || '行事'}（予備日）`;
      else if (cat === 'deadline' && title && !/締|〆|期限/.test(title)) title = `締切：${title}`;
      // 「1/4食べた」のような分数：曜日・年・時刻・予定の言葉がない「/」表記は候補にしない
      if (m[3] === '/' && !m[1] && !m[5] && !cat && !time) return;
      if (/^\s*(?:食べ|程度|量|残|杯|個|枚|本|人|回)/.test(seg.slice(from))) return;
      if (!cat) {
        if (!title || title.length < 2 || title.length > 24 || NOISE_TITLE.test(title)) {
          if (!time) return; // 発行日など、予定らしさのない日付は候補にしない
        }
        cat = EVENT_WORD_RE.test(title || ctx) ? 'event' : 'other';
      }
      title = shortTitle(title, ctx, cat);
      const loc = LOC_RE.exec(piece)?.[1].trim() ?? (cat === 'event' || cat === 'backup' ? globalLoc : '');
      if (!time && cat !== 'deadline' && cat !== 'closed' && cat !== 'lunch') notes.push('時刻が書かれていないため終日の予定にしました');

      out.push({
        title,
        date,
        endDate,
        start: time?.start ?? '',
        end: time?.end ?? '',
        location: loc,
        category: cat,
        snippet: piece.trim() || seg,
        dateCertain,
        yearInferred,
        cancelled,
        notes,
      });
    });
  });

  // 同じ日・同じ名前は1つにまとめる（時刻や場所が分かる方を残す）
  const merged = new Map<string, Candidate>();
  for (const c of out) {
    const k = `${c.date}|${foldText(c.title)}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, c);
    else {
      prev.start ||= c.start;
      prev.end ||= c.end;
      prev.location ||= c.location;
      prev.endDate ||= c.endDate;
    }
  }
  return [...merged.values()];
}

function shortTitle(title: string, ctx: string, cat: EventCategory): string {
  let t = title.trim();
  if (!t || t.length < 2) t = ctx ? (cat === 'event' || cat === 'other' ? ctx : `${ctx}（${CATEGORY_LABELS[cat]}）`) : CATEGORY_LABELS[cat];
  return t.length > 30 ? t.slice(0, 30) + '…' : t;
}

/* ---------- 既存の予定との照合（重複防止・変更検知） ---------- */

export type MatchResult =
  | { status: 'new' }
  | { status: 'same'; event: CalEvent }
  | { status: 'changed'; event: CalEvent; diffs: string[] }
  | { status: 'cancel'; event: CalEvent };

function similarTitle(a: string, b: string): boolean {
  const x = foldText(cleanTitle(a).replace(/（[^）]*）|\([^)]*\)/g, ''));
  const y = foldText(cleanTitle(b).replace(/（[^）]*）|\([^)]*\)/g, ''));
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 2 && l.includes(s);
}

const timeLabel = (e: { start: string; end: string }) => (e.start ? `${e.start}${e.end ? '〜' + e.end : '〜'}` : '終日');
const dateLabel = (e: { date: string; endDate: string }) => formatJpDate(e.date) + (e.endDate ? `〜${formatJpDate(e.endDate)}` : '');

export function diffEvent(
  old: Pick<CalEvent, 'title' | 'date' | 'endDate' | 'start' | 'end' | 'location'>,
  next: Pick<CalEvent, 'title' | 'date' | 'endDate' | 'start' | 'end' | 'location'>,
): string[] {
  const d: string[] = [];
  if (old.date !== next.date || old.endDate !== next.endDate) d.push(`日付：${dateLabel(old)} → ${dateLabel(next)}`);
  if (old.start !== next.start || old.end !== next.end) d.push(`時刻：${timeLabel(old)} → ${timeLabel(next)}`);
  if (next.location && old.location !== next.location) d.push(`場所：${old.location || '（なし）'} → ${next.location}`);
  if (foldText(old.title) !== foldText(next.title)) d.push(`名前：${old.title} → ${next.title}`);
  return d;
}

/**
 * 候補が既存の予定と同じか・変わったか・中止かを判定する。
 * 同じ種類で名前が似ていて、日付が同じか120日以内のものを「同じ予定」とみなす。
 */
export function matchCandidate(c: Candidate, events: CalEvent[]): MatchResult {
  const pool = events.filter((e) => e.category === c.category && similarTitle(e.title, c.title));
  if (!pool.length) return { status: 'new' };
  const near = pool
    .filter((e) => !c.date || Math.abs(dayDiff(e.date, c.date)) <= 120)
    .sort((a, b) => (c.date ? Math.abs(dayDiff(a.date, c.date)) - Math.abs(dayDiff(b.date, c.date)) : 0));
  const e = near[0];
  if (!e) return { status: 'new' };
  if (c.cancelled) return e.status === 'cancelled' ? { status: 'same', event: e } : { status: 'cancel', event: e };
  if (!c.date) return { status: 'same', event: e }; // 日付未定の候補は既存を変えない
  const diffs = diffEvent(e, { ...c, title: e.title }); // 名前の言い回しの違いは差分にしない
  return diffs.length ? { status: 'changed', event: e, diffs } : { status: 'same', event: e };
}

/* ---------- 予定の作成・更新 ---------- */

export function newEventFromCandidate(c: Candidate, src: EventSource, childName: string, id: string, now: string): CalEvent {
  return {
    id,
    title: c.title,
    date: c.date,
    endDate: c.endDate,
    start: c.start,
    end: c.end,
    location: c.location,
    description: '',
    childName,
    category: c.category,
    status: c.cancelled ? 'cancelled' : 'active',
    source: src,
    history: [],
    exportedAt: '',
    sequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** 既存の予定を候補の内容で更新し、変更履歴を残す */
export function applyCandidate(e: CalEvent, c: Candidate, now: string, sourceId: string): CalEvent {
  const next = { ...e, date: c.date, endDate: c.endDate, start: c.start, end: c.end, location: c.location || e.location };
  const changes = diffEvent(e, next);
  return { ...next, sequence: e.sequence + 1, updatedAt: now, history: [...e.history, { at: now, changes, sourceId }] };
}

export function cancelEvent(e: CalEvent, now: string, sourceId?: string): CalEvent {
  return { ...e, status: 'cancelled', sequence: e.sequence + 1, updatedAt: now, history: [...e.history, { at: now, changes: ['中止になりました'], sourceId }] };
}

/** 手で編集したときの変更履歴 */
export function editEvent(e: CalEvent, next: CalEvent, now: string): CalEvent {
  const changes = diffEvent(e, next);
  if (e.status !== next.status) changes.push(next.status === 'cancelled' ? '中止にしました' : '中止を取り消しました');
  return {
    ...next,
    sequence: changes.length ? e.sequence + 1 : e.sequence,
    updatedAt: now,
    history: changes.length ? [...e.history, { at: now, changes }] : e.history,
  };
}

/** 外部カレンダーに書き出した後に変わったか */
export const changedSinceExport = (e: CalEvent) => !!e.exportedAt && e.updatedAt > e.exportedAt;

/* ---------- 外部カレンダー ---------- */

const compact = (date: string) => date.replace(/-/g, '');
const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545：1行75オクテットで折り返す（UTF-8の文字の途中では切らない） */
function fold75(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length ? 74 : 75; // 継続行は先頭の空白1つ分を引く
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function endOf(e: CalEvent): { date: string; time: string } {
  const date = e.endDate || e.date;
  if (e.end) return { date, time: e.end };
  const [h, m] = e.start.split(':').map(Number);
  // 終了時刻がなければ1時間（日をまたぐ場合は23:59まで）
  return { date, time: h >= 23 ? '23:59' : `${pad(h + 1)}:${pad(m)}` };
}

export interface ExportContext {
  /** 予定の説明に添える元のお知らせの名前 */
  sourceTitle?: (e: CalEvent) => string;
  appUrl?: string;
}

function descriptionOf(e: CalEvent, ctx: ExportContext): string {
  const parts = [e.description.trim()];
  if (e.childName) parts.push(`対象：${e.childName}`);
  const st = ctx.sourceTitle?.(e);
  if (st) parts.push(`元のお知らせ：${st}（原本は「あとで見つかる」で開けます）`);
  return parts.filter(Boolean).join('\n');
}

export function toICS(events: CalEvent[], now: Date, ctx: ExportContext = {}): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//atode-mitsukaru//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Tokyo',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0900',
    'TZOFFSETTO:+0900',
    'TZNAME:JST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.id}@atode-mitsukaru`, `DTSTAMP:${stamp}`, `SEQUENCE:${e.sequence}`);
    if (e.start) {
      const en = endOf(e);
      L.push(`DTSTART;TZID=Asia/Tokyo:${compact(e.date)}T${e.start.replace(':', '')}00`, `DTEND;TZID=Asia/Tokyo:${compact(en.date)}T${en.time.replace(':', '')}00`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(addDays(e.endDate || e.date, 1))}`);
    }
    L.push(`SUMMARY:${icsEscape((e.status === 'cancelled' ? '【中止】' : '') + e.title)}`);
    if (e.location) L.push(`LOCATION:${icsEscape(e.location)}`);
    const desc = descriptionOf(e, ctx);
    if (desc) L.push(`DESCRIPTION:${icsEscape(desc)}`);
    L.push(`STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, `CATEGORIES:${icsEscape(CATEGORY_LABELS[e.category])}`);
    if (!e.start) L.push('TRANSP:TRANSPARENT');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold75).join('\r\n') + '\r\n';
}

/** Googleカレンダーの「予定を作成」画面を内容入りで開くリンク（ログイン中のGoogleアカウントに追加される） */
export function googleCalendarUrl(e: CalEvent, ctx: ExportContext = {}): string {
  let dates: string;
  if (e.start) {
    const en = endOf(e);
    dates = `${compact(e.date)}T${e.start.replace(':', '')}00/${compact(en.date)}T${en.time.replace(':', '')}00`;
  } else {
    dates = `${compact(e.date)}/${compact(addDays(e.endDate || e.date, 1))}`;
  }
  const q = new URLSearchParams({ action: 'TEMPLATE', text: (e.status === 'cancelled' ? '【中止】' : '') + e.title, dates, ctz: 'Asia/Tokyo' });
  const desc = descriptionOf(e, ctx);
  if (desc) q.set('details', desc);
  if (e.location) q.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/* ---------- 表示用 ---------- */

export function eventTimeLabel(e: Pick<CalEvent, 'start' | 'end'>): string {
  return e.start ? `${e.start}${e.end ? '〜' + e.end : ''}` : '終日';
}

/** その日にかかる予定（複数日の予定は期間中の毎日に出す） */
export function eventsOn(events: CalEvent[], date: string): CalEvent[] {
  return events
    .filter((e) => e.date && (e.date === date || (e.endDate && e.date <= date && date <= e.endDate)))
    .sort((a, b) => (a.start || '00:00').localeCompare(b.start || '00:00'));
}

/** 月間カレンダーの枠（月曜始まりではなく日曜始まり、6週固定ではなく必要な週数） */
export function monthGrid(year: number, month: number): string[][] {
  const first = new Date(year, month - 1, 1);
  const start = new Date(year, month - 1, 1 - first.getDay());
  const weeks: string[][] = [];
  const cur = new Date(start);
  do {
    const w: string[] = [];
    for (let i = 0; i < 7; i++) {
      w.push(ymd(cur.getFullYear(), cur.getMonth() + 1, cur.getDate()));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(w);
  } while (cur.getMonth() === month - 1 && cur.getFullYear() === year);
  return weeks;
}
