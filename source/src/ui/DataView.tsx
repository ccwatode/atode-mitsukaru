import { useState } from 'react';
import type { FileEntry } from '../db.ts';
import type { Child } from '../core/types.ts';
import { daysSince, formatBytes, formatDateTime, StatusBadge } from './common.tsx';
import { IconDownload, IconFolder, IconShield, IconUpload } from './icons.tsx';

export function DataView(props: {
  counts: { records: number; items: number; attachments: number };
  files: FileEntry[];
  storage: { usage?: number; quota?: number; persisted?: boolean };
  memoryOnly: boolean;
  lastBackupAt?: string;
  keepOriginal: boolean;
  onKeepOriginal: (v: boolean) => void;
  onBackup: (includePdfs: boolean) => void;
  onRestore: () => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onImportJson: () => void;
  onPersist: () => void;
  onDeleteAll: () => void;
  kids: Child[];
  kidUsage: (id: string) => number;
  onRenameChild: (id: string, name: string) => void;
  onMergeChild: (keepId: string, mergeId: string) => void;
}) {
  const [includePdfs, setIncludePdfs] = useState(true);
  const days = daysSince(props.lastBackupAt);
  const pdfBytes = props.files.reduce((s, f) => s + (f.blobSaved ? f.size : 0), 0);
  return (
    <div className="screen">
      <section className="card">
        <h2 className="card-title">
          <IconShield size={18} /> バックアップ
        </h2>
        <p className={days == null || days > 30 ? 'notice notice-warn' : 'small muted'}>
          {props.lastBackupAt ? `最後のバックアップ：${formatDateTime(props.lastBackupAt)}（${days}日前）` : 'まだバックアップがありません'}
        </p>
        <p className="small muted">
          連絡帳{props.counts.records}日分、お知らせ・チラシ・写真{props.counts.items}件（添付{props.counts.attachments}件）を、画像も含めて1つのファイル（ZIP）にまとめます。保存先で「ファイルに保存」→ iCloud Drive を選ぶと、機種変更でも戻せます。
        </p>
        <label className="toggle">
          <input type="checkbox" checked={includePdfs} onChange={(e) => setIncludePdfs(e.target.checked)} />
          <span>取り込んだ連絡帳PDFも含める（{formatBytes(pdfBytes)}）</span>
        </label>
        <div className="btn-col">
          <button className="btn btn-primary" onClick={() => props.onBackup(includePdfs)}>
            <IconDownload size={18} /> バックアップを作成
          </button>
          <button className="btn" onClick={props.onRestore}>
            <IconUpload size={18} /> バックアップから復元
          </button>
        </div>
        <p className="small muted">復元しても今のデータは消えません。同じ記録は重複せず、内容が違うものは今のデータを優先します（連絡帳は違いを確認してから反映）。</p>
      </section>

      <section className="card">
        <h2 className="card-title">写真の保存方法</h2>
        <label className="toggle">
          <input type="checkbox" checked={props.keepOriginal} onChange={(e) => props.onKeepOriginal(e.target.checked)} />
          <span>原本（元のファイル）も保存する</span>
        </label>
        <p className="small muted">長辺2560px以下の画像（はいチーズ！から保存した写真など）は、この設定にかかわらず、元のファイルをそのまま保存します。</p>
        <p className="small muted">それより大きい写真：オフ（おすすめ）なら長辺2560pxの表示用とサムネイルだけを保存します。容量は1枚あたり約0.5〜1MB。オンにすると元のファイルも残り、1枚あたり数MB増えます。</p>
      </section>

      <section className="card">
        <h2 className="card-title">子ども</h2>
        {props.kids.length === 0 ? (
          <p className="small muted">まだ登録されていません。連絡帳やお知らせに子どもの名前が入ると、自動で追加されます。</p>
        ) : (
          <ul className="kid-list">
            {props.kids.map((k) => (
              <KidRow key={k.id} kid={k} others={props.kids.filter((o) => o.id !== k.id)} usage={props.kidUsage(k.id)} onRename={props.onRenameChild} onMerge={props.onMergeChild} />
            ))}
          </ul>
        )}
        <p className="small muted">同じ子どもが別の書き方（ひらがな・漢字など）で2人になっている場合は、「まとめる」で1人にできます。記録と予定の紐づけも付け替わります。</p>
      </section>

      <section className="card">
        <h2 className="card-title">連絡帳の書き出し（表計算・他のアプリ用）</h2>
        <div className="btn-col">
          <button className="btn" onClick={props.onExportCsv} disabled={!props.counts.records}>
            CSVで保存（Excel・Numbers用）
          </button>
          <button className="btn" onClick={props.onExportJson} disabled={!props.counts.records}>
            JSONで保存
          </button>
          <button className="btn btn-ghost" onClick={props.onImportJson}>
            以前のJSONを読み込む
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">
          <IconFolder size={18} /> 取り込んだ連絡帳PDF
        </h2>
        {props.files.length ? (
          <ul className="plain small">
            {[...props.files]
              .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
              .map((f) => (
                <li key={f.hash}>
                  {f.name}（{formatBytes(f.size)}・{f.recordCount}日分・{formatDateTime(f.importedAt)}）{f.blobSaved ? '' : ' ※元PDFは保存していません'}
                </li>
              ))}
          </ul>
        ) : (
          <p className="small muted">まだありません。</p>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">保存について</h2>
        <ul className="plain small">
          <li>保存先：{props.memoryOnly ? 'メモリ（画面を閉じると消えます）' : 'このiPhoneの中（ブラウザの保存領域）'}</li>
          <li>
            使用量：{formatBytes(props.storage.usage)}
            {props.storage.quota ? ` / 上限の目安 ${formatBytes(props.storage.quota)}` : ''}
          </li>
          <li>永続保存：{props.storage.persisted ? '許可されています' : '許可されていません'}</li>
        </ul>
        {!props.storage.persisted && !props.memoryOnly && (
          <button className="btn btn-small btn-ghost" onClick={props.onPersist}>
            永続保存をブラウザに依頼
          </button>
        )}
        <p className="small muted">ホーム画面に追加したアプリとして使うと、Safariより消えにくくなります。それでも暗号化や永続性は保証されないため、月に1回程度のバックアップをおすすめします。</p>
      </section>

      <section className="card">
        <h2 className="card-title">プライバシー</h2>
        <ul className="plain small">
          <li>PDFや画像の読み取り・検索・保存はすべてこのiPhoneの中で行います。</li>
          <li>記録や画像を外部のサーバー、AI、分析ツールに送信しません。</li>
          <li>はいチーズ！ノートへの自動ログインや自動取得は行いません。</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">連絡帳の状態の見かた</h2>
        <ul className="plain small legend">
          <li>
            <StatusBadge s="取得済み" /> 先生からの連絡・生活記録・家庭からの連絡を確認できた
          </li>
          <li>
            <StatusBadge s="要確認" /> 本文はあるが途中で切れている・欄が欠けている可能性
          </li>
          <li>
            <StatusBadge s="未取得" /> 「さらに表示」が開かれておらず本文がPDFにない
          </li>
        </ul>
      </section>

      <section className="card danger">
        <h2 className="card-title">データの削除</h2>
        <p className="small">この端末に保存したすべての記録・画像・PDFを削除します。元に戻せません。</p>
        <button className="btn btn-danger" onClick={props.onDeleteAll}>
          この端末のデータをすべて削除
        </button>
      </section>
    </div>
  );
}

function KidRow(props: { kid: Child; others: Child[]; usage: number; onRename: (id: string, name: string) => void; onMerge: (keepId: string, mergeId: string) => void }) {
  const k = props.kid;
  const [name, setName] = useState(k.displayName);
  const [target, setTarget] = useState('');
  return (
    <li className="kid-row">
      <label className="field">
        <span>表示名</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== k.displayName && props.onRename(k.id, name)} />
      </label>
      <p className="small muted">記録上の表記：{k.aliases.join('、')}／紐づいた記録・予定 {props.usage}件</p>
      {props.others.length > 0 && (
        <div className="kid-merge">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={`${k.displayName}にまとめる子ども`}>
            <option value="">同じ子どもを選ぶ…</option>
            {props.others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
          </select>
          <button className="btn btn-small" disabled={!target} onClick={() => (props.onMerge(k.id, target), setTarget(''))}>
            まとめる
          </button>
        </div>
      )}
    </li>
  );
}
