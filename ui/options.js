// ui/options.js
(() => {
    'use strict';
    const api = (typeof messenger !== 'undefined') ? messenger : browser;

    const $ = (id) => document.getElementById(id);

    /* i18n */
    function detectLang() {
        const lang = (api?.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
        if (lang.startsWith('ja')) return 'ja';
        if (lang.startsWith('zh')) return 'zh';
        return 'en';
    }
    const LANG = detectLang();
    const T = {
        en: {
            title: 'Settings',
            subtitle: 'Choose the base folder under your Downloads.',
            labelDir: 'Save directory',
            hint: 'This is a subfolder under your Downloads. e.g., MyBackups/Attachments',
            save: 'Save',
            reset: 'Reset to default',
            preview: (v) => `Files will be saved under: Downloads/${v}/...`,
            saved: 'Saved.',
            resetDone: 'Reset to default.',
            error: 'Failed. Please try again.'
        },
        ja: {
            title: '設定',
            subtitle: 'Downloads 配下の基準フォルダを指定します。',
            labelDir: '保存先ディレクトリ',
            hint: 'Downloads フォルダ配下のサブフォルダです（例: MyBackups/Attachments）。',
            save: '保存',
            reset: '既定に戻す',
            preview: (v) => `保存先の例: Downloads/${v}/...`,
            saved: '保存しました。',
            resetDone: '既定に戻しました。',
            error: '失敗しました。もう一度お試しください。'
        },
        zh: {
            title: '设置',
            subtitle: '在“下载”目录下选择保存的根文件夹。',
            labelDir: '保存目录',
            hint: '这是“下载”目录下的子文件夹。例如：MyBackups/Attachments',
            save: '保存',
            reset: '恢复默认',
            preview: (v) => `保存位置示例：Downloads/${v}/...`,
            saved: '已保存。',
            resetDone: '已恢复默认。',
            error: '操作失败，请重试。'
        }
    }[LANG];

    function setText(el, txt) { if (el) el.textContent = String(txt ?? ''); }
    function show(el, text) { if (!el) return; el.textContent = String(text || ''); el.hidden = !text; }

    function applyI18n() {
        setText($('title'), T.title);
        setText($('subtitle'), T.subtitle);
        setText($('labelDir'), T.labelDir);
        setText($('hint'), T.hint);
        setText($('save'), T.save);
        setText($('reset'), T.reset);
    }

    function updatePreview(v) {
        setText($('preview'), T.preview(String(v || '')));
    }

    async function loadCurrent() {
        try {
            const res = await api.runtime.sendMessage({ type: 'get-save-root' });
            if (res?.ok) {
                $('dir').value = res.value || '';
                updatePreview(res.value || '');
            }
        } catch { }
    }

    async function saveValue() {
        show($('msg'), ''); show($('err'), '');
        try {
            const v = $('dir').value || '';
            const res = await api.runtime.sendMessage({ type: 'set-save-root', value: v });
            if (res?.ok) {
                updatePreview(res.value || '');
                show($('msg'), T.saved);
            } else {
                show($('err'), T.error);
            }
        } catch {
            show($('err'), T.error);
        }
    }

    async function resetDefault() {
        show($('msg'), ''); show($('err'), '');
        try {
            const res = await api.runtime.sendMessage({ type: 'set-save-root', value: '' }); // 空で既定に
            if (res?.ok) {
                $('dir').value = res.value || '';
                updatePreview(res.value || '');
                show($('msg'), T.resetDone);
            } else {
                show($('err'), T.error);
            }
        } catch {
            show($('err'), T.error);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        applyI18n();
        loadCurrent();
        $('dir').addEventListener('input', (e) => updatePreview(e.target.value));
        $('save').addEventListener('click', saveValue);
        $('reset').addEventListener('click', resetDefault);
    });
})();
