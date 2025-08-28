// ui/confirm.js (innerHTML 廃止版：<template> + createElement/textContent 使用)
(() => {
    'use strict';

    const api = (typeof messenger !== 'undefined') ? messenger : browser;
    const qs = (id) => document.getElementById(id);

    /* ========= Utilities ========= */

    function humanSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let b = Math.max(0, Number(bytes || 0)), i = 0;
        while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i ? 1 : 0)} ${units[i]}`;
    }

    // footer にバナー（error / warn）が無ければ作る
    function ensureBanner(id, klass) {
        let el = qs(id);
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.className = klass;
            const footer = document.querySelector('footer') || document.body;
            const buttons = footer.querySelector('.buttons');
            if (buttons) footer.insertBefore(el, buttons);
            else footer.appendChild(el);
        }
        return el;
    }

    function showError(text) {
        const el = ensureBanner('error', 'error');
        el.textContent = String(text || 'Error');
        el.hidden = false;
    }
    function showWarn(text) {
        const el = ensureBanner('warn', 'warn');
        el.textContent = String(text || 'Warning');
        el.hidden = false;
    }

    // node を空にする（innerHTML 不使用）
    function clearNode(node) {
        if (!node) return;
        if (typeof node.replaceChildren === 'function') node.replaceChildren();
        else { while (node.firstChild) node.removeChild(node.firstChild); }
    }

    // <template id="..."> を 1 行 (tr) として複製。無い場合は null
    function cloneTemplateRow(tmplId) {
        const t = document.getElementById(tmplId);
        if (t && t.content) {
            const row = t.content.firstElementChild;
            if (row) return row.cloneNode(true);
        }
        return null;
    }

    function setSummaryFromQuery() {
        const params = new URLSearchParams(location.search);
        const affected = params.get('affected') ?? '0';
        const total = params.get('total') ?? '0';
        const bytes = params.get('bytes') ?? 0;
        const aEl = qs('affected'), tEl = qs('total'), bEl = qs('bytes');
        if (aEl) aEl.textContent = affected;
        if (tEl) tEl.textContent = total;
        if (bEl) bEl.textContent = humanSize(bytes);
        return params.get('key') || '';
    }

    /* ========= Rendering ========= */

    function renderExtSummary(extSummary) {
        const tbody = document.querySelector('#extTable tbody');
        if (!tbody) return;

        clearNode(tbody);

        const rows = Array.isArray(extSummary) ? extSummary.slice() : [];
        // bytes 降順 → count 降順 → ext 昇順（任意）
        rows.sort((a, b) => (Number(b.bytes) - Number(a.bytes)) ||
            (Number(b.count) - Number(a.count)) ||
            String(a.ext ?? '').localeCompare(String(b.ext ?? '')));

        if (rows.length === 0) {
            const tr = cloneTemplateRow('empty-row-3') || (() => {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 3;
                td.className = 'muted';
                td.textContent = 'No data';
                tr.appendChild(td);
                return tr;
            })();
            tbody.appendChild(tr);
            return;
        }

        for (const row of rows) {
            const tr = cloneTemplateRow('ext-row') || document.createElement('tr');

            let tdExt = tr.querySelector('.ext');
            let tdCount = tr.querySelector('.count');
            let tdBytes = tr.querySelector('.bytes');

            // テンプレが無い場合のフォールバック生成
            if (!tdExt) { tdExt = document.createElement('td'); tr.appendChild(tdExt); }
            if (!tdCount) { tdCount = document.createElement('td'); tdCount.classList.add('num'); tr.appendChild(tdCount); }
            if (!tdBytes) { tdBytes = document.createElement('td'); tdBytes.classList.add('num'); tr.appendChild(tdBytes); }

            tdExt.textContent = String(row.ext ?? '');
            tdCount.textContent = String(row.count ?? 0);
            tdBytes.textContent = humanSize(row.bytes ?? 0);

            tbody.appendChild(tr);
        }
    }

    function renderMessages(messages) {
        const tbody = document.querySelector('#msgTable tbody');
        if (!tbody) return;

        clearNode(tbody);

        const filtered = Array.isArray(messages)
            ? messages.filter(m => (m.attachments || []).length > 0)
            : [];

        if (filtered.length === 0) {
            const tr = cloneTemplateRow('empty-row-5') || (() => {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 5;
                td.className = 'muted';
                td.textContent = 'No messages with attachments';
                tr.appendChild(td);
                return tr;
            })();
            tbody.appendChild(tr);
            return;
        }

        for (const m of filtered) {
            const tr = cloneTemplateRow('msg-row') || document.createElement('tr');

            let tdSubj = tr.querySelector('.subject');
            let tdFrom = tr.querySelector('.from');
            let tdDate = tr.querySelector('.date');
            let tdCount = tr.querySelector('.attach-count');
            // 互換：旧HTMLは .attach-list を使っていた
            let tdNames = tr.querySelector('.names') || tr.querySelector('.attach-list');

            // テンプレが無い場合のフォールバック列を用意
            if (!tdSubj) { tdSubj = document.createElement('td'); tr.appendChild(tdSubj); }
            if (!tdFrom) { tdFrom = document.createElement('td'); tr.appendChild(tdFrom); }
            if (!tdDate) { tdDate = document.createElement('td'); tr.appendChild(tdDate); }
            if (!tdCount) { tdCount = document.createElement('td'); tdCount.classList.add('num'); tr.appendChild(tdCount); }
            if (!tdNames) { tdNames = document.createElement('td'); tdNames.classList.add('attach-list'); tr.appendChild(tdNames); }

            tdSubj.textContent = String(m.subject || '');
            tdFrom.textContent = String(m.author || '');
            tdDate.textContent = String(m.date || '');
            tdCount.textContent = String((m.attachments || []).length);

            // 添付名リストを安全に構築（<br> ではなく div/span で積む）
            clearNode(tdNames);
            for (const a of (m.attachments || [])) {
                const line = document.createElement('div');
                line.className = 'att';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'name';
                nameSpan.textContent = String(a.name || '');

                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'size';
                sizeSpan.textContent = ` : ${humanSize(a.size)}`;

                line.appendChild(nameSpan);
                line.appendChild(sizeSpan);
                tdNames.appendChild(line);
            }

            tbody.appendChild(tr);
        }
    }

    function disableButtons() {
        const ok = qs('ok'), ca = qs('cancel');
        if (ok) ok.disabled = true;
        if (ca) ca.disabled = true;
    }

    /* ========= Data loading ========= */

    async function loadAndRender(key) {
        try {
            if (!key) {
                showError('Missing key. This page may not have been opened by the extension.');
                disableButtons();
                return;
            }
            if (!api?.storage?.local?.get) {
                showError('Storage API is not available. Please add "storage" permission and reload the add-on.');
                disableButtons();
                try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
                return;
            }

            const got = await api.storage.local.get(key).catch((e) => {
                showError(`Failed to read preview data: ${e?.message || e}`);
                return {};
            });
            const data = got[key];
            if (!data || !data.stats) {
                showError('Preview data not found. Please run again.');
                disableButtons();
                try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
                return;
            }

            const totalSelected = Array.isArray(data.messages) ? data.messages.length : 0;
            if (totalSelected > 100) showWarn(`You selected ${totalSelected} messages. This may take a while to process.`);

            renderExtSummary(data.stats.extSummary || []);
            renderMessages(data.messages || []);

            // --- 上部サマリ（affected / total / bytes）を再計算して上書き ---
            const setText = (id, txt) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(txt);
            };

            // 件数（affected）
            const affectedVal = Number(data.stats?.affectedMessages ?? 0);
            setText('affected', affectedVal);

            // 添付総数（total）
            let totalVal = Number(data.stats?.totalAttachments ?? 0);
            if (!totalVal && Array.isArray(data.messages)) {
                totalVal = data.messages.reduce((s, m) => s + (m?.attachments?.length || 0), 0);
            }
            setText('total', totalVal);

            // 総バイト数（bytes）
            let bytesVal = Number(data.stats?.totalSize ?? 0);
            if (!bytesVal && Array.isArray(data.stats?.extSummary)) {
                bytesVal = data.stats.extSummary.reduce((s, r) => s + (Number(r?.bytes) || 0), 0);
            }
            if (!bytesVal && Array.isArray(data.messages)) {
                bytesVal = data.messages.reduce((s, m) =>
                    s + (m?.attachments || []).reduce((a, x) => a + (Number(x?.size) || 0), 0)
                    , 0);
            }
            setText('bytes', humanSize(bytesVal));
            // --- 追記ここまで ---

        } catch (e) {
            console.error('confirm: storage access failed', e);
            showError('Failed to load data.');
            disableButtons();
            try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
        }
    }

    /* ========= Events ========= */

    function bindButtons(key) {
        const ok = qs('ok'), ca = qs('cancel');
        if (ok) ok.addEventListener('click', async () => {
            disableButtons();
            try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: true }); } catch { }
            setTimeout(() => window.close(), 0);
        });
        if (ca) ca.addEventListener('click', async () => {
            disableButtons();
            try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
            setTimeout(() => window.close(), 0);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        const key = setSummaryFromQuery();
        bindButtons(key);
        loadAndRender(key);
    });
})();
