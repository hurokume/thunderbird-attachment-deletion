// bg/utils.js
(function (BD) {
    'use strict';

    function pad2(n) { return String(n).padStart(2, '0'); }
    function timestampFromDate(d) {
        const x = (d instanceof Date) ? d : new Date(d);
        return `${x.getFullYear()}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}-${pad2(x.getHours())}${pad2(x.getMinutes())}${pad2(x.getSeconds())}`;
    }
    function sanitize(s) { return (s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); }
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

    BD.utils = { pad2, timestampFromDate, sanitize, humanSize, sleep, addSuffixToPath };
})(globalThis.BD);
