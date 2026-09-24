(function (BD) {
    'use strict';
    const api = BD.api;
    const { t } = globalThis.BDI18n;
    const title = t('menuDelete');
    const uuid = () => crypto.randomUUID();
    const openWindow = url => api.windows.create({ url, type: 'popup', width: 980, height: 720 });
    const closeWindow = async id => {
        if (id != null) await api.windows.remove(id).catch(() => {});
    };

    // Register before windows.create: a page may respond before creation resolves.
    async function waitForDialog(url, key, type) {
        let windowId, timer, settled = false, resolveResult;
        const closed = new Set();
        const result = new Promise(resolve => { resolveResult = resolve; });
        const finish = ok => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveResult(ok);
        };
        const onMessage = (msg, sender, sendResponse) => {
            if (msg?.type !== type || msg.key !== key) return;
            sendResponse({ ack: true });
            finish(msg.ok === true);
        };
        const onRemoved = id => {
            closed.add(id);
            if (id === windowId) finish(false);
        };
        api.runtime.onMessage.addListener(onMessage);
        api.windows.onRemoved.addListener(onRemoved);
        timer = setTimeout(() => finish(false), 600000);
        try {
            const win = await openWindow(url);
            windowId = win.id;
            if (closed.has(windowId)) finish(false);
            return await result;
        } finally {
            clearTimeout(timer);
            api.runtime.onMessage.removeListener(onMessage);
            api.windows.onRemoved.removeListener(onRemoved);
            await closeWindow(windowId);
        }
    }

    async function openConfirmPageAndWait(payload) {
        const key = 'confirm_' + uuid();
        await api.storage.local.set({ [key]: payload });
        try {
            const stats = payload.stats;
            const params = new URLSearchParams({
                key, affected: stats.affectedMessages, total: stats.totalAttachments, bytes: stats.totalBytes
            });
            return await waitForDialog(api.runtime.getURL('ui/confirm.html?' + params), key, 'confirm-result');
        } finally {
            await api.storage.local.remove(key);
        }
    }

    async function openPreflightAndWait(count) {
        const key = uuid();
        return waitForDialog(api.runtime.getURL('ui/preflight.html?' + new URLSearchParams({ key, count })),
            key, 'preflight-result');
    }

    async function openProgressPage({ total = 0, mode = 'attachments' } = {}) {
        const key = uuid();
        const controller = new AbortController();
        let windowId, readyTimer, resolveReady, terminal = false, disposed = false;
        const closed = new Set();
        const ready = new Promise(resolve => { resolveReady = resolve; });
        const cancel = () => { controller.abort(); resolveReady(false); };
        const onMessage = (msg, sender, sendResponse) => {
            if (msg?.key !== key) return;
            if (msg.type === 'progress-ready') {
                sendResponse({ ack: true });
                clearTimeout(readyTimer);
                resolveReady(true);
            } else if (msg.type === 'progress-cancel') {
                sendResponse({ ack: true });
                cancel();
            }
        };
        const onRemoved = id => {
            closed.add(id);
            if (id === windowId && !terminal) cancel();
        };
        const dispose = async ({ close = false } = {}) => {
            if (!disposed) {
                disposed = true;
                clearTimeout(readyTimer);
                api.runtime.onMessage.removeListener(onMessage);
                api.windows.onRemoved.removeListener(onRemoved);
            }
            if (close) await closeWindow(windowId);
        };
        api.runtime.onMessage.addListener(onMessage);
        api.windows.onRemoved.addListener(onRemoved);
        readyTimer = setTimeout(() => resolveReady(false), 20000);
        try {
            const url = api.runtime.getURL('ui/progress.html?' + new URLSearchParams({ key, total, mode }));
            const win = await api.windows.create({ url, type: 'popup', width: 680, height: 560 });
            windowId = win.id;
            if (closed.has(windowId)) cancel();
            if (!await ready) {
                BD.utils.throwIfAborted(controller.signal);
                throw new Error(t('progressNotReady'));
            }
            BD.utils.throwIfAborted(controller.signal);
        } catch (error) {
            await dispose({ close: true });
            throw error;
        }
        const send = async (type, payload = {}) => {
            try {
                const response = await api.runtime.sendMessage({ type, key, ...payload });
                if (!response?.ack) throw new Error(t('progressDisconnected'));
            } catch (error) {
                cancel();
                BD.utils.throwIfAborted(controller.signal);
            }
        };
        const finish = async (type, payload) => {
            terminal = true;
            try { await send(type, payload); } catch { /* Window may have been closed to cancel. */ }
            finally { await dispose(); }
        };
        return {
            signal: controller.signal,
            scan: (i, n) => send('progress-scan', { i, n }),
            update: progress => send('progress-update', progress),
            finish: result => finish(result.cancelled ? 'progress-cancelled' : 'progress-done', { result }),
            error: message => finish('progress-error', { message }),
            dispose
        };
    }

    async function createMenus() {
        await api.menus.remove(BD.const.MENU_ID).catch(() => {});
        api.menus.create({ id: BD.const.MENU_ID, title, contexts: ['message_list'] });
    }

    // Register on every event-page load, not only onInstalled/onStartup.
    api.menus.onShown.addListener(async info => {
        if (!info.contexts?.includes('message_list')) return;
        try {
            await api.menus.update(BD.const.MENU_ID, { enabled: !BD.state.running });
            await api.menus.refresh();
        } catch (error) { console.warn('Menu update:', error); }
    });
    BD.ui = { openConfirmPageAndWait, openPreflightAndWait, openProgressPage, createMenus };
})(globalThis.BD);
