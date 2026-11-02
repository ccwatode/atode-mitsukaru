/**
 * ファイルの保存。iPhoneでは共有シート（「ファイルに保存」でiCloud Driveなど）を優先し、
 * 使えない環境では通常のダウンロードにする。ファイルの中身は端末内で作り、外部には送らない。
 */
export type SaveOutcome = 'saved' | 'declined' | 'started' | 'failed';

export async function saveFile(file: File): Promise<SaveOutcome> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return 'saved';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'declined';
      // 共有できなければダウンロードを試す
    }
  }
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'started';
  } catch {
    return 'failed';
  }
}

export const textFile = (name: string, text: string, type: string) => new File([text], name, { type });

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** iPhone・iPad（iPadOSはMacと名乗るためタッチ対応で判定） */
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/**
 * 予定ファイル（.ics）を開く。
 * iPhoneのSafariは text/calendar を開くと「カレンダーに追加」の画面を出すため、ダウンロードではなく開く。
 * それ以外の環境ではファイルとしてダウンロードし、カレンダーアプリで開いてもらう。
 */
export function openCalendarFile(name: string, ics: string): 'opened' | 'started' {
  const file = new File([ics], name, { type: 'text/calendar' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  const forceDownload = (() => {
    try {
      return localStorage.getItem('icsMode') === 'download';
    } catch {
      return false;
    }
  })();
  if (!isIOS() || forceDownload) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return a.download ? 'started' : 'opened';
}
