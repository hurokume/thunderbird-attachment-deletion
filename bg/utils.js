// bg/utils.js
(function (BD) {
    'use strict';

    /* ========= date/time ========= */

    function pad2(n) { return String(n).padStart(2, '0'); }

    // 例: 20250101-123045 （既存と互換）
    function timestampFromDate(d) {
        const x = (d instanceof Date) ? d : new Date(d);
        return `${x.getFullYear()}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}-${pad2(x.getHours())}${pad2(x.getMinutes())}${pad2(x.getSeconds())}`;
    }

    /* ========= size / sleep / path util ========= */

    function humanSize(bytes) {
        const u = ['B', 'KB', 'MB', 'GB', 'TB']; let b = Math.max(0, Number(bytes || 0)), i = 0;
        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    }

    function withAbort(promise, signal) {
        if (!signal) return promise;
        return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
            if (signal.aborted) abort();
        });
    }

    function sleep(ms, signal) {
        throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            const cleanup = () => signal?.removeEventListener('abort', abort);
            const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
            const abort = () => {
                clearTimeout(timer);
                cleanup();
                reject(new DOMException('Cancelled', 'AbortError'));
            };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }

    // Bound UTF-8 bytes as well as UTF-16 units, without splitting a code point.
    function truncateUtf8(value, max) {
        let result = '', bytes = 0;
        const encoder = new TextEncoder();
        for (const char of String(value)) {
            bytes += encoder.encode(char).length;
            if (bytes > max) break;
            result += char;
        }
        return result;
    }

    function addSuffixToPath(path, suffix) {
        const k = path.lastIndexOf('/');
        const dir = k >= 0 ? path.slice(0, k + 1) : '';
        const name = k >= 0 ? path.slice(k + 1) : path;
        const dot = name.lastIndexOf('.');
        const base = (dot > 0) ? name.slice(0, dot) : name;
        const ext = (dot > 0) ? name.slice(dot) : '';
        return `${dir}${base}${suffix}${ext}`;
    }

    /* ========= sanitize (強化版) =========
       - Unicode を NFKC 正規化
       - 置換文字 U+FFFD（�）と制御文字を削除
       - 禁止文字 \ / : * ? " < > | を _
       - 先頭/末尾のスペース・ピリオドを削除（Windows対策）
       - 予約語（CON/PRN/AUX/NUL/COM1..9/LPT1..9）を回避
       - 長さ制限（既定: segment=180, filename=180）
    */

    function _normalizeUnicode(s) {
        try { return s.normalize('NFKC'); } catch { return s; }
    }

    const _RESERVED = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i;

    // パスの一部（件名など）に使うサニタイズ
    function sanitizePathSegment(seg, opts = {}) {
        const { max = 180 } = opts;
        let s = String(seg ?? '');
        s = _normalizeUnicode(s);
        s = s.replace(/\uFFFD/g, '')                 // U+FFFD を除去
            .replace(/[\u0000-\u001F\u007F]/g, ''); // 制御文字
        s = s.replace(/[\\/:*?"<>|]/g, '_');         // 禁止文字
        s = s.replace(/\s+/g, ' ');                  // 連続空白を統一
        s = s.replace(/^[. ]+|[. ]+$/g, '');         // 先頭/末尾 . と空白を削除
        if (!s) s = 'item';
        if (_RESERVED.test(s)) s = `_${s}_`;
        s = truncateUtf8(s, max).replace(/[. ]+$/g, '') || 'item';
        if (_RESERVED.test(s.split('.')[0])) s = `_${s}`;
        return s;
    }

    // 実ファイル名用（拡張子をできる限り保持）
    function sanitizeFilename(name, opts = {}) {
        const max = Math.max(1, opts.max || 180);
        const n = _normalizeUnicode(String(name ?? ''))
            .replace(/[\uFFFD\u0000-\u001F\u007F]/g, '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[. ]+|[. ]+$/g, '');
        const m = n.match(/^(.*?)(\.[^.]{1,10})$/u);
        const ext = truncateUtf8(m ? m[2] : '', Math.min(32, max - 1)).replace(/[. ]+$/g, '');
        const budget = max - new TextEncoder().encode(ext).length;
        let base = truncateUtf8((m ? m[1] : n) || 'attachment', budget).replace(/[. ]+$/g, '') || 'a';
        if (_RESERVED.test(base.split('.')[0])) base = '_' + truncateUtf8(base, budget - 1);
        return base + ext;
    }

    function backupFilename(meta, original, messageId, partName, maxBytes = 180) {
        let hash = 2166136261;
        for (const char of `${messageId}:${partName}:${meta.subject}:${original}`) {
            hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
        }
        const stamp = sanitizePathSegment(meta.stamp || timestampFromDate(meta.stampDate || new Date()), { max: 20 });
        const title = sanitizePathSegment(meta.subject || 'no_subject', { max: Math.min(40, maxBytes - 60) });
        const prefix = `${stamp}_${hash.toString(16).padStart(8, '0')}_${title}_`;
        const budget = maxBytes - new TextEncoder().encode(prefix).length;
        return prefix + sanitizeFilename(original || 'attachment', { max: budget });
    }

    // 既存互換（従来の sanitize を強化版に差し替え）
    function sanitize(s) { return sanitizePathSegment(s, { max: 180 }); }

    BD.utils = Object.assign(BD.utils || {}, {
        pad2,
        timestampFromDate,
        humanSize,
        sleep,
        throwIfAborted,
        withAbort,
        truncateUtf8,
        backupFilename,
        addSuffixToPath,
        // 新規/強化
        sanitizePathSegment,
        sanitizeFilename,
        sanitize
    });
})(globalThis.BD);
