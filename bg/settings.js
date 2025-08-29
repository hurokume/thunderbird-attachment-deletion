// bg/settings.js
(function (BD) {
    'use strict';
    const api = BD.api || (typeof messenger !== 'undefined' ? messenger : browser);

    const STORAGE_KEY = 'settings.saveRoot';
    const DEFAULT_ROOT = 'BulkAttachmentBackup'; // Downloads フォルダ直下の既定サブフォルダ
    let _cache = null; // 文字列 or null(未ロード)

    // "foo/bar" のようなサブパスを安全化（各セグメントをサニタイズ）
    function sanitizeSubpath(path) {
        const { sanitizePathSegment } = BD.utils;
        const parts = String(path || '')
            .split('/')
            .map(p => sanitizePathSegment(p, { max: 60 }))
            .filter(p => !!p);
        // 空なら既定値へ
        return parts.length ? parts.join('/') : DEFAULT_ROOT;
    }

    async function load() {
        try {
            const got = await api.storage.local.get(STORAGE_KEY);
            const v = got[STORAGE_KEY];
            if (typeof v === 'string' && v.trim()) {
                _cache = sanitizeSubpath(v);
            } else {
                _cache = DEFAULT_ROOT;
            }
        } catch {
            _cache = DEFAULT_ROOT;
        }
        return _cache;
    }

    async function getSaveRoot() {
        if (typeof _cache === 'string' && _cache) return _cache;
        return load();
    }

    async function setSaveRoot(v) {
        const sanitized = sanitizeSubpath(v);
        _cache = sanitized;
        await api.storage.local.set({ [STORAGE_KEY]: sanitized });
        return sanitized;
    }

    // options ページからのメッセージを処理
    api.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'get-save-root') {
            return (async () => ({ ok: true, value: await getSaveRoot() }))();
        }
        if (msg.type === 'set-save-root') {
            return (async () => {
                const value = await setSaveRoot(msg.value ?? '');
                return { ok: true, value };
            })();
        }
    });

    BD.settings = Object.assign(BD.settings || {}, {
        getSaveRoot,
        setSaveRoot,
        _sanitizeSubpath: sanitizeSubpath, // テスト/オプションUIからの使用も可
        DEFAULT_ROOT
    });
})(globalThis.BD || (globalThis.BD = {}));
