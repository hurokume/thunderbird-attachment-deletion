// ui/confirm.js
// i18n対応版：ページ文言を言語に合わせて切替（ja/en/zh）。安全なDOM構築（innerHTML不使用）。
(() => {
    'use strict';

    const api = (typeof messenger !== 'undefined') ? messenger : browser;
    const qs = (id) => document.getElementById(id);
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ========= i18n ========= */
    function detectLang() {
        const lang =
            (api?.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
        if (lang.startsWith('ja')) return 'ja';
        if (lang.startsWith('zh')) return 'zh';
        return 'en';
    }
    const LANG = detectLang();

    const I18N = {
        en: {
            title: 'Review before deleting',
            subtitle: 'Check the targets and breakdown before removing attachments from the selected messages.',
            byExt: 'By extension / size',
            messages: 'Messages to process',
            ext: 'Extension',
            count: 'Count',
            total: 'Total',
            subject: 'Subject',
            from: 'From',
            received: 'Received',
            attachments: 'Attachments',
            namesSizes: 'Names / Sizes',
            cancel: 'Cancel',
            ok: 'Delete',
            loading: 'Loading…',
            noData: 'No data',
            noMsgs: 'No messages with attachments',
            warnMany: (n) => `You selected ${n} messages. This may take a while to process.`,
            Error: 'Error',
            Warning: 'Warning',
            MissingKey: 'Missing key. This page may not have been opened by the extension.',
            StorageNA: 'Storage API is not available. Please add "storage" permission and reload the add-on.',
            PreviewNotFound: 'Preview data not found. Please run again.',
            FailedLoad: 'Failed to load data.'
        },
        ja: {
            title: '削除前の確認',
            subtitle: '選択したメッセージから添付ファイルを削除する前に、対象と内訳を確認してください。',
            byExt: '拡張子 / サイズ別',
            messages: '処理対象メッセージ',
            ext: '拡張子',
            count: '件数',
            total: '合計',
            subject: '件名',
            from: '差出人',
            received: '受信日時',
            attachments: '添付数',
            namesSizes: '名称 / サイズ',
            cancel: 'キャンセル',
            ok: '削除',
            loading: '読み込み中…',
            noData: 'データがありません',
            noMsgs: '添付ファイルのあるメッセージはありません',
            warnMany: (n) => `${n}件のメッセージが選択されています。処理に時間がかかる場合があります。`,
            Error: 'エラー',
            Warning: '警告',
            MissingKey: 'キーがありません。このページは拡張機能から開かれていない可能性があります。',
            StorageNA: 'Storage API が利用できません。「storage」権限を付与してアドオンを再読み込みしてください。',
            PreviewNotFound: 'プレビュー用のデータが見つかりません。もう一度実行してください。',
            FailedLoad: 'データの読み込みに失敗しました。'
        },
        zh: {
            title: '删除前确认',
            subtitle: '在从所选邮件删除附件之前，请检查目标与明细。',
            byExt: '按扩展名 / 大小',
            messages: '待处理邮件',
            ext: '扩展名',
            count: '数量',
            total: '合计',
            subject: '主题',
            from: '发件人',
            received: '接收时间',
            attachments: '附件数',
            namesSizes: '名称 / 大小',
            cancel: '取消',
            ok: '删除',
            loading: '载入中…',
            noData: '没有数据',
            noMsgs: '没有包含附件的邮件',
            warnMany: (n) => `已选择 ${n} 封邮件。处理可能需要一些时间。`,
            Error: '错误',
            Warning: '警告',
            MissingKey: '缺少键。此页面可能不是由扩展打开的。',
            StorageNA: 'Storage API 不可用。请添加 “storage” 权限并重新加载附加组件。',
            PreviewNotFound: '未找到预览数据。请重新运行。',
            FailedLoad: '加载数据失败。'
        }
    }[LANG];

    function setText(el, txt) { if (el) el.textContent = String(txt ?? ''); }

    /* ========= Utilities ========= */

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
            const buttons = footer.querySelector('.buttons');
            if (buttons) footer.insertBefore(el, buttons);
            else footer.appendChild(el);
        }
        return el;
    }

    function showError(text) {
        const el = ensureBanner('error', 'error');
        el.textContent = String(text || I18N.Error);
        el.hidden = false;
    }
    function showWarn(text) {
        const el = ensureBanner('warn', 'warn');
        el.textContent = String(text || I18N.Warning);
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
        setText(qs('affected'), affected);
        setText(qs('total'), total);
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
                td.textContent = I18N.noData;
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
                td.textContent = I18N.noMsgs;
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
            tdCount.textContent = String((m.attachments || []).length);

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
                showError(I18N.MissingKey);
                disableButtons();
                return;
            }
            if (!api?.storage?.local?.get) {
                showError(I18N.StorageNA);
                disableButtons();
                try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
                return;
            }

            const got = await api.storage.local.get(key).catch((e) => {
                showError(`${I18N.FailedLoad}: ${e?.message || e}`);
                return {};
            });
            const data = got[key];
            if (!data || !data.stats) {
                showError(I18N.PreviewNotFound);
                disableButtons();
                try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
                return;
            }

            const totalSelected = Array.isArray(data.messages) ? data.messages.length : 0;
            if (totalSelected > 100) showWarn(I18N.warnMany(totalSelected));

            renderExtSummary(data.stats.extSummary || []);
            renderMessages(data.messages || []);

            // 上部サマリ（affected / total / bytes）を再計算して上書き
            const setTop = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = String(txt); };
            const affectedVal = Number(data.stats?.affectedMessages ?? 0);
            setTop('affected', affectedVal);

            let totalVal = Number(data.stats?.totalAttachments ?? 0);
            if (!totalVal && Array.isArray(data.messages)) {
                totalVal = data.messages.reduce((s, m) => s + (m?.attachments?.length || 0), 0);
            }
            setTop('total', totalVal);

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

        } catch (e) {
            console.error('confirm: storage access failed', e);
            showError(I18N.FailedLoad);
            disableButtons();
            try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
        }
    }

    /* ========= i18n apply ========= */

    function applyI18nStaticLabels() {
        // header
        const h1 = document.querySelector('header h1');
        const sub = document.querySelector('header .subtitle');
        setText(h1, I18N.title);
        setText(sub, I18N.subtitle);

        // section titles
        const sections = Array.from(document.querySelectorAll('section > h2'));
        if (sections[0]) setText(sections[0], I18N.byExt);
        if (sections[1]) setText(sections[1], I18N.messages);

        // table headers: extTable
        const extTh = Array.from(document.querySelectorAll('#extTable thead th'));
        if (extTh[0]) setText(extTh[0], I18N.ext);
        if (extTh[1]) setText(extTh[1], I18N.count);
        if (extTh[2]) setText(extTh[2], I18N.total);

        // table headers: msgTable
        const msgTh = Array.from(document.querySelectorAll('#msgTable thead th'));
        if (msgTh[0]) setText(msgTh[0], I18N.subject);
        if (msgTh[1]) setText(msgTh[1], I18N.from);
        if (msgTh[2]) setText(msgTh[2], I18N.received);
        if (msgTh[3]) setText(msgTh[3], I18N.attachments);
        if (msgTh[4]) setText(msgTh[4], I18N.namesSizes);

        // buttons
        const ok = qs('ok'), ca = qs('cancel');
        setText(ok, I18N.ok);
        setText(ca, I18N.cancel);

        // 初期プレースホルダ（Loading…）も必要ならここで差し替え可能
        const extBody = document.querySelector('#extTable tbody');
        const msgBody = document.querySelector('#msgTable tbody');
        if (extBody && extBody.children.length === 1) {
            const only = extBody.children[0];
            const td = only.querySelector('td');
            if (td && td.classList.contains('muted')) td.textContent = I18N.loading;
        }
        if (msgBody && msgBody.children.length === 1) {
            const only = msgBody.children[0];
            const td = only.querySelector('td');
            if (td && td.classList.contains('muted')) td.textContent = I18N.loading;
        }
    }

    /* ========= Events ========= */

    function bindButtons(key) {
        const ok = qs('ok'), ca = qs('cancel');

        async function closeSelfSafely() {
            try {
                if (api?.tabs?.getCurrent) {
                    const tab = await api.tabs.getCurrent();
                    if (tab?.id) { await api.tabs.remove(tab.id); return; }
                }
            } catch { }
            try {
                if (api?.windows?.getCurrent) {
                    const win = await api.windows.getCurrent();
                    if (win?.id) { await api.windows.remove(win.id); return; }
                }
            } catch { }
            try { window.close(); } catch { }
        }

        let closing = false;

        if (ok) ok.addEventListener('click', async () => {
            if (closing) return; closing = true;
            disableButtons();
            try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: true }); } catch { }
            await delay(120);
            closeSelfSafely();
        }, { once: true });

        if (ca) ca.addEventListener('click', async () => {
            if (closing) return; closing = true;
            disableButtons();
            try { await api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }); } catch { }
            await delay(120);
            closeSelfSafely();
        }, { once: true });
    }

    document.addEventListener('DOMContentLoaded', () => {
        applyI18nStaticLabels();
        const key = setSummaryFromQuery();
        bindButtons(key);
        loadAndRender(key);
    });
})();
