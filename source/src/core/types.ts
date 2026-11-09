/** 取得状態：PDFから本文が取れているか */
export type FetchStatus = '取得済み' | '要確認' | '未取得';
/** 確認・修正状態：利用者が目で確認・修正したか */
export type ReviewStatus = '未確認' | '確認済み' | '修正済み';

export interface SourceRef {
  fileName: string;
  fileHash: string;
  importedAt: string;
}

export interface NoteRecord {
  /** `${date}_${childName}` */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  childName: string;
  schoolName: string;
  teacher: string;
  /** 園からの連絡本文（クラス全体の様子。先生欄の第1段落） */
  classNote: string;
  /** 個別コメント（第2段落以降） */
  personalComment: string;
  /** 登降園 */
  attendance: string;
  sleep: string;
  toilet: string;
  /** 食事（昼食・おやつ等） */
  meal: string;
  /** 上記に当てはまらない園の生活記録（取りこぼし防止） */
  otherLife: string;
  /** 家庭からの連絡：「連絡」欄の本文 */
  homeMessage: string;
  /** 家庭からの連絡：検温・睡眠・排泄・食事などの記録 */
  homeRecord: string;
  /** 元の抽出テキスト（読み順に復元した原文。編集不可） */
  rawText: string;
  sources: SourceRef[];
  fetchStatus: FetchStatus;
  /** 取得状態の判定理由 */
  statusReason: string;
  reviewStatus: ReviewStatus;
  /** 利用者が編集した項目名 */
  editedFields: string[];
  updatedAt: string;
}

/** 解析直後の記録（保存前） */
export type ParsedRecord = Omit<NoteRecord, 'sources' | 'reviewStatus' | 'editedFields' | 'updatedAt'>;

/** PDF.jsから取り出した文字片（座標は文書全体での上からの位置, pt） */
export interface TextPiece {
  str: string;
  x: number;
  /** ベースラインの上端からの距離（ページを縦に連結した通し座標） */
  y: number;
  w: number;
  h: number;
  page: number;
}

export interface ExtractedDoc {
  pieces: TextPiece[];
  /** 全ページの高さ合計 */
  totalHeight: number;
  pageCount: number;
  /** 各ページの高さ（pt）。切れの判定に使う */
  pageHeights?: number[];
}

/** 利用者が編集できる項目 */
export const EDITABLE_FIELDS = [
  'classNote',
  'personalComment',
  'attendance',
  'sleep',
  'toilet',
  'meal',
  'otherLife',
  'homeMessage',
  'homeRecord',
  'teacher',
  'schoolName',
  'childName',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const FIELD_LABELS: Record<string, string> = {
  date: '日付',
  childName: '園児名',
  schoolName: '園名',
  teacher: '担当教諭',
  classNote: '先生からの連絡',
  personalComment: '個別コメント',
  attendance: '登降園',
  sleep: '睡眠',
  toilet: '排泄',
  meal: '食事',
  otherLife: 'その他の記録',
  homeMessage: '家庭からの連絡',
  homeRecord: '家庭での記録',
  rawText: '元の抽出テキスト',
  fetchStatus: '取得状態',
};

/* ===================== v2：共通受け箱 ===================== */

/** 連絡帳以外の記録の種類。連絡帳は既存の NoteRecord のまま保存し、画面と検索で統合する */
export type ItemKind = 'notice' | 'flyer' | 'photo' | 'memo';
/** 画面・検索で使う全種類（連絡帳を含む） */
export type EntryKind = 'note' | ItemKind;

export const KIND_LABELS: Record<EntryKind, string> = {
  note: '連絡帳',
  notice: 'お知らせ',
  flyer: 'チラシ・資料',
  photo: '写真',
  memo: 'メモ',
};

/** 添付ファイル。実体（Blob）は blobs ストアに `${id}:${variant}` で保存する */
export interface AttachmentRef {
  id: string;
  name: string;
  /** 元ファイルの種類（image/jpeg, application/pdf など） */
  mime: string;
  /** 元ファイルの容量（バイト） */
  size: number;
  width?: number;
  height?: number;
  /** 保存してある版。orig=原本、view=表示用（長辺2560px）、thumb=サムネイル */
  variants: ('orig' | 'view' | 'thumb')[];
  /** 写真の撮影日時（EXIF）。分かれば */
  takenAt?: string;
  /* ---- v0.5 で追加（すべて省略可。旧版は無視する） ---- */
  /** 保存した本体の SHA-256（重複判定） */
  hash?: string;
  /** 写真か、資料（PDF・資料画像）か */
  role?: 'photo' | 'document';
  /** PDFから取り出した文字（検索・予定抽出） */
  text?: string;
  pages?: number;
  /** 元サービス上の表示名・表示容量（例：「献立表夕食11月号.pdf」「180.8KB」） */
  displayName?: string;
  displaySize?: string;
  /** 出どころ：単体で保存／一覧PDFから同一ファイル／一覧PDFから形式変換／一覧PDFから縮小版 */
  provenance?: 'single' | 'listpdf-identical' | 'listpdf-recoded' | 'listpdf-downscaled';
  /** 保存状態。missing＝元サービスにあるが未保存（名前と容量だけ分かっている） */
  state?: 'saved' | 'missing';
}

export interface Item {
  id: string;
  kind: ItemKind;
  /** 対象日（行事の日・受け取った日・撮影日） YYYY-MM-DD */
  date: string;
  title: string;
  /** 本文・説明 */
  body: string;
  /** 検索用の追加テキスト（チラシの文字を貼り付けたもの等） */
  searchText: string;
  /** 子どもの名前。空欄＝家族全体・特定しない */
  childName: string;
  /** 行事名（運動会など）。同じ行事の記録を束ねる */
  event: string;
  attachments: AttachmentRef[];
  source: {
    via: 'file' | 'photo' | 'paste' | 'restore' | 'bulk' | 'listpdf';
    fileNames: string[];
    /** v0.5：取り込み元のサービス（例 'haicheese'） */
    service?: string;
    /** v0.5：重複判定用のキー（掲載日＋タイトル＋本文冒頭から作る） */
    externalKey?: string;
  };
  createdAt: string;
  updatedAt: string;
  /* ---- v0.5 で追加（すべて省略可。旧版は無視する） ---- */
  /** ジャンル（利用者がボタンで選ぶ。例：給食・園だより・活動記録） */
  genre?: string;
  /** 保護者向けの区分（複数可） */
  purposes?: Purpose[];
  /** 元サービス側の区分 */
  origin?: Origin;
  /** 取り込んだ日時（date は掲載日として扱う） */
  importedAt?: string;
  /** 子どもID。空＝家族全体 */
  childIds?: string[];
  /** 未整理／整理済み */
  status?: 'inbox' | 'filed';
  important?: boolean;
  /** 本文の取得状態 */
  bodyState?: 'full' | 'truncated' | 'unknown';
  /** このお知らせが訂正している元のお知らせのID */
  revisionOf?: string;
  /** 変更の履歴 */
  history?: { at: string; by: string; fields: string[] }[];
  familyId?: string;
  createdBy?: string;
  /** 更新のたびに +1（将来の同期で競合を見つけるため） */
  rev?: number;
}

/** v0.5：保護者向けの区分（D4） */
export type Purpose = 'memories' | 'schedule' | 'documents' | 'daily';
export const PURPOSE_LABELS: Record<Purpose, string> = {
  memories: '思い出・成長記録',
  schedule: '予定・重要通知',
  documents: '資料',
  daily: '日々の記録',
};
/** v0.5：元サービス側の区分 */
export type Origin = 'oshirase' | 'renrakucho' | 'manual';
export const ORIGIN_LABELS: Record<Origin, string> = { oshirase: 'お知らせ', renrakucho: '連絡帳', manual: '手入力' };

/** v0.5：家族と子ども（meta に保存） */
export interface Family {
  id: string;
  name: string;
  /** この端末の利用者ID */
  deviceUserId: string;
  createdAt: string;
}
export interface Child {
  id: string;
  /** 画面に出す名前 */
  displayName: string;
  /** 記録上の表記（連絡帳の園児名、お知らせの札の名前など） */
  aliases: string[];
  createdAt: string;
}

/* ===================== v3：予定 ===================== */

export type EventCategory = 'event' | 'deadline' | 'prepare' | 'closed' | 'lunch' | 'backup' | 'other';

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  event: '行事',
  deadline: '提出・締切',
  prepare: '持ち物・準備',
  closed: '休園',
  lunch: '給食',
  backup: '予備日',
  other: 'その他',
};

/** 予定の元になった記録 */
export interface EventSource {
  type: 'item' | 'note' | 'manual';
  /** item.id / note.id（manual は空） */
  id: string;
  /** 元の文章のうち、この予定の根拠になった部分 */
  snippet: string;
}

export interface EventChange {
  at: string;
  /** 「日付：10月12日 → 10月19日」のような説明 */
  changes: string[];
  /** 変更のきっかけになった記録（お知らせの再取り込みなど） */
  sourceId?: string;
}

export interface CalEvent {
  id: string;
  title: string;
  /** 開始日 YYYY-MM-DD */
  date: string;
  /** 終了日（複数日の場合のみ） YYYY-MM-DD */
  endDate: string;
  /** 開始・終了時刻 HH:MM。空なら終日 */
  start: string;
  end: string;
  location: string;
  description: string;
  childName: string;
  category: EventCategory;
  status: 'active' | 'cancelled';
  source: EventSource;
  history: EventChange[];
  /** 外部カレンダーに書き出した日時と、その時点の版（変更検知用） */
  exportedAt: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  /* ---- v0.5 で追加（省略可） ---- */
  childIds?: string[];
  familyId?: string;
  rev?: number;
}
