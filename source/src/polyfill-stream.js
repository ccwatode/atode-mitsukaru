/*
 * Safari（iOS含む）は ReadableStream の for await…of に未対応。
 * PDF.js の getTextContent がこれを使うため、未対応の環境だけ補う。
 * build.mjs が同じファイルをPDF.jsワーカーの先頭にも付ける。
 */
(function () {
  try {
    if (typeof ReadableStream === 'undefined') return;
    var P = ReadableStream.prototype;
    if (typeof P[Symbol.asyncIterator] === 'function') return;
    var iter = function () {
      var reader = this.getReader();
      var o = {
        next: function () {
          return reader.read().then(function (x) {
            if (x.done) {
              try { reader.releaseLock(); } catch (e) {}
            }
            return x;
          });
        },
        return: function (v) {
          var p = reader.cancel();
          try { reader.releaseLock(); } catch (e) {}
          return p.then(function () { return { done: true, value: v }; });
        },
      };
      o[Symbol.asyncIterator] = function () { return this; };
      return o;
    };
    Object.defineProperty(P, Symbol.asyncIterator, { value: iter, configurable: true, writable: true });
    if (typeof P.values !== 'function') Object.defineProperty(P, 'values', { value: iter, configurable: true, writable: true });
  } catch (e) {}
})();
