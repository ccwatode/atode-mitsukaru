import type { AttachmentRef } from './core/types.ts';
import { exifDate, newId } from './core/textutil.ts';
import type { BlobRow } from './db.ts';

/**
 * 画像の保存方針（容量と見やすさのバランス）
 *  - 表示用 view：長辺2560px・JPEG。チラシの文字も読める大きさ。拡大表示にも使う
 *  - サムネイル thumb：長辺400px。一覧・ホームで使う
 *  - 原本 orig：設定で「原本も保存」をオンにしたときだけ（写真1枚あたり数MB増える）
 *  PDFは原本のみ（＋1ページ目のサムネイル）
 */
export const VIEW_MAX = 2560;
export const THUMB_MAX = 400;

export interface ProcessedFile {
  ref: AttachmentRef;
  blobs: BlobRow[];
  /** 画面のプレビュー用 */
  thumbUrl?: string;
  /** PDFに埋め込まれた文字（検索・予定の取り出し用）。画像だけのPDFや読み取り失敗時は空 */
  text?: string;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

function toJpeg(img: HTMLImageElement | HTMLCanvasElement, w: number, h: number, max: number, q: number): Promise<{ blob: Blob; w: number; h: number }> {
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; // 透過PNGを白背景に
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => {
      c.width = c.height = 0; // iOSのキャンバスメモリを早めに解放
      if (b) resolve({ blob: b, w: cw, h: ch });
      else reject(new Error('画像の変換に失敗しました'));
    }, 'image/jpeg', q),
  );
}

export async function processImage(file: File, keepOriginal: boolean): Promise<ProcessedFile> {
  const id = newId('at');
  const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
  const takenAt = exifDate(head) ?? undefined;
  const blobs: BlobRow[] = [];
  const variants: AttachmentRef['variants'] = [];
  let width: number | undefined;
  let height: number | undefined;
  let thumbUrl: string | undefined;
  try {
    const img = await loadImage(file);
    width = img.naturalWidth;
    height = img.naturalHeight;
    const view = await toJpeg(img, width, height, VIEW_MAX, 0.85);
    const thumb = await toJpeg(img, width, height, THUMB_MAX, 0.75);
    blobs.push({ key: `${id}:view`, mime: 'image/jpeg', size: view.blob.size, blob: view.blob });
    blobs.push({ key: `${id}:thumb`, mime: 'image/jpeg', size: thumb.blob.size, blob: thumb.blob });
    variants.push('view', 'thumb');
    thumbUrl = URL.createObjectURL(thumb.blob);
  } catch {
    // 表示できない形式は原本だけ保存する
    keepOriginal = true;
  }
  if (keepOriginal) {
    blobs.push({ key: `${id}:orig`, mime: file.type || 'application/octet-stream', size: file.size, blob: file });
    variants.push('orig');
  }
  return {
    ref: { id, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, width, height, variants, takenAt },
    blobs,
    thumbUrl,
  };
}

export async function processPdf(file: File): Promise<ProcessedFile> {
  const id = newId('at');
  const blobs: BlobRow[] = [{ key: `${id}:orig`, mime: 'application/pdf', size: file.size, blob: file }];
  const variants: AttachmentRef['variants'] = ['orig'];
  let thumbUrl: string | undefined;
  let text = '';
  try {
    const { extractFromPdf } = await import('./pdf.ts');
    const { piecesToText } = await import('./core/textutil.ts');
    text = piecesToText((await extractFromPdf(new Uint8Array(await file.arrayBuffer()))).pieces);
  } catch {
    /* 文字なしで続行 */
  }
  try {
    const { renderPdfFirstPage } = await import('./pdf.ts');
    const canvas = await renderPdfFirstPage(new Uint8Array(await file.arrayBuffer()), THUMB_MAX);
    const thumb = await toJpeg(canvas, canvas.width, canvas.height, THUMB_MAX, 0.75);
    blobs.push({ key: `${id}:thumb`, mime: 'image/jpeg', size: thumb.blob.size, blob: thumb.blob });
    variants.push('thumb');
    thumbUrl = URL.createObjectURL(thumb.blob);
  } catch {
    /* サムネイルなしで続行 */
  }
  return { ref: { id, name: file.name, mime: 'application/pdf', size: file.size, variants }, blobs, thumbUrl, text };
}

export const processFile = (f: File, keepOriginal: boolean) =>
  f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? processPdf(f) : processImage(f, keepOriginal);

/** 添付の表示に使う版（表示用→原本→サムネイルの順） */
export function bestVariant(a: AttachmentRef, want: 'thumb' | 'view'): string | null {
  const order = want === 'thumb' ? (['thumb', 'view', 'orig'] as const) : (['view', 'orig', 'thumb'] as const);
  const v = order.find((x) => a.variants.includes(x));
  if (!v) return null;
  if (v === 'orig' && !a.mime.startsWith('image/')) return want === 'thumb' ? null : `${a.id}:orig`;
  return `${a.id}:${v}`;
}
