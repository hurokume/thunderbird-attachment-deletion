// ui/confirm.js
(() => {
    'use strict';

    const api = (typeof messenger !== 'undefined') ? messenger : browser;

    function humanSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let b = Math.max(0, Number(bytes || 0));
        let i = 0;
        while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i ? 1 : 0)} ${units[i]}`;
    }

    function qs(id) { return document.getElementById(id); }

    function setSummaryFromQuery() {
        const params = new URLSearchParams(location.search);
        qs('affected').textContent = params.get('affected') ?? '0';
        qs('total').textContent = params.get('total') ?? '0';
        qs('bytes').textContent = humanSize(params.get('bytes') ?? 0);
        return params.get('key') || '';
    }

    function renderExtSummary(extSummary) {
        const tbody = document.querySelector('#extTable tbody');
        tbody.innerHTML = '';
        if (!Array.isArray(extSummary) || extSummary.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="3" class="muted">No data</td>`;
            tbody.appendChild(tr);
            return;
        }
        for (const row of extSummary) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
        <td>${row.ext}</td>
        <td class="num">${row.count}</td>
        <td class="num">${humanSize(row.bytes)}</td>`;
            tbody.appendChild(tr);
        }
    }

    // ★ 添付 0 件のメールは一覧から除去
    function renderMessages(messages) {
        const tbody = document.querySelector('#msgTable tbody');
        tbody.innerHTML = '';

        const filtered = Array.isArray(messages)
            ? messages.filter(m => Array.isArray(m.attachments) && m.attachments.length > 0)
            : [];

        if (filtered.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="5" class="muted">No target messages</td>`;
            tbody.appendChild(tr);
            return;
        }

        for (const m of filtered) {
            const names = (m.attachments || []).map(a => `${a.name} : ${humanSize(a.size)}`);
            const tr = document.createElement('tr');
            tr.innerHTML = `
        <td>${m.subject || ''}</td>
        <td>${m.author || ''}</td>
        <td>${m.date || ''}</td>
        <td class="num">${(m.attachments || []).length}</td>
        <td class="attach-list">${names.join('<br/>')}</td>`;
            tbody.appendChild(tr);
        }
    }

    function showError(text) {
        const el = qs('error');
        el.textContent = text;
        el.hidden = false;
    }

    function disableButtons() {
        qs('ok').disabled = true;
        qs('cancel').disabled = true;
    }

    async function loadAndRender(key) {
        try {
            if (!key) {
                showError('キーがありません。拡張から開かれたページではない可能性があります。');
                disableButtons();
                return;
            }
            const got = await api.storage.local.get(key);
            const data = got[key];
            if (!data || !data.stats) {
                showError('プレビュー用データが見つかりません。再度実行してください。');
                disableButtons();
                api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }).catch(() => { });
                return;
            }
            renderExtSummary(data.stats.extSummary || []);
            renderMessages(data.messages || []);
        } catch (e) {
            console.error('confirm: storage access failed', e);
            showError('データの読み込みに失敗しました。');
            disableButtons();
            api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }).catch(() => { });
        }
    }

    function bindButtons(key) {
        qs('ok').addEventListener('click', () => {
            disableButtons();
            api.runtime.sendMessage({ type: 'confirm-result', key, ok: true }).catch(() => { });
        });
        qs('cancel').addEventListener('click', () => {
            disableButtons();
            api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }).catch(() => { });
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        try {
            const key = setSummaryFromQuery();
            bindButtons(key);
            loadAndRender(key);
        } catch (e) {
            console.error('confirm init failed', e);
            showError('初期化に失敗しました。');
            disableButtons();
        }
    });
})();
