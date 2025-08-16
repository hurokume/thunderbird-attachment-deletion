// bg/ui.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const { MENU_ID } = BD.const;

    // 汎用：拡張ページを開いて、runtime.onMessageで結果を待つ
    async function openExtPageAndWait({ url, width, height, responseType, key }) {
        return new Promise(async (resolve) => {
            const listener = (msg, sender, sendResponse) => {
                if (!msg || msg.type !== responseType || msg.key !== key) return;
                try { sendResponse({ ack: true }); } catch (_) { }
                api.runtime.onMessage.removeListener(listener);
                // 可能なら開いたウィンドウを閉じる
                if (sender?.tab?.windowId) {
                    api.windows.remove(sender.tab.windowId).catch(() => { });
                } else if (sender?.tab?.id) {
                    api.tabs.remove(sender.tab.id).catch(() => { });
                }
                resolve(!!msg.ok);
            };
            api.runtime.onMessage.addListener(listener);

            // まず popup ウィンドウでトライ → 失敗したらタブで開く
            try {
                await api.windows.create({ url, type: 'popup', width, height });
            } catch (e) {
                console.warn('windows.create failed, fallback to tabs.create:', e?.message || e);
                await api.tabs.create({ url });
            }
        });
    }

    function openConfirmPageAndWait(key, stats) {
        const base = api.runtime.getURL('ui/confirm.html');
        const url =
            `${base}?key=${encodeURIComponent(key)}` +
            `&affected=${encodeURIComponent(stats.affectedMessages)}` +
            `&total=${encodeURIComponent(stats.totalAttachments)}` +
            `&bytes=${encodeURIComponent(stats.totalBytes)}`;
        return openExtPageAndWait({
            url, width: 680, height: 560, responseType: 'confirm-result', key
        });
    }

    function openPreflightAndWait(totalSelected) {
        const key = `preflight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const base = api.runtime.getURL('ui/preflight.html');
        const url = `${base}?key=${encodeURIComponent(key)}&count=${encodeURIComponent(totalSelected)}`;
        return openExtPageAndWait({
            url, width: 580, height: 360, responseType: 'preflight-result', key
        });
    }

    function createMenus() {
        if (api?.menus?.create) {
            try {
                api.menus.create({ id: MENU_ID, title: 'Delete attachments from selection…', contexts: ['message_list'] });
            } catch (_) { /* already exists */ }
        }
    }

    BD.ui = { openConfirmPageAndWait, openPreflightAndWait, createMenus };
})(globalThis.BD);
