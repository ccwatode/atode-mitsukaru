import type { ExtractedDoc, FetchStatus, ParsedRecord, TextPiece } from './types.ts';

/**
 * 「はいチーズ！」連絡帳PDF（ブラウザ表示を1枚の縦長PDFに保存したもの）の解析。
 *
 * サンプルPDFで確認したレイアウト（座標はpt）：
 *   日付見出し      x≈16 / 14pt / "YYYY-MM-DD" 単独行
 *   園児名          x≈88 / 16pt / 見出しの約52pt下
 *   さらに表示      x≈166（未展開の記録はこの行だけ）
 *   先生行          x≈32 / "園名 姓 名先生 より"
 *   本文            x≈32 / 行送り24pt・段落間48pt（第1段落=クラス全体、第2段落以降=個別）
 *   生活記録        ラベル x≈69（登園・降園・睡眠・排泄・昼食・おやつ）／値 x≈137.5
 *   家庭からの連絡  x≈32 の見出しの後に ラベル x≈69（検温・睡眠・排泄・夕食・朝食・連絡）
 *
 * 座標の絶対値には依存せず、「左端の列」「先生行の列」「ラベル列」のように相対位置で判定する。
 * 文字を補ったり要約したりはしない。PDFに無いものは空欄のまま。
 */

export const MORE_LABEL = 'さらに表示';
const HOME_HEADER = '家庭からの連絡';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_START_RE = /^\d{1,2}:\d{2}/;

export interface Row {
  y: number;
  x: number;
  right: number;
  h: number;
  items: TextPiece[];
  text: string;
}

export interface ParseResult {
  records: ParsedRecord[];
  headingCount: number;
  warnings: string[];
  /** PDFの最下端で記録が切れている可能性 */
  truncation: null | {
    /** Safariのフルページ保存の高さ上限（14400pt）に達している */
    atHeightLimit: boolean;
    /** 最後に読めた日付（これより前の日付はPDFに入っていない可能性） */
    lastDate: string;
  };
}

/** PDFの1ページの高さの上限（PDF仕様上の最大 200インチ = 14400pt） */
export const PDF_HEIGHT_LIMIT = 14400;

/* ---------- 行の復元 ---------- */

function joinItems(items: TextPiece[]): string {
  let out = '';
  let prev: TextPiece | null = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > Math.max(2, 0.25 * Math.min(it.h, prev.h))) out += ' ';
    }
    out += it.str;
    prev = it;
  }
  return out.trim();
}

/** 文字片をy座標で行にまとめ、行内はx順に並べる（単純な文字列連結に頼らず位置で読み順を復元） */
export function buildRows(pieces: TextPiece[]): Row[] {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Row[] = [];
  let cur: TextPiece[] = [];
  let curY = -Infinity;
  const flush = () => {
    if (!cur.length) return;
    cur.sort((a, b) => a.x - b.x);
    const x = cur[0].x;
    const right = Math.max(...cur.map((p) => p.x + p.w));
    const h = Math.max(...cur.map((p) => p.h));
    rows.push({ y: curY, x, right, h, items: cur, text: joinItems(cur) });
    cur = [];
  };
  for (const p of sorted) {
    const tol = Math.min(5, Math.max(2, 0.35 * p.h));
    if (cur.length && Math.abs(p.y - curY) <= tol) {
      cur.push(p);
    } else {
      flush();
      cur = [p];
      curY = p.y;
    }
  }
  flush();
  return rows;
}

/* ---------- 日付見出し ---------- */

function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function mode(nums: number[]): number {
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(Math.round(n), (counts.get(Math.round(n)) ?? 0) + 1);
  let best = nums[0];
  let bestC = 0;
  for (const [k, c] of counts) if (c > bestC) [best, bestC] = [k, c];
  return best;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 日付見出しの検出。本文中の日付を誤認しないよう、
 *  - 行に日付だけが単独で置かれている
 *  - 実在する日付である
 *  - 文書の最も左の列（本文より左）にある
 * をすべて満たすものだけを見出しとする。
 */
export function findHeadings(rows: Row[]): Row[] {
  const cands = rows.filter((r) => r.items.length === 1 && isValidDate(r.text.trim()));
  if (!cands.length) return [];
  const leftMost = Math.min(...rows.map((r) => r.x));
  const headX = mode(cands.map((r) => r.x));
  return cands.filter((r) => Math.abs(r.x - headX) <= 4 && r.x <= leftMost + 4);
}

/* ---------- 記録の中身 ---------- */

interface Entry {
  label: string;
  lines: { text: string; width: number; h: number }[];
}

interface Segment {
  heading: Row;
  rows: Row[];
  childName: string;
  hasMore: boolean;
  teacherRow: Row | null;
  bodyX: number;
  bodyRows: Row[];
  lifeRows: Row[];
  homeRows: Row[];
  hasHomeHeader: boolean;
  isLast: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, '');

function splitSegment(heading: Row, rows: Row[], isLast: boolean): Segment {
  let i = 0;
  let childName = '';
  const first = rows[0];
  if (first && first.items.length === 1 && norm(first.text) !== MORE_LABEL && first.y - heading.y < 6 * heading.h && first.x > heading.x) {
    childName = first.text.trim();
    i = 1;
  }
  const hasMore = rows.some((r) => norm(r.text) === MORE_LABEL);
  let teacherIdx = -1;
  for (let k = i; k < Math.min(rows.length, i + 3); k++) {
    if (/より$/.test(rows[k].text.trim()) && rows[k].items.length >= 2) {
      teacherIdx = k;
      break;
    }
  }
  const teacherRow = teacherIdx >= 0 ? rows[teacherIdx] : null;
  const homeIdx = rows.findIndex((r) => norm(r.text) === HOME_HEADER);
  const contentStart = teacherIdx >= 0 ? teacherIdx + 1 : i;
  const contentRows = rows.slice(contentStart, homeIdx >= 0 ? homeIdx : rows.length).filter((r) => norm(r.text) !== MORE_LABEL);
  const bodyX = teacherRow ? teacherRow.x : contentRows.length ? Math.min(...contentRows.map((r) => r.x)) : heading.x;

  // 本文＝本文列から始まる行（ラベル列は本文列より右にインデントされている）
  const bodyRows: Row[] = [];
  let k = 0;
  while (k < contentRows.length && Math.abs(contentRows[k].x - bodyX) <= 4) bodyRows.push(contentRows[k++]);
  const lifeRows = contentRows.slice(k);
  const homeRows = homeIdx >= 0 ? rows.slice(homeIdx + 1).filter((r) => norm(r.text) !== MORE_LABEL) : [];
  return { heading, rows, childName, hasMore, teacherRow, bodyX, bodyRows, lifeRows, homeRows, hasHomeHeader: homeIdx >= 0, isLast };
}

function toEntries(rows: Row[]): Entry[] {
  if (!rows.length) return [];
  const labelX = Math.min(...rows.map((r) => r.x));
  const entries: Entry[] = [];
  for (const r of rows) {
    if (Math.abs(r.x - labelX) <= 4) {
      const [labelItem, ...rest] = r.items;
      const valueX = rest.length ? rest[0].x : r.right;
      entries.push({ label: labelItem.str.trim(), lines: rest.length ? [{ text: joinItems(rest), width: r.right - valueX, h: r.h }] : [] });
    } else {
      const line = { text: r.text, width: r.right - r.x, h: r.h };
      if (!entries.length) entries.push({ label: '', lines: [] });
      entries[entries.length - 1].lines.push(line);
    }
  }
  return entries;
}

/** 折り返し行をつなぎ、意図的な改行は残す。行幅が列幅に近ければ折り返しとみなす */
function joinLines(lines: { text: string; width: number; h: number }[], colWidth: number, breakIfTimeStart = false): string {
  let out = '';
  lines.forEach((ln, idx) => {
    if (idx === 0) {
      out = ln.text;
      return;
    }
    const prev = lines[idx - 1];
    const wrapped = colWidth > 0 && prev.width >= colWidth - 2 * prev.h && !(breakIfTimeStart && TIME_START_RE.test(ln.text));
    if (wrapped) {
      const needSpace = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(ln.text);
      out += (needSpace ? ' ' : '') + ln.text;
    } else {
      out += '\n' + ln.text;
    }
  });
  return out;
}

/** 列幅の代表値：長い行（最大の7割以上）の中央値。禁則処理で少し短い行に引きずられない */
function typicalWidth(widths: number[]): number {
  if (!widths.length) return 0;
  const max = Math.max(...widths);
  return median(widths.filter((w) => w >= 0.7 * max));
}

function paragraphs(rows: Row[], bodyX: number, colWidth: number): string[] {
  if (!rows.length) return [];
  const gaps = rows.slice(1).map((r, i) => r.y - rows[i].y);
  // 行送りは文字サイズの約1.5倍。行数が少ないと中央値が段落間隔になるので上限を設ける
  const lineGap = Math.min(median(gaps) || Infinity, rows[0].h * 1.6);
  const paras: Row[][] = [[rows[0]]];
  rows.slice(1).forEach((r, i) => {
    if (gaps[i] > lineGap * 1.5) paras.push([r]);
    else paras[paras.length - 1].push(r);
  });
  return paras.map((p) => joinLines(p.map((r) => ({ text: r.text, width: r.right - bodyX, h: r.h })), colWidth)).filter((t) => t.trim());
}

const LIFE_FIELD: Record<string, 'attendance' | 'sleep' | 'toilet' | 'meal'> = {
  登園: 'attendance',
  降園: 'attendance',
  睡眠: 'sleep',
  午睡: 'sleep',
  排泄: 'toilet',
  昼食: 'meal',
  おやつ: 'meal',
  朝食: 'meal',
  夕食: 'meal',
  食事: 'meal',
  ミルク: 'meal',
  給食: 'meal',
};

/* ---------- 本体 ---------- */

export function parseNotebook(doc: ExtractedDoc): ParseResult {
  const warnings: string[] = [];
  const rows = buildRows(doc.pieces);
  const headings = findHeadings(rows);
  if (!headings.length) {
    warnings.push('日付見出し（YYYY-MM-DD）が見つかりませんでした。対応していない形式のPDFの可能性があります。');
    return { records: [], headingCount: 0, warnings, truncation: null };
  }
  const dateLike = rows.filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.text)).length;
  if (dateLike > headings.length) warnings.push(`見出し以外の位置に日付らしい文字列が${dateLike - headings.length}件ありました（本文中の日付として扱いました）。`);

  const segments: Segment[] = headings.map((h, idx) => {
    const next = headings[idx + 1];
    const segRows = rows.filter((r) => r.y > h.y && (!next || r.y < next.y));
    return splitSegment(h, segRows, idx === headings.length - 1);
  });

  // 列幅は文書全体から求める（記録1件だけだと行数が少なくて不安定なため）
  const bodyWidth = typicalWidth(segments.flatMap((s) => s.bodyRows.map((r) => r.right - s.bodyX)));
  const allEntries = segments.map((s) => ({ life: toEntries(s.lifeRows), home: toEntries(s.homeRows) }));
  const valueWidth = typicalWidth(allEntries.flatMap((e) => [...e.life, ...e.home].flatMap((en) => en.lines.map((l) => l.width))));

  const seen = new Map<string, number>();
  const records: ParsedRecord[] = segments.map((s, idx) => {
    const date = s.heading.text.trim();
    const paras = paragraphs(s.bodyRows, s.bodyX, bodyWidth);
    const fields = { attendance: [] as string[], sleep: [] as string[], toilet: [] as string[], meal: [] as string[], otherLife: [] as string[] };
    for (const en of allEntries[idx].life) {
      const value = joinLines(en.lines, valueWidth, true);
      const f = LIFE_FIELD[en.label];
      if (f === 'sleep' || f === 'toilet') fields[f].push(value);
      else if (f) fields[f].push(`${en.label} ${value}`.trim());
      else fields.otherLife.push(`${en.label} ${value}`.trim());
    }
    let homeMessage = '';
    const homeRecord: string[] = [];
    for (const en of allEntries[idx].home) {
      const value = joinLines(en.lines, valueWidth, true);
      if (en.label === '連絡') homeMessage = homeMessage ? `${homeMessage}\n${value}` : value;
      else homeRecord.push(`${en.label} ${value}`.trim());
    }

    let schoolName = '';
    let teacher = '';
    if (s.teacherRow) {
      const parts = s.teacherRow.items.map((it) => it.str.trim()).filter(Boolean);
      if (parts[parts.length - 1] === 'より') parts.pop();
      else parts[parts.length - 1] = parts[parts.length - 1].replace(/より$/, '').trim();
      if (parts.length >= 2) {
        schoolName = parts[0];
        teacher = parts.slice(1).join(' ');
      } else {
        teacher = parts.join(' ');
      }
    }

    const hasBody = paras.length > 0 || allEntries[idx].life.length > 0 || allEntries[idx].home.length > 0;
    const lastRow = s.rows[s.rows.length - 1] ?? s.heading;
    const reachesEnd = s.isLast && lastRow.y > doc.totalHeight - 4 * lastRow.h;
    let fetchStatus: FetchStatus;
    const reasons: string[] = [];
    if (s.hasMore && !hasBody) {
      fetchStatus = '未取得';
      reasons.push('「さらに表示」が残っており、本文がPDFに含まれていません');
    } else if (!hasBody) {
      fetchStatus = '要確認';
      reasons.push('本文が見つかりません');
    } else {
      if (s.hasMore) reasons.push('本文がありますが「さらに表示」も残っています');
      if (reachesEnd) reasons.push('PDFの最下端で記録が途切れている可能性があります');
      if (!s.teacherRow) reasons.push('先生の署名行（〜より）が見つかりません');
      if (!paras.length) reasons.push('先生からの連絡本文が見つかりません');
      if (!s.hasHomeHeader) reasons.push('「家庭からの連絡」欄が見つかりません');
      fetchStatus = reasons.length ? '要確認' : '取得済み';
      if (!reasons.length) reasons.push('先生からの連絡・生活記録・家庭からの連絡を確認できました');
    }

    let id = `${date}_${s.childName}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) {
      id = `${id}_${n}`;
      warnings.push(`${date} の見出しが同じPDF内に複数ありました（${n}件目を別記録として保存）。`);
    }

    return {
      id,
      date,
      childName: s.childName,
      schoolName,
      teacher,
      classNote: paras[0] ?? '',
      personalComment: paras.slice(1).join('\n\n'),
      attendance: fields.attendance.join('\n'),
      sleep: fields.sleep.join('\n'),
      toilet: fields.toilet.join('\n'),
      meal: fields.meal.join('\n'),
      otherLife: fields.otherLife.join('\n'),
      homeMessage,
      homeRecord: homeRecord.join('\n'),
      rawText: [s.heading, ...s.rows].map((r) => r.text).join('\n'),
      fetchStatus,
      statusReason: reasons.join('／'),
    };
  });

  // 切れの判定：最後の記録がPDFの最下端まで続いている
  let truncation: ParseResult['truncation'] = null;
  const lastSeg = segments[segments.length - 1];
  const lastRow = lastSeg.rows[lastSeg.rows.length - 1] ?? lastSeg.heading;
  if (lastRow.y > doc.totalHeight - 4 * lastRow.h) {
    const atHeightLimit = (doc.pageHeights ?? [doc.totalHeight]).some((h) => h >= PDF_HEIGHT_LIMIT - 10);
    const lastDate = lastSeg.heading.text.trim();
    truncation = { atHeightLimit, lastDate };
    warnings.push(
      `${atHeightLimit ? 'PDFが高さの上限（14400pt）に達し、' : 'PDFの'}最下端で記録が途切れています。` +
        `${lastDate} の記録は途中までで、それより前の日付はこのPDFに入っていない可能性があります。` +
        `${lastDate} 以前の記録は、連絡帳アプリでその日付まで表示を進めてから別のPDFに保存し、追加してください。`,
    );
  }

  return { records, headingCount: headings.length, warnings, truncation };
}
