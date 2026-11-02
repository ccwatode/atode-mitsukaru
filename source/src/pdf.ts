import './polyfill-stream.js';
// PDF.js（legacy版：古めのiOS Safariでも動くようポリフィル込み）
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CMAPS } from './cmaps.gen.ts';
import { extractPieces } from './core/extract.ts';
import type { ExtractedDoc } from './core/types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.js', document.baseURI).href;

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 日本語フォントの文字コード表（CMap）はアプリに同梱し、ネットワークから取得しない。
 * 同梱外のCMapが必要なPDFでは、その旨のエラーになる。
 */
class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (kind === 'cMapUrl') {
      const name = filename.replace(/\.bcmap$/, '');
      const data = CMAPS[name];
      if (data) return b64(data);
      throw new Error(`このPDFの文字コード表（${name}）に対応していません`);
    }
    throw new Error(`${kind} は同梱していません`);
  }
}

export async function extractFromPdf(data: Uint8Array): Promise<ExtractedDoc> {
  const shim = {
    ...pdfjs,
    getDocument: (src: Record<string, unknown>) =>
      pdfjs.getDocument({ ...src, cMapUrl: 'bundled/', cMapPacked: true, BinaryDataFactory: BundledBinaryDataFactory, useWorkerFetch: false } as never),
  };
  return extractPieces(shim, data);
}

/** PDFの1ページ目を小さく描画（添付のサムネイル用）。巨大な縦長PDFも幅基準なので軽い */
export async function renderPdfFirstPage(data: Uint8Array, maxWidth: number): Promise<HTMLCanvasElement> {
  const task = pdfjs.getDocument({ data, cMapUrl: 'bundled/', cMapPacked: true, BinaryDataFactory: BundledBinaryDataFactory, useWorkerFetch: false, isEvalSupported: false } as never);
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = maxWidth / vp0.width;
    // 縦長すぎるページは上の部分だけ（縦横比 1:1.6 まで）
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(Math.min(vp.height, vp.width * 1.6));
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas } as never).promise;
    return canvas;
  } finally {
    await task.destroy();
  }
}
