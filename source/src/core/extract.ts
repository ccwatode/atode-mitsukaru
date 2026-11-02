import type { ExtractedDoc, TextPiece } from './types.ts';

/**
 * PDF.jsのテキスト抽出で文字片と座標を取り出す。
 * ページを画像化しないので、14400ptのような極端に縦長のPDFでもメモリを食わない。
 * pdfjsモジュールは呼び出し側から渡す（ブラウザ版とNode版で同じ処理を使うため）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractPieces(pdfjs: any, data: Uint8Array, opts: { cMapUrl?: string; standardFontDataUrl?: string } = {}): Promise<ExtractedDoc> {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: opts.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: opts.standardFontDataUrl,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const pieces: TextPiece[] = [];
  const pageHeights: number[] = [];
  const pageCount: number = doc.numPages;
  let offset = 0;
  try {
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      for (const it of tc.items as Array<{ str?: string; transform: number[]; width: number; height: number }>) {
        if (typeof it.str !== 'string' || it.str.trim() === '') continue;
        const [, , c, d, e, f] = it.transform;
        const h = it.height || Math.hypot(c, d);
        pieces.push({ str: it.str, x: e, y: offset + (vp.height - f), w: it.width, h, page: p });
      }
      offset += vp.height;
      pageHeights.push(vp.height);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { pieces, totalHeight: offset, pageCount, pageHeights };
}
