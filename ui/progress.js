// ui/progress.js
// i18n + Cancel ボタン + 完了時の自動クローズ
(() => {
    'use strict';
    const api = (typeof messenger !== 'undefined') ? messenger : browser;

    const $ = (id) => document.getElementById(id);
    const qs = new URLSearchParams(location.search);
    const key = qs.get('key') || '';
    const totalInit = Number(qs.get('total') || 0);

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
            title: 'Progress',
            subtitle: 'Backing up and deleting attachments…',
            processingFmt: (i, n) => `${i} / ${n} attachments processing…`,
            done: 'Completed.',
            close: 'Close',
            cancel: 'Cancel',
            cancelling: 'Cancelling…',
            error: 'An error occurred.'
        },
        ja: {
            title: '進捗',
            subtitle: '添付ファイルのバックアップと削除を実行中です。',
            processingFmt: (i, n) => `${i} / ${n}件の添付ファイルを処理中…`,
            done: '完了しました。',
            close: '閉じる',
            cancel: 'キャンセル',
            cancelling: 'キャンセル中…',
            error: 'エラーが発生しました。'
        },
        zh: {
            title: '进度',
            subtitle: '正在备份并删除附件…',
            processingFmt: (i, n) => `${i} / ${n} 个附件正在处理…`,
            done: '已完成。',
            close: '关闭',
            cancel: '取消',
            cancelling: '正在取消…',
            error: '发生错误。'
        }
    }[LANG];

    function setText(el, txt) { if (el) el.textContent = String(txt ?? ''); }

    const bar = $('bar');
    const label = $('label');
    const pct = $('pct');
    const btnClose = $('close');
    const btnCancel = $('cancel');

    function setWarn(t) { const el = $('warn'); if (!el) return; el.textContent = String(t || ''); el.hidden = !t; }
    function setError(t) { const el = $('error'); if (!el) return; el.textContent = String(t || ''); el.hidden = !t; }

    function fmt(i, n) {
        const num = (v) => String(Math.max(0, Number(v || 0)));
        return I18N.processingFmt(num(i), num(n));
    }

    function update(i, n) {
        const ii = Math.max(0, Number(i || 0));
        const nn = Math.max(0, Number(n || 0));
        if (bar) { bar.max = nn; bar.value = Math.min(ii, nn); }
        if (label) label.textContent = fmt(ii, nn);
        if (pct) {
            const p = nn ? Math.floor((ii / nn) * 100) : 0;
            pct.textContent = `${p}%`;
        }
    }

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

    btnClose?.addEventListener('click', closeSelfSafely);

    btnCancel?.addEventListener('click', async () => {
        try {
            btnCancel.disabled = true;
            setText(btnCancel, I18N.cancelling);
            await api.runtime.sendMessage({ type: 'progress-cancel', key });
        } catch { }
    });

    function applyI18nStaticLabels() {
        const h1 = document.querySelector('header h1');
        const sub = document.querySelector('header .subtitle');
        setText(h1, I18N.title);
        setText(sub, I18N.subtitle);
        setText(btnClose, I18N.close);
        setText(btnCancel, I18N.cancel);
    }

    function autoCloseSoon() {
        // 少し表示を残してから自動クローズ
        setTimeout(closeSelfSafely, 800);
    }

    document.addEventListener('DOMContentLoaded', async () => {
        applyI18nStaticLabels();
        // 初期表示
        update(0, totalInit);
        try { await api.runtime.sendMessage({ type: 'progress-ready', key }); } catch { }
    });

    // 背景からのブロードキャストを受ける（keyで識別）
    api.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.key !== key) return;
        if (msg.type === 'progress-start') {
            setWarn('');
            btnCancel.hidden = false;
            btnCancel.disabled = false;
            setText(btnCancel, I18N.cancel);
            update(0, Number(msg.n || totalInit));
        } else if (msg.type === 'progress-update') {
            update(Number(msg.i || 0), Number(msg.n || totalInit));
        } else if (msg.type === 'progress-error') {
            setError(String(msg.message || I18N.error));
            btnCancel.hidden = true;
            btnClose.hidden = false;
        } else if (msg.type === 'progress-done' || msg.type === 'progress-cancelled') {
            if (bar) { bar.value = bar.max; }
            if (label) label.textContent = I18N.done;
            if (pct) pct.textContent = '100%';
            btnCancel.hidden = true;
            btnClose.hidden = true; // 自動クローズするので表示不要
            autoCloseSoon();
        }
    });
})();
