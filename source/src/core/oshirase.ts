import { foldText } from './search.ts';
import type { Item, TextPiece } from './types.ts';

/**
 * お知らせ一覧のPDF（保護者がSafariで自分の画面を保存したもの）を記事ごとに分ける。
 * 位置の絶対値には頼らず、文字の大きさと並びから判断する（保存方法でページ幅や倍率が変わるため）。
 *
 *   2026-11-02                 ← 日付の見出し
 *   ［園名］［子どもの名前］    ← 札（本文より小さい文字）。ここから1件
 *   タイトル
 *   本文 …… 「小さくする」（全文）／「… もっとみる」（省略あり）
 *       添付の名前.pdf (180.8KB) ← 本文より字下げ
 */

export interface ParsedAttachment {
  displayName: string;
  /** 画面の表記のまま（例 "180.8KB"） */
  displaySize: string;
}

export interface ParsedPost {
  date: string;
  school: string;
  childName: string;
  title: string;
  body: string;
  bodyState: 'full' | 'truncated';
  attachments: ParsedAttachment[];
  /** 通し座標での範囲（写真の割り当てに使う） */
  yStart: number;
  yEnd: number;
  externalKey: string;
}

export interface ListParseResult {
  posts: ParsedPost[];
  /** 一覧の先頭〜末尾の日付 */
  range: { from: string; to: string } | null;
  warnings: string[];
  /** PDFの長さ上限で末尾が切れている可能性 */
  cutOff: boolean;
}

interface Row {
  y: number;
  x: number;
  right: number;
  h: number;
  text: string;
  parts: TextPiece[];
}

const DATE_RE = /^(20\d{2})-(\d{2})-(\d{2})$/;
const ATT_RE = /^(.+\.[A-Za-z0-9]{2,5})\s*\(\s*([\d.]+)\s*([KMG]?B)\s*\)$/;
const FULLPAGE_LIMIT = 14390;

function toRows(pieces: TextPiece[]): Row[] {
  const ps = pieces.filter((p) => p.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Row[] = [];
  for (const p of ps) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(p.y - last.y) < Math.max(2, Math.min(p.h, last.h) * 0.45)) last.parts.push(p);
    else rows.push({ y: p.y, x: p.x, right: p.x + p.w, h: p.h, text: '', parts: [p] });
  }
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x);
    let t = '';
    let prevRight = -1;
    for (const p of r.parts) {
      // 文字片の間が大きく空いていれば空白（絵文字の画像が入っていた場所など）
      if (prevRight >= 0 && p.x - prevRight > p.h * 0.6) t += ' ';
      t += p.str;
      prevRight = p.x + p.w;
    }
    r.text = t.trim();
    r.x = r.parts[0].x;
    r.right = prevRight;
    r.h = Math.max(...r.parts.map((p) => p.h));
  }
  return rows;
}

function mode(nums: number[]): number {
  const m = new Map<number, number>();
  for (const n of nums) {
    const k = Math.round(n * 10) / 10;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

export function postKey(date: string, title: string, body: string): string {
  return `${date}|${foldText(title).replace(/\s+/g, '')}|${foldText(body).replace(/\s+/g, '').slice(0, 30)}`;
}

/** 行のまとまりを本文に戻す。幅いっぱいの行は次の行とつなげ、大きく空いた所は段落の区切りにする */
function joinBody(rows: Row[], colRight: number, bodyH: number): string {
  let out = '';
  rows.forEach((r, i) => {
    if (i > 0) {
      const prev = rows[i - 1];
      const gap = r.y - prev.y;
      if (gap > bodyH * 2.4) out += '\n\n';
      else if (prev.right < colRight - bodyH * 1.6) out += '\n';
    }
    out += r.text;
  });
  return out;
}

export function parseOshiraseList(pieces: TextPiece[], pageHeights: number[] = []): ListParseResult {
  const rows = toRows(pieces);
  const warnings: string[] = [];
  if (!rows.length) return { posts: [], range: null, warnings: ['このPDFには文字が含まれていません'], cutOff: false };
  const bodyH = mode(rows.map((r) => r.h));
  // 本文の右端：本文の位置から始まる行だけで見る（字下げされた添付の行は含めない）
  const bodyX = mode(rows.filter((r) => Math.abs(r.h - bodyH) < 0.2).map((r) => r.x));
  const colRight = Math.max(...rows.filter((r) => Math.abs(r.x - bodyX) < bodyH * 0.5).map((r) => r.right));
  // 行間は文字の高さの約1.5倍（本文）、題名の折り返しは約1.25倍
  const lineGap = bodyH * 1.5;
  const isDate = (r: Row) => DATE_RE.test(r.text.replace(/\s/g, ''));
  const isTag = (r: Row) => r.h < bodyH * 0.9 && !isDate(r) && r.parts.length >= 1 && r.h > bodyH * 0.55;

  const posts: ParsedPost[] = [];
  let date = '';
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (isDate(r)) {
      date = r.text.replace(/\s/g, '');
      i++;
      continue;
    }
    if (!isTag(r)) {
      i++;
      continue;
    }
    // 札：左が園名、右が子どもの名前（子どもの札がない記事もある）
    const school = r.parts[0].str.trim();
    const childName = r.parts.slice(1).map((p) => p.str).join('').trim();
    let j = i + 1;
    while (j < rows.length && !isDate(rows[j]) && !isTag(rows[j])) j++;
    const seg = rows.slice(i + 1, j);
    const yEnd = j < rows.length ? rows[j].y - rows[j].h : Infinity;
    if (seg.length && date) {
      const titleRow = seg[0];
      const x0 = titleRow.x;
      // 長い題名は折り返す。題名の行間は本文より詰まっているので、それで見分ける
      let title = titleRow.text;
      let k0 = 1;
      while (k0 < seg.length && seg[k0].y - seg[k0 - 1].y < lineGap * 0.92 && Math.abs(seg[k0].x - x0) < bodyH * 0.5) title += seg[k0++].text;
      const bodyRows: Row[] = [];
      const attachments: ParsedAttachment[] = [];
      for (let k = k0; k < seg.length; k++) {
        const row = seg[k];
        if (row.x > x0 + bodyH * 0.9) {
          // 添付の行は字下げされている。名前が長いと「(4.7M」「B)」のように折り返す
          let text = '';
          let hit = -1;
          for (let n = 0; n < 3 && k + n < seg.length; n++) {
            text += seg[k + n].text;
            if (ATT_RE.test(text.replace(/\s+\(/, ' ('))) {
              hit = n;
              break;
            }
          }
          if (hit >= 0) {
            const m = ATT_RE.exec(text)!;
            attachments.push({ displayName: m[1].trim(), displaySize: `${m[2]}${m[3]}` });
            k += hit;
            continue;
          }
        }
        bodyRows.push(row);
      }
      let body = joinBody(bodyRows, colRight, bodyH);
      let bodyState: ParsedPost['bodyState'] = 'full';
      const more = /\s*(?:…|\.{3})?\s*もっとみ\s*る\s*$/.exec(body);
      if (more) {
        body = body.slice(0, more.index).trimEnd();
        bodyState = 'truncated';
      } else {
        body = body.replace(/\s*小さくする\s*$/, '').trimEnd();
      }
      posts.push({ date, school, childName, title, body, bodyState, attachments, yStart: r.y - r.h, yEnd, externalKey: postKey(date, title, body) });
    } else if (seg.length && !date) {
      warnings.push('日付の見出しより前にある記事は取り込めません');
    }
    i = j;
  }

  // 1ページだけの縦長PDF（フルページ）は約14400ptで切れる。最後の記事は途中の可能性がある
  const cutOff = pageHeights.length === 1 && pageHeights[0] >= FULLPAGE_LIMIT;
  if (cutOff && posts.length) {
    const last = posts[posts.length - 1];
    if (last.bodyState === 'full') last.bodyState = 'truncated';
    warnings.push(`PDFの長さの上限で途中までになっています。${last.date} より前は、「共有 → オプション → PDF」で保存すると全部入ります。`);
  }
  if (!posts.length) warnings.push('お知らせの記事が見つかりませんでした。お知らせ一覧のPDFか確かめてください');
  const dates = posts.map((p) => p.date).sort();
  return { posts, range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null, warnings, cutOff };
}

/** PDFの題名から、お知らせ一覧のPDFかどうかを見分ける */
export const looksLikeOshiraseList = (title: string | undefined, pieces: TextPiece[]): boolean =>
  /お知らせ/.test(title ?? '') || (!/連絡帳/.test(title ?? '') && toRows(pieces.slice(0, 400)).filter((r) => DATE_RE.test(r.text.replace(/\s/g, ''))).length > 0 && !pieces.slice(0, 400).some((p) => /連絡帳|家庭から|園から/.test(p.str)));

/* ---------- 写真の割り当て ---------- */

export interface PlacedImage {
  /** 通し座標での上端 */
  y: number;
  width: number;
  height: number;
}

/** 写真を、その位置にある記事へ割り当てる。戻り値は記事ごとの画像の番号 */
export function assignImages(posts: ParsedPost[], images: PlacedImage[]): number[][] {
  const out: number[][] = posts.map(() => []);
  images.forEach((im, idx) => {
    const mid = im.y + 1;
    const pi = posts.findIndex((p) => mid >= p.yStart && mid < p.yEnd);
    if (pi >= 0) out[pi].push(idx);
  });
  return out;
}

/* ---------- ジャンルの候補 ---------- */

export interface GenreChoice {
  name: string;
  /** past＝同じ題名で前に選んだ／suggest＝内容からの提案／used＝これまでに使ったジャンル */
  why: 'past' | 'suggest' | 'used';
}

/** 題名から日付や数字・組の名前の違いを除いた形（「今日の給食」「2026年11月【園だより】…」を同じ仲間にする） */
export function titleKey(title: string): string {
  return foldText(title)
    .replace(/[0-9０-９]+\s*(年|月|日|号|歳)?/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '');
}

const RULES: [RegExp, string][] = [
  [/お詫び|訂正|変更|中止|延期/, '訂正・変更'],
  [/給食だより/, '給食だより'],
  [/献立表/, '献立表'],
  [/園だより/, '園だより'],
  [/保健だより|ほけんだより/, '保健だより'],
  [/今日の給食|本日の給食|給食/, '給食'],
  [/欠席|感染|インフル|流行/, '欠席・感染症'],
  [/今日の.*(組|ぐみ|クラス)|組.*(今日|できごと|様子)|活動/, '活動記録'],
  [/運動会|遠足|参観|発表会|懇談|面談|誕生会|避難訓練|ハロウィン|クリスマス|お祭り|行事/, '行事'],
  [/持ち物|提出|締切|申込|お願い/, '持ち物・提出'],
];

/** 内容からのジャンルの提案（先頭ほど有力）。当てはまらなければ「お知らせ」 */
export function suggestGenres(title: string, body = '', hasPdf = false): string[] {
  const t = title.normalize('NFKC');
  const out: string[] = [];
  for (const [re, g] of RULES) if (re.test(t) && !out.includes(g)) out.push(g);
  if (!out.length) {
    const m = /【([^】]{2,12})】/.exec(t);
    if (m) out.push(m[1].split(/[／/]/)[0].trim());
  }
  if (!out.length) {
    // 題名で決まらないときは「お知らせ」（PDF付きは「資料」）を第一候補に、本文からの見立てを次の候補にする
    out.push(hasPdf ? '資料' : 'お知らせ');
    for (const [re, g] of RULES) if (re.test(body.normalize('NFKC').slice(0, 80)) && !out.includes(g)) out.push(g);
  }
  return out.slice(0, 3);
}

/**
 * ボタンで選ぶジャンルの候補。順番は、同じ題名で前に選んだもの → 内容からの提案 → これまでに使ったジャンル。
 */
export function genreChoices(post: { title: string; body: string; hasPdf: boolean }, existing: Pick<Item, 'title' | 'genre'>[]): GenreChoice[] {
  const out: GenreChoice[] = [];
  const add = (name: string, why: GenreChoice['why']) => {
    if (name && !out.some((c) => c.name === name)) out.push({ name, why });
  };
  const key = titleKey(post.title);
  const pastCount = new Map<string, number>();
  const usedCount = new Map<string, number>();
  for (const it of existing) {
    if (!it.genre) continue;
    usedCount.set(it.genre, (usedCount.get(it.genre) ?? 0) + 1);
    if (key && titleKey(it.title) === key) pastCount.set(it.genre, (pastCount.get(it.genre) ?? 0) + 1);
  }
  const byCount = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  for (const g of byCount(pastCount)) add(g, 'past');
  for (const g of suggestGenres(post.title, post.body, post.hasPdf)) add(g, usedCount.has(g) ? 'used' : 'suggest');
  for (const g of byCount(usedCount)) add(g, 'used');
  return out;
}

/* ---------- 添付PDFの照合（保存するとファイル名が失われるため、容量で探す） ---------- */

/** 画面の容量表記（1024単位・小数1桁）に、実際のバイト数が合うか。切り上げ・四捨五入のどちらでも合うように幅を持たせる */
export function sizeMatches(displaySize: string, bytes: number): boolean {
  const m = /^([\d.]+)\s*([KMG]?)B$/i.exec(displaySize.trim());
  if (!m) return false;
  const unit = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G'];
  const v = bytes / unit;
  const shown = Number(m[1]);
  return v > shown - 0.1001 && v < shown + 0.0501;
}

export interface MissingRef {
  itemId: string;
  attachmentId: string;
  displayName: string;
  displaySize: string;
}

/** 保存したファイルの容量から、未保存の添付の候補を探す */
export function matchBySize(bytes: number, missing: MissingRef[]): MissingRef[] {
  return missing.filter((m) => sizeMatches(m.displaySize, bytes));
}

/* ---------- 取り込みの計画（重複させない） ---------- */

export type PostStatus = 'new' | 'same' | 'fuller';
export interface PostPlan {
  status: PostStatus;
  /** 取り込み済みの記録（same / fuller のとき） */
  existingId?: string;
  /** fuller の内訳 */
  betterBody?: boolean;
  morePhotos?: boolean;
}

const savedPhotos = (it: Pick<Item, 'attachments'>) => it.attachments.filter((a) => a.state !== 'missing' && a.mime.startsWith('image/')).length;

/**
 * 取り込み済みの記事と照らして、新規／取り込み済み／より完全（全文になった・写真が増えた）に分ける。
 * 同じPDFの中に同じ記事が2回出てきたら、2回目は取り込み済みとして扱う。
 */
export function planPosts(posts: ParsedPost[], imageCounts: number[], existing: Item[]): PostPlan[] {
  const byKey = new Map<string, Item>();
  for (const it of existing) if (it.source.externalKey) byKey.set(it.source.externalKey, it);
  const seen = new Set<string>();
  return posts.map((p, i) => {
    if (seen.has(p.externalKey)) return { status: 'same' as const };
    seen.add(p.externalKey);
    const ex = byKey.get(p.externalKey);
    if (!ex) return { status: 'new' as const };
    const betterBody = ex.bodyState === 'truncated' && p.bodyState === 'full';
    const morePhotos = (imageCounts[i] ?? 0) > savedPhotos(ex);
    return betterBody || morePhotos ? { status: 'fuller' as const, existingId: ex.id, betterBody, morePhotos } : { status: 'same' as const, existingId: ex.id };
  });
}

/** まだ保存していない添付（名前と容量だけ分かっているもの）の一覧 */
export function missingAttachments(items: Item[]): (MissingRef & { date: string; title: string })[] {
  return items
    .flatMap((it) => it.attachments.filter((a) => a.state === 'missing').map((a) => ({ itemId: it.id, attachmentId: a.id, displayName: a.displayName ?? a.name, displaySize: a.displaySize ?? '', date: it.date, title: it.title })))
    .sort((a, b) => b.date.localeCompare(a.date));
}
