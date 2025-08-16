// ui/confirm.js
(() => {
    'use strict';

    const api = (typeof messenger !== 'undefined') ? messenger : browser;
    const qs = (id) => document.getElementById(id);

    function humanSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let b = Math.max(0, Number(bytes || 0)), i = 0;
        while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i ? 1 : 0)} ${units[i]}`;
    }

    // 足りない場合は footer に動的に作る
    function ensureBanner(id, klass) {
        let el = qs(id);
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.className = klass;
            const footer = document.querySelector('footer') || document.body;
            // ボタンの左側に出す
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

    function setSummaryFromQuery() {
        const params = new URLSearchParams(location.search);
        const affected = params.get('affected') ?? '0';
        const total = params.get('total') ?? '0';
        const bytes = params.get('bytes') ?? 0;
        if (qs('affected')) qs('affected').textContent = affected;
        if (qs('total')) qs('total').textContent = total;
        if (qs('bytes')) qs('bytes').textContent = humanSize(bytes);
        return params.get('key') || '';
    }

    function renderExtSummary(extSummary) {
        const tbody = document.querySelector('#extTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!Array.isArray(extSummary) || extSummary.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="muted">No data</td></tr>`;
            return;
        }
        for (const row of extSummary) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${row.ext}</td><td class="num">${row.count}</td><td class="num">${humanSize(row.bytes)}</td>`;
            tbody.appendChild(tr);
        }
    }

    function renderMessages(messages) {
        const tbody = document.querySelector('#msgTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        const filtered = Array.isArray(messages) ? messages.filter(m => (m.attachments || []).length > 0) : [];
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="muted">No messages with attachments</td></tr>`;
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

    function disableButtons() {
        const ok = qs('ok'), ca = qs('cancel');
        if (ok) ok.disabled = true;
        if (ca) ca.disabled = true;
    }

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
                // 背景にキャンセル通知（ある程度親切）
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

            // --- ここが今回の追記：上部サマリ（affected / total / bytes）を再計算して上書き ---
            const setText = (id, txt) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(txt);
            };

            // 件数（affected）
            const affectedVal = Number(data.stats?.affectedMessages ?? 0);
            setText('affected', affectedVal);

            // 添付総数（total）：stats.totalAttachments → messages.attachments.count の順でフォールバック
            let totalVal = Number(data.stats?.totalAttachments ?? 0);
            if (!totalVal && Array.isArray(data.messages)) {
                totalVal = data.messages.reduce((s, m) => s + (m?.attachments?.length || 0), 0);
            }
            setText('total', totalVal);

            // 総バイト数（bytes）：stats.totalSize → extSummary.sum(bytes) → messages.attachments.sum(size)
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
