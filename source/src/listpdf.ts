import './polyfill-stream.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractFromPdf } from './pdf.ts';
import { findJpegStreams, type RawJpeg } from './core/pdfjpeg.ts';
import type { ExtractedDoc } from './core/types.ts';
import { CMAPS } from './cmaps.gen.ts';

/**
 * お知らせ一覧のPDFから、文字と写真を取り出す（すべて端末の中で処理する）。
 * 写真は、PDFにそのまま入っているJPEGがあればそのバイト列を使い（元の配信画像と同じファイル）、
 * 形式が変わっているものは描き直してJPEGにする。
 */

export interface ListImage {
  /** 通し座標での上端 */
  y: number;
  width: number;
  height: number;
  blob: Blob;
  provenance: 'listpdf-identical' | 'listpdf-recoded' | 'listpdf-downscaled';
}

export interface ListPdf {
  doc: ExtractedDoc;
  images: ListImage[];
}

const MIN_SIDE = 150; // これより小さい画像（絵文字・アイコン）は写真として扱わない
const SMALL_SIDE = 600; // 配信画像は長辺が約800px。これより小さければ縮小版とみなす

class Factory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const data = kind === 'cMapUrl' ? CMAPS[filename.replace(/\.bcmap$/, '')] : undefined;
    if (!data) throw new Error(`${filename} は同梱していません`);
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: number[]): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCanvas(img: any): HTMLCanvasElement | null {
  const w = img?.width;
  const h = img?.height;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return c;
  }
  if (!img.data) return null;
  const src: Uint8Array | Uint8ClampedArray = img.data;
  const out = ctx.createImageData(w, h);
  const n = w * h;
  if (src.length === n * 4) out.data.set(src);
  else if (src.length === n * 3) for (let i = 0, j = 0; i < n; i++, j += 3) (out.data[i * 4] = src[j]), (out.data[i * 4 + 1] = src[j + 1]), (out.data[i * 4 + 2] = src[j + 2]), (out.data[i * 4 + 3] = 255);
  else return null;
  ctx.putImageData(out, 0, 0);
  return c;
}

/** 8×8に縮めた明るさの並び（同じ絵かどうかを見分けるための指紋） */
function fingerprint(src: CanvasImageSource): number[] {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 8, 8);
  ctx.drawImage(src, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  const out: number[] = [];
  for (let i = 0; i < d.length; i += 4) out.push((d[i] * 3 + d[i + 1] * 4 + d[i + 2]) >> 3);
  return out;
}
const distance = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

async function decode(blob: Blob): Promise<CanvasImageSource | null> {
  try {
    if ('createImageBitmap' in window) return await createImageBitmap(blob);
  } catch {
    /* 下の方法で読む */
  }
  return new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => (URL.revokeObjectURL(url), res(im));
    im.onerror = () => (URL.revokeObjectURL(url), res(null));
    im.src = url;
  });
}

const toJpeg = (c: HTMLCanvasElement) => new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.92));

export async function extractListPdf(file: File, onStep: (s: string) => void = () => {}): Promise<ListPdf> {
  onStep('PDFを読み込んでいます…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // そのまま入っているJPEG（File.slice は範囲を指すだけで、複製しない）
  const raws: (RawJpeg & { used?: boolean; fp?: number[] | null })[] = findJpegStreams(bytes);
  onStep('文字を取り出しています…');
  const doc = await extractFromPdf(bytes.slice());

  const task = pdfjs.getDocument({ data: bytes, cMapUrl: 'bundled/', cMapPacked: true, BinaryDataFactory: Factory, useWorkerFetch: false, isEvalSupported: false } as never);
  const pdf = await task.promise;
  const OPS = pdfjs.OPS;
  const images: ListImage[] = [];
  let offset = 0;
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      onStep(`写真を取り出しています… ${p}/${pdf.numPages}ページ`);
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      let m: Mat = [1, 0, 0, 1, 0, 0];
      const stack: Mat[] = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] as never[];
        if (fn === OPS.save) stack.push(m);
        else if (fn === OPS.restore) m = stack.pop() ?? m;
        else if (fn === OPS.transform) m = mul(m, args as number[]);
        else if (fn === OPS.paintFormXObjectBegin) {
          stack.push(m);
          if (Array.isArray(args?.[0])) m = mul(m, args[0] as number[]);
        } else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() ?? m;
        else if (fn === OPS.paintImageXObject) {
          const id = args[0] as string;
          const [w, h] = [Number(args[1]), Number(args[2])];
          if (Math.max(w, h) < MIN_SIDE) continue;
          const store = id.startsWith('g_') ? page.commonObjs : page.objs;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const img: any = await new Promise((res) => store.get(id, res));
          const canvas = toCanvas(img);
          if (!canvas) continue;
          // 画像の四隅を画面の座標に直して上端を求める
          const ys = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => vp.convertToViewportPoint(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])[1]);
          const y = offset + Math.min(...ys);
          let blob: Blob | null = null;
          let provenance: ListImage['provenance'] = Math.max(w, h) < SMALL_SIDE ? 'listpdf-downscaled' : 'listpdf-recoded';
          const cands = raws.filter((r) => !r.used && r.width === canvas.width && r.height === canvas.height);
          if (cands.length) {
            const fp = fingerprint(canvas);
            let best: (typeof cands)[number] | null = null;
            let bestD = 6; // 明るさの差の平均がこれ未満なら同じ絵とみなす
            for (const r of cands) {
              if (r.fp === undefined) {
                const src = await decode(file.slice(r.start, r.end, 'image/jpeg'));
                r.fp = src ? fingerprint(src) : null;
                if (src && 'close' in src) (src as ImageBitmap).close();
              }
              if (!r.fp) continue;
              const d = distance(fp, r.fp);
              if (d < bestD) (bestD = d), (best = r);
            }
            if (best) {
              best.used = true;
              blob = file.slice(best.start, best.end, 'image/jpeg');
              provenance = 'listpdf-identical';
            }
          }
          blob ??= await toJpeg(canvas);
          canvas.width = canvas.height = 0;
          if (blob) images.push({ y, width: w, height: h, blob, provenance });
        }
      }
      offset += vp.height;
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { doc, images };
}
