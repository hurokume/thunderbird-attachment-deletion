// Shared by background scripts and extension pages. Thunderbird resolves locale
// variants and falls back to manifest.default_locale when a message is missing.
(() => {
    'use strict';
    const api = typeof messenger !== 'undefined' ? messenger : browser;
    const t = (key, substitutions = []) => api.i18n.getMessage(key,
        (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String));
    const locale = t('locale');
    const number = (value, options = {}) => new Intl.NumberFormat(locale, options).format(Number(value) || 0);
    const date = value => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
    function size(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Math.max(0, Number(bytes) || 0), unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
        return t('fileSize', [number(value, { minimumFractionDigits: unit ? 1 : 0, maximumFractionDigits: unit ? 1 : 0 }), units[unit]]);
    }
    function details(summary, error) {
        const message = String(error?.message || error || '');
        return message && message !== summary ? t('errorWithDetails', [summary, message]) : summary;
    }
    function apply(root = document) {
        if (root.documentElement) {
            root.documentElement.lang = locale;
            root.documentElement.dir = t('direction');
        }
        for (const node of root.querySelectorAll('[data-i18n]')) {
            node.textContent = t(node.getAttribute('data-i18n'));
        }
        for (const attribute of ['title', 'aria-label', 'placeholder']) {
            for (const node of root.querySelectorAll('[data-i18n-' + attribute + ']')) {
                node.setAttribute(attribute, t(node.getAttribute('data-i18n-' + attribute)));
            }
        }
        for (const template of root.querySelectorAll('template')) apply(template.content);
    }
    globalThis.BDI18n = { t, locale, number, date, size, details, apply };
})();
