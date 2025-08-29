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

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        if (s.length > max) s = s.slice(0, max);
        return s;
    }

    // 実ファイル名用（拡張子をできる限り保持）
    function sanitizeFilename(name, opts = {}) {
        const { max = 180 } = opts;
        let n = String(name ?? '');
        n = _normalizeUnicode(n);
        n = n.replace(/\uFFFD/g, '')
            .replace(/[\u0000-\u001F\u007F]/g, '');

        // 拡張子を分離（最大10文字想定）
        const m = n.match(/^(.*?)(\.[^.]{1,10})$/);
        let base = m ? m[1] : n;
        let ext = m ? m[2] : '';

        base = base.replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[. ]+|[. ]+$/g, '');
        if (!base) base = 'attachment';
        if (_RESERVED.test(base)) base = `_${base}_`;

        // base の長さを制限（拡張子は保持）
        const maxBase = Math.max(1, max - ext.length);
        if (base.length > maxBase) base = base.slice(0, maxBase);

        // 拡張子側の禁止文字も念のため
        ext = ext.replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001F\u007F]/g, '');
        return base + ext;
    }

    // 既存互換（従来の sanitize を強化版に差し替え）
    function sanitize(s) { return sanitizePathSegment(s, { max: 180 }); }

    BD.utils = Object.assign(BD.utils || {}, {
        pad2,
        timestampFromDate,
        humanSize,
        sleep,
        addSuffixToPath,
        // 新規/強化
        sanitizePathSegment,
        sanitizeFilename,
        sanitize
    });
})(globalThis.BD);
