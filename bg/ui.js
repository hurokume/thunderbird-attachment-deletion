// bg/ui.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const { MENU_ID } = BD.const;

    function openConfirmPageAndWait(key, stats) {
        return new Promise(async (resolve) => {
            const onMsg = (msg, sender, sendResponse) => {
                if (!msg || msg.type !== 'confirm-result' || msg.key !== key) return;
                try { sendResponse({ ack: true }); } catch (_) { }
                api.runtime.onMessage.removeListener(onMsg);
                if (sender?.tab?.windowId) {
                    api.windows.remove(sender.tab.windowId).catch(() => { });
                }
                resolve(!!msg.ok);
            };
            api.runtime.onMessage.addListener(onMsg);

            const base = api.runtime.getURL('ui/confirm.html');
            const url = `${base}?key=${encodeURIComponent(key)}&affected=${encodeURIComponent(stats.affectedMessages)}&total=${encodeURIComponent(stats.totalAttachments)}&bytes=${encodeURIComponent(stats.totalBytes)}`;
            await api.windows.create({ url, type: 'popup', width: 680, height: 560 });
        });
    }

    function createMenus() {
        if (api?.menus?.create) {
            try {
                api.menus.create({ id: MENU_ID, title: 'Delete attachments from selection…', contexts: ['message_list'] });
            } catch (_) { /* already exists */ }
        }
    }

    BD.ui = { openConfirmPageAndWait, createMenus };
})(globalThis.BD);
