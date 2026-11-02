import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';

createRoot(document.getElementById('root')!).render(<App />);

// 自分のURLで公開したときだけ、オフライン起動用のService Workerを登録する
const inArtifact = !!(window as unknown as { claude?: unknown }).claude || /claudeusercontent|claude\.ai/.test(location.hostname);
if (!inArtifact && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  // 既に古い版が動いていた場合だけ「新しい版を受け取りました」と知らせる（初回は知らせない）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) window.dispatchEvent(new Event('app-updated'));
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => reg.update())
      .catch(() => {});
  });
}
