/**
 * 取り込み時の入力を減らすための小さな推定。どれも「初期値の提案」で、利用者が直せる。
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function valid(y: number, m: number, d: number): boolean {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * 貼り付けた文章の中から最初の日付らしい表記を探す。
 * 「2026年11月3日」「2026/11/3」「11月3日」「11/3（月）」に対応。年がなければ基準日の年
 * （基準日より半年以上先なら前年）とする。
 */
export function findDateInText(text: string, base = new Date()): string | null {
  const t = text.normalize('NFKC');
  const full = /(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})/.exec(t);
  if (full) {
    const [y, m, d] = [+full[1], +full[2], +full[3]];
    if (valid(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
  }
  const md = /(?<![\d/])(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?/.exec(t);
  if (md) {
    const [m, d] = [+md[1], +md[2]];
    let y = base.getFullYear();
    if (valid(y, m, d)) {
      const cand = new Date(y, m - 1, d);
      if (cand.getTime() - base.getTime() > 183 * 864e5) y -= 1;
      if (valid(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
    }
  }
  return null;
}

/** 貼り付けた文章からタイトル候補（最初の空でない行、40文字まで） */
export function titleFromText(text: string): string {
  const line = (text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '')
    // 見出しの後ろに続く発行日（「【〇〇のお知らせ】2026年10月1日」）は外す
    .replace(/[\s　]*(?:20\d{2}\s*[年/.-]\s*)?\d{1,2}\s*[月/.-]\s*\d{1,2}\s*日?(?:\s*[(（][^)）]{1,4}[)）])?\s*$/, '')
    .trim();
  return line.length > 40 ? line.slice(0, 40) + '…' : line;
}

/** ファイル名から拡張子と日付っぽい連番を除いたタイトル候補 */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/^(IMG|DSC|PXL|image)[-_ ]?\d*$/i, '').trim();
}

/**
 * JPEGのEXIFから撮影日時（DateTimeOriginal、なければDateTime）を読む。
 * 画像を開かずに先頭64KBだけ見る。見つからなければ null。
 */
export function exifDate(head: Uint8Array): string | null {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 4 || dv.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 < head.length) {
    const marker = dv.getUint16(p);
    const len = dv.getUint16(p + 2);
    if (marker === 0xffe1 && p + 10 < head.length && dv.getUint32(p + 4) === 0x45786966) {
      const tiff = p + 10;
      const le = dv.getUint16(tiff) === 0x4949;
      const u16 = (o: number) => dv.getUint16(o, le);
      const u32 = (o: number) => dv.getUint32(o, le);
      const readIfd = (off: number): Map<number, number> => {
        const tags = new Map<number, number>();
        const base = tiff + off;
        if (base + 2 > head.length) return tags;
        const n = u16(base);
        for (let i = 0; i < n; i++) {
          const e = base + 2 + i * 12;
          if (e + 12 > head.length) break;
          tags.set(u16(e), e);
        }
        return tags;
      };
      const ascii = (entry: number): string | null => {
        const count = u32(entry + 4);
        const off = count > 4 ? tiff + u32(entry + 8) : entry + 8;
        if (off + count > head.length) return null;
        return String.fromCharCode(...head.subarray(off, off + count)).replace(/\0.*$/, '');
      };
      const ifd0 = readIfd(u32(tiff + 4));
      let raw: string | null = null;
      const exifPtr = ifd0.get(0x8769);
      if (exifPtr !== undefined) {
        const exif = readIfd(u32(exifPtr + 8));
        const dto = exif.get(0x9003);
        if (dto !== undefined) raw = ascii(dto);
      }
      if (!raw && ifd0.get(0x0132) !== undefined) raw = ascii(ifd0.get(0x0132)!);
      const m = raw && /^(\d{4}):(\d{2}):(\d{2})/.exec(raw);
      return m && valid(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
    }
    if (marker === 0xffda || len < 2) break;
    p += 2 + len;
  }
  return null;
}

export function newId(prefix: string): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${r}`;
}

/** PDFの文字片を行ごとの文章に戻す（文字が埋め込まれたPDFのみ。画像だけのPDFは空になる） */
export function piecesToText(pieces: { str: string; x: number; y: number; h: number }[], limit = 20000): string {
  const ps = pieces.filter((p) => p.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; h: number; parts: { x: number; s: string }[] }[] = [];
  for (const p of ps) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(p.y - last.y) < Math.max(2, Math.min(p.h, last.h) * 0.5)) last.parts.push({ x: p.x, s: p.str });
    else lines.push({ y: p.y, h: p.h, parts: [{ x: p.x, s: p.str }] });
  }
  const text = lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim()).join('\n');
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * PDFの文字に混ざる「部首用の文字」（⽇ U+2F47 など。見た目は同じで別の文字）を、ふつうの漢字に直す。
 * そのままだと検索や日付の読み取りに掛からない。全角の記号などは変えない。
 */
export function fixRadicals(s: string): string {
  return s.replace(/[\u2E80-\u2FDF]/g, (c) => c.normalize('NFKC'));
}
