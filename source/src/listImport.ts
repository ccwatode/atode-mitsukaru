import * as db from './db.ts';
import { processImage, processPdf } from './media.ts';
import { classifyPurposes } from './core/migrate.ts';
import { newId } from './core/textutil.ts';
import type { ParsedPost, PostPlan } from './core/oshirase.ts';
import type { AttachmentRef, Item } from './core/types.ts';
import type { ListImage } from './listpdf.ts';
import type { BlobRow } from './db.ts';

export interface PostChoice {
  action: 'add' | 'update' | 'skip';
  genre: string;
}

export interface ListImportResult {
  added: number;
  updated: number;
  photos: number;
  missingPdfs: number;
  failed: string[];
}

async function photoRefs(post: ParsedPost, imgs: ListImage[]): Promise<{ refs: AttachmentRef[]; blobs: BlobRow[] }> {
  const refs: AttachmentRef[] = [];
  const blobs: BlobRow[] = [];
  for (let n = 0; n < imgs.length; n++) {
    const im = imgs[n];
    const file = new File([im.blob], `${post.date}_${post.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24)}_${n + 1}.jpg`, { type: 'image/jpeg' });
    const p = await processImage(file, true);
    if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
    refs.push({ ...p.ref, role: 'photo', provenance: im.provenance, state: 'saved' });
    blobs.push(...p.blobs);
  }
  return { refs, blobs };
}

/**
 * 確認画面で選んだ記事を保存する。1件ごとに記事と写真をまとめて書き込むので、
 * 途中で止まっても記事が半端な状態で残らない（もう一度取り込めば、済んだ分は重複しない）。
 * stamp：家族・子ども・版番号などを付ける（画面側から渡す）
 */
export async function commitListImport(
  a: { fileName: string; posts: ParsedPost[]; images: ListImage[]; assign: number[][]; plan: PostPlan[]; choices: PostChoice[]; existing: Map<string, Item>; stamp: (it: Item) => Promise<Item> },
  onStep: (s: string) => void,
): Promise<ListImportResult> {
  const res: ListImportResult = { added: 0, updated: 0, photos: 0, missingPdfs: 0, failed: [] };
  const todo = a.posts.map((_, i) => i).filter((i) => a.choices[i].action !== 'skip');
  for (let n = 0; n < todo.length; n++) {
    const i = todo[n];
    const post = a.posts[i];
    const now = new Date().toISOString();
    onStep(`保存しています… ${n + 1}/${todo.length}件`);
    try {
      const imgs = a.assign[i].map((k) => a.images[k]);
      if (a.choices[i].action === 'add') {
        const { refs, blobs } = await photoRefs(post, imgs);
        const missing: AttachmentRef[] = post.attachments.map((m) => ({ id: newId('at'), name: m.displayName, mime: /\.pdf$/i.test(m.displayName) ? 'application/pdf' : 'application/octet-stream', size: 0, variants: [], displayName: m.displayName, displaySize: m.displaySize, state: 'missing', role: 'document' }));
        const item: Item = {
          id: newId('it'), kind: 'notice', date: post.date, title: post.title, body: post.body, searchText: '', childName: post.childName, event: '',
          attachments: [...refs, ...missing],
          source: { via: 'listpdf', fileNames: [a.fileName], service: 'haicheese', externalKey: post.externalKey },
          createdAt: now, updatedAt: now, importedAt: now,
          genre: a.choices[i].genre, origin: 'oshirase', bodyState: post.bodyState, status: 'filed',
          purposes: classifyPurposes(post.title, 'notice', post.body), history: [],
        };
        await db.saveItem(await a.stamp(item), blobs);
        res.added++;
        res.photos += refs.length;
        res.missingPdfs += missing.length;
      } else {
        const ex = a.existing.get(a.plan[i].existingId ?? '');
        if (!ex) continue;
        const fields: string[] = [];
        let next: Item = { ...ex };
        if (a.plan[i].betterBody) {
          next = { ...next, body: post.body, bodyState: 'full' };
          fields.push('body');
        }
        let blobs: BlobRow[] = [];
        let drop: string[] = [];
        if (a.plan[i].morePhotos) {
          // 一覧PDFから入れた写真だけを入れ替える（自分で足した写真や保存済みのPDFには触れない）
          const old = ex.attachments.filter((x) => x.provenance?.startsWith('listpdf'));
          const made = await photoRefs(post, imgs);
          blobs = made.blobs;
          drop = old.flatMap((x) => x.variants.map((v) => `${x.id}:${v}`));
          next = { ...next, attachments: [...made.refs, ...ex.attachments.filter((x) => !old.includes(x))] };
          fields.push('attachments');
          res.photos += made.refs.length;
        }
        next = { ...next, updatedAt: now, rev: (ex.rev ?? 1) + 1, history: [...(ex.history ?? []), { at: now, by: ex.createdBy ?? '', fields }] };
        await db.saveItem(next, blobs);
        if (drop.length) await db.write([{ store: 'blobs', del: drop }]);
        res.updated++;
      }
    } catch (e) {
      res.failed.push(`${post.date} ${post.title}：${(e as Error).message}`);
    }
  }
  return res;
}

/** 保存したPDF（や画像）を、未保存だった添付の場所に入れる。名前は元サービス上の表示名に戻す */
export async function fillAttachment(item: Item, attachmentId: string, file: File): Promise<Item> {
  const idx = item.attachments.findIndex((x) => x.id === attachmentId);
  if (idx < 0) throw new Error('添付が見つかりません');
  const old = item.attachments[idx];
  const p = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? await processPdf(file) : await processImage(file, true);
  if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  const ref: AttachmentRef = { ...p.ref, name: old.displayName ?? file.name, displayName: old.displayName, displaySize: old.displaySize, state: 'saved', provenance: 'single', role: 'document' };
  const now = new Date().toISOString();
  const next: Item = { ...item, attachments: item.attachments.map((x, i) => (i === idx ? ref : x)), updatedAt: now, rev: (item.rev ?? 1) + 1, history: [...(item.history ?? []), { at: now, by: item.createdBy ?? '', fields: ['attachments'] }] };
  await db.saveItem(next, p.blobs);
  return next;
}
