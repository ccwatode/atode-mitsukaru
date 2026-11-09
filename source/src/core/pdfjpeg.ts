/**
 * PDFの中に、変換されずにそのまま入っているJPEG画像を探す。
 * Safariが作るPDFは、ページ内の写真（JPEG）を多くの場合そのまま埋め込むので、
 * その範囲のバイト列を取り出せば、元サービスが配信した画像と同じファイルになる。
 * PDFの構造を全部読むことはせず、画像の辞書（/DCTDecode）と直後の stream だけを見る。
 */

export interface RawJpeg {
  /** JPEGデータの開始・終了位置（終了は含まない） */
  start: number;
  end: number;
  width: number;
  height: number;
}

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const DCT = enc('/DCTDecode');
const STREAM = enc('stream');
const ENDSTREAM = enc('endstream');
const DICT_OPEN = enc('<<');

function indexOf(data: Uint8Array, pat: Uint8Array, from: number, to = data.length): number {
  const first = pat[0];
  const last = to - pat.length;
  outer: for (let i = from; i <= last; i++) {
    if (data[i] !== first) continue;
    for (let j = 1; j < pat.length; j++) if (data[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOf(data: Uint8Array, pat: Uint8Array, from: number, min: number): number {
  for (let i = from; i >= min; i--) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) if (data[i + j] !== pat[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

const latin1 = (data: Uint8Array, a: number, b: number) => String.fromCharCode(...data.subarray(a, b));

export function findJpegStreams(data: Uint8Array): RawJpeg[] {
  const out: RawJpeg[] = [];
  let pos = 0;
  for (;;) {
    const hit = indexOf(data, DCT, pos);
    if (hit < 0) break;
    pos = hit + DCT.length;
    const s = indexOf(data, STREAM, pos, Math.min(data.length, pos + 400));
    if (s < 0) continue;
    const dictStart = lastIndexOf(data, DICT_OPEN, hit, Math.max(0, hit - 800));
    if (dictStart < 0) continue;
    const dict = latin1(data, dictStart, s);
    // ほかの圧縮と重ねてある画像は、そのままではJPEGにならないので対象外
    if (/FlateDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode/.test(dict) || !/\/Subtype\s*\/Image/.test(dict)) continue;
    const w = /\/Width\s+(\d+)/.exec(dict);
    const h = /\/Height\s+(\d+)/.exec(dict);
    if (!w || !h) continue;
    let start = s + STREAM.length;
    if (data[start] === 0x0d) start++;
    if (data[start] === 0x0a) start++;
    if (data[start] !== 0xff || data[start + 1] !== 0xd8) continue;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let end = len ? start + Number(len[1]) : -1;
    if (end < 0 || end > data.length || indexOf(data, ENDSTREAM, end, Math.min(data.length, end + 16)) < 0) {
      const e = indexOf(data, ENDSTREAM, start);
      if (e < 0) continue;
      end = e;
      while (end > start && (data[end - 1] === 0x0a || data[end - 1] === 0x0d)) end--;
    }
    out.push({ start, end, width: Number(w[1]), height: Number(h[1]) });
    pos = end;
  }
  return out;
}
