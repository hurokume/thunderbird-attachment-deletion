(function (BD) {
    'use strict';
    const api = BD.api;
    const { t, number } = globalThis.BDI18n;
    const DEFAULT_ROOT = 'BulkAttachmentBackup';
    const defaults = Object.freeze({
        saveRoot: DEFAULT_ROOT, saveMode: 'inherit', backupEnabled: true,
        perFileDelayMs: 0, cooldownAfterEachMessageMs: 0
    });

    function sanitizeSubpath(value) {
        const text = String(value || '').trim().replace(/\\/g, '/');
        if (!text) return DEFAULT_ROOT;
        if (text.startsWith('/') || /^[a-z]:/i.test(text) || text.split('/').includes('..')) {
            throw new Error(t('invalidSubfolder'));
        }
        const path = text.split('/').map(p => p.trim()).filter(p => p && p !== '.')
            .map(p => BD.utils.sanitizePathSegment(p, { max: 60 })).join('/');
        if (new TextEncoder().encode(path).length > 120) throw new Error(t('subfolderTooLong', number(120)));
        return path || DEFAULT_ROOT;
    }

    function normalize(values) {
        const delay = v => Math.min(60000, Math.max(0, Math.floor(Number(v) || 0)));
        return {
            saveRoot: sanitizeSubpath(values.saveRoot),
            saveMode: ['inherit', 'ask', 'automatic'].includes(values.saveMode) ? values.saveMode : 'inherit',
            backupEnabled: values.backupEnabled !== false,
            perFileDelayMs: delay(values.perFileDelayMs),
            cooldownAfterEachMessageMs: delay(values.cooldownAfterEachMessageMs)
        };
    }

    async function getSettings() {
        const stored = await api.storage.local.get(Object.keys(defaults).map(key => 'settings.' + key));
        return normalize(Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
            [key, stored['settings.' + key] ?? value])));
    }

    async function setSettings(values) {
        const settings = normalize({ ...await getSettings(), ...values });
        await api.storage.local.set(Object.fromEntries(Object.entries(settings).map(([key, value]) =>
            ['settings.' + key, value])));
        return settings;
    }

    api.runtime.onMessage.addListener(msg => {
        if (msg?.type === 'get-settings') return getSettings().then(value => ({ ok: true, value }));
        if (msg?.type === 'set-settings') return setSettings(msg.value || {}).then(value => ({ ok: true, value }));
        if (msg?.type === 'reset-settings') return setSettings(defaults).then(value => ({ ok: true, value }));
    });

    BD.settings = { getSettings, setSettings, defaults, DEFAULT_ROOT, sanitizeSubpath };
})(globalThis.BD);
