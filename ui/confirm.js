// ui/confirm.js
// Safe DOM rendering; all interface text comes from the shared message catalogs.
(() => {
    'use strict';

    const api = (typeof messenger !== 'undefined') ? messenger : browser;
    const { t, number, size: humanSize, details, apply } = globalThis.BDI18n;
    const qs = (id) => document.getElementById(id);
    let previewReady = false;

    function setText(el, txt) { if (el) el.textContent = String(txt ?? ''); }

    /* ========= Utilities ========= */


    // 足りない場合は footer に動的に作る
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
        el.textContent = String(text || t('error'));
        el.hidden = false;
    }
    function showWarn(text) {
        const el = ensureBanner('warn', 'warn');
        el.textContent = String(text || t('warning'));
        el.hidden = false;
    }

    function clearNode(node) {
        if (!node) return;
        if (typeof node.replaceChildren === 'function') node.replaceChildren();
        else { while (node.firstChild) node.removeChild(node.firstChild); }
    }

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
        setText(qs('affected'), number(affected));
        setText(qs('total'), number(total));
        setText(qs('bytes'), humanSize(bytes));
        return params.get('key') || '';
    }

    /* ========= Rendering ========= */

    function renderExtSummary(extSummary) {
        const tbody = document.querySelector('#extTable tbody');
        if (!tbody) return;

        clearNode(tbody);

        const rows = Array.isArray(extSummary) ? extSummary.slice() : [];
        rows.sort((a, b) =>
            (Number(b.bytes) - Number(a.bytes)) ||
            (Number(b.count) - Number(a.count)) ||
            String(a.ext ?? '').localeCompare(String(b.ext ?? ''))
        );

        if (rows.length === 0) {
            const tr = cloneTemplateRow('empty-row-3') || (() => {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 3;
                td.className = 'muted';
                td.textContent = t('noData');
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

            if (!tdExt) { tdExt = document.createElement('td'); tr.appendChild(tdExt); }
            if (!tdCount) { tdCount = document.createElement('td'); tdCount.classList.add('num'); tr.appendChild(tdCount); }
            if (!tdBytes) { tdBytes = document.createElement('td'); tdBytes.classList.add('num'); tr.appendChild(tdBytes); }

            tdExt.textContent = row.ext ? String(row.ext) : t('unknownType');
            tdCount.textContent = number(row.count ?? 0);
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
                td.textContent = t('noMessagesWithAttachments');
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
            let tdNames = tr.querySelector('.names') || tr.querySelector('.attach-list');

            if (!tdSubj) { tdSubj = document.createElement('td'); tr.appendChild(tdSubj); }
            if (!tdFrom) { tdFrom = document.createElement('td'); tr.appendChild(tdFrom); }
            if (!tdDate) { tdDate = document.createElement('td'); tr.appendChild(tdDate); }
            if (!tdCount) { tdCount = document.createElement('td'); tdCount.classList.add('num'); tr.appendChild(tdCount); }
            if (!tdNames) { tdNames = document.createElement('td'); tdNames.classList.add('attach-list'); tr.appendChild(tdNames); }

            tdSubj.textContent = String(m.subject || '');
            tdFrom.textContent = String(m.author || '');
            tdDate.textContent = String(m.date || '');
            tdCount.textContent = number((m.attachments || []).length);

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
                showError(t('missingKey'));
                disableButtons();
                return;
            }
            if (!api?.storage?.local?.get) {
                showError(t('storageUnavailable'));
                disableButtons();
                return;
            }

            const got = await api.storage.local.get(key).catch((e) => {
                showError(details(t('loadFailed'), e));
                return {};
            });
            const data = got[key];
            if (!data || !data.stats) {
                showError(t('previewNotFound'));
                disableButtons();
                return;
            }

            const backup = data.settings?.backupEnabled !== false;
            qs('backup-mode').textContent = backup
                ? t('backupLocation', data.settings?.saveRoot || 'BulkAttachmentBackup') : t('backupDisabledConfirmation');
            if (!backup) {
                qs('backup-mode').className = 'warn';
                qs('ok').textContent = t('deleteWithoutBackup');
            }

            const totalSelected = Array.isArray(data.messages) ? data.messages.length : 0;
            if (totalSelected > 100) showWarn(t('manyMessages', number(totalSelected)));

            renderExtSummary(data.stats.extSummary || []);
            renderMessages(data.messages || []);

            // 上部サマリ（affected / total / bytes）を再計算して上書き
            const setTop = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = String(txt); };
            const affectedVal = Number(data.stats?.affectedMessages ?? 0);
            setTop('affected', number(affectedVal));

            let totalVal = Number(data.stats?.totalAttachments ?? 0);
            if (!totalVal && Array.isArray(data.messages)) {
                totalVal = data.messages.reduce((s, m) => s + (m?.attachments?.length || 0), 0);
            }
            setTop('total', number(totalVal));

            let bytesVal = Number(data.stats?.totalSize ?? data.stats?.totalBytes ?? 0);
            if (!bytesVal && Array.isArray(data.stats?.extSummary)) {
                bytesVal = data.stats.extSummary.reduce((s, r) => s + (Number(r?.bytes) || 0), 0);
            }
            if (!bytesVal && Array.isArray(data.messages)) {
                bytesVal = data.messages.reduce((s, m) =>
                    s + (m?.attachments || []).reduce((a, x) => a + (Number(x?.size) || 0), 0)
                    , 0);
            }
            setTop('bytes', humanSize(bytesVal));
            return true;

        } catch (e) {
            console.error('confirm: storage access failed', e);
            showError(t('loadFailed'));
            disableButtons();
        }
    }

    function bindButtons(key) {
        let sending = false;
        async function submit(ok) {
            if (sending || (ok && !previewReady)) return;
            sending = true;
            disableButtons();
            try {
                const response = await api.runtime.sendMessage({ type: 'confirm-result', key, ok });
                if (!response?.ack) throw new Error(t('previewNotFound'));
            } catch (error) {
                showError(error.message || String(error));
                sending = false;
                qs('ok').disabled = !previewReady;
                qs('cancel').disabled = false;
            }
        }
        qs('ok').addEventListener('click', () => submit(true));
        qs('cancel').addEventListener('click', () => submit(false));
    }

    document.addEventListener('DOMContentLoaded', async () => {
        apply();
        const key = setSummaryFromQuery();
        bindButtons(key);
        previewReady = !!await loadAndRender(key);
        qs('ok').disabled = !previewReady;
        qs('cancel').disabled = false;
    });
})();
