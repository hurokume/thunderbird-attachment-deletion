// bg/ui.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const CONST = BD.const || {};
    const MENU_ID = CONST.MENU_ID || 'bulk-del';

    // BD.ui の名前空間を確実に用意
    const UI = BD.ui || (BD.ui = {});

    // 一意キーを生成（confirm/preflight の往復識別用）
    function genKey(prefix = 'bulkdel') {
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    }

    // 1回限りのメッセージ待機（type と key でフィルタ）
    function waitForResultOnce({ type, key, windowId = null, tabId = null, timeoutMs = 300000 }) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } };
            const cleanup = () => {
                try { api.runtime.onMessage.removeListener(onMsg); } catch { }
                try { api.windows?.onRemoved?.removeListener(onWinRemoved); } catch { }
                try { api.tabs?.onRemoved?.removeListener(onTabRemoved); } catch { }
            };
            const onMsg = (msg, sender) => {
                if (!msg || msg.type !== type || msg.key !== key) return;
                if (windowId && sender?.tab?.windowId && sender.tab.windowId !== windowId) return;
                if (tabId && sender?.tab?.id && sender.tab.id !== tabId) return;
                // preflight: { ok: boolean }, confirm: { ok: boolean }
                done(Boolean(msg.ok));
            };
            const onWinRemoved = (wid) => { if (windowId && wid === windowId) done(false); };
            const onTabRemoved = (tid) => { if (tabId && tid === tabId) done(false); };

            api.runtime.onMessage.addListener(onMsg);
            if (api.windows?.onRemoved) api.windows.onRemoved.addListener(onWinRemoved);
            if (api.tabs?.onRemoved) api.tabs.onRemoved.addListener(onTabRemoved);
            if (timeoutMs > 0) setTimeout(() => done(false), timeoutMs);
        });
    }

    // 拡張内ページを開く（popup 優先、不可ならタブ）
    async function openDialogWithQuery(relPathWithQuery, { width = 760, height = 820 } = {}) {
        const url = api.runtime.getURL(relPathWithQuery);

        // popup window を試す
        if (api.windows?.create) {
            try {
                const win = await api.windows.create({ url, type: 'popup', width, height });
                const winId = win.id;
                const tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
                try { await api.windows.update(winId, { focused: true }); } catch { }
                return { windowId: winId, tabId, async close() { try { await api.windows.remove(winId); } catch { } } };
            } catch (e) {
                console.warn('windows.create failed, fallback to tabs.create:', e?.message || e);
            }
        }
        // タブで開く
        const tab = await api.tabs.create({ url, active: true });
        const tabId = tab.id, windowId = tab.windowId;
        return { windowId, tabId, async close() { try { await api.tabs.remove(tabId); } catch { } } };
    }

    // ====== Preflight (大量選択の注意喚起) ======
    async function openPreflightAndWait(selectedCount) {
        const key = genKey('preflight');
        const query = `ui/preflight.html?key=${encodeURIComponent(key)}&count=${encodeURIComponent(selectedCount || 0)}`;
        const dlg = await openDialogWithQuery(query, { width: 560, height: 420 });

        // ページは { type:'preflight-result', key, ok } を返す想定 :contentReference[oaicite:6]{index=6}
        const ok = await waitForResultOnce({ type: 'preflight-result', key, windowId: dlg.windowId, tabId: dlg.tabId, timeoutMs: 10 * 60 * 1000 });
        await dlg.close().catch(() => { });
        return ok;
    }

    // ====== Confirm (サマリ表示・最終確認) ======
    // bg/ui.js の中のこの関数を差し替え
    async function openConfirmPageAndWait({ stats, messages }) {
        // confirm.js は URL クエリで概要を表示し、storage.local の [key] から詳細を読む設計
        const key = genKey('confirm');

        // ページが読むデータを storage に保存（キーはそのまま）
        try {
            await api.storage.local.set({ [key]: { stats: stats || {}, messages: messages || [] } });
        } catch (e) {
            console.error('storage.local.set failed:', e);
        }

        const affected = encodeURIComponent(stats?.affectedMessages ?? 0);
        const total = encodeURIComponent(stats?.totalAttachments ?? 0);

        // --- ここが今回の修正：bytes の堅牢なフォールバック計算 ---
        // 優先度: stats.totalSize → stats.extSummary[].bytes 合計 → messages[].attachments[].size 合計
        const byteFromStats = (typeof stats?.totalSize === 'number') ? stats.totalSize : NaN;
        let bytesNum = Number.isFinite(byteFromStats) ? byteFromStats : 0;

        if (!bytesNum && Array.isArray(stats?.extSummary)) {
            bytesNum = stats.extSummary.reduce((s, r) => s + (Number(r?.bytes) || 0), 0);
        }
        if (!bytesNum && Array.isArray(messages)) {
            bytesNum = messages.reduce((s, m) =>
                s + (m?.attachments || []).reduce((a, x) => a + (Number(x?.size) || 0), 0)
                , 0);
        }
        const bytes = encodeURIComponent(bytesNum);
        // --- 修正ここまで ---

        const query = `ui/confirm.html?key=${encodeURIComponent(key)}&affected=${affected}&total=${total}&bytes=${bytes}`;
        const dlg = await openDialogWithQuery(query, { width: 820, height: 860 });

        // ページは { type:'confirm-result', key, ok } を返す想定
        const ok = await waitForResultOnce({
            type: 'confirm-result',
            key,
            windowId: dlg.windowId,
            tabId: dlg.tabId,
            timeoutMs: 10 * 60 * 1000
        });

        await dlg.close().catch(() => { });
        return ok;
    }


    // ====== メニュー生成（冪等化） ======
    async function createMenus() {
        try { await api.menus.removeAll(); } catch { }
        try {
            api.menus.create({ id: MENU_ID, title: 'Bulk delete attachments (with backup)', contexts: ['message_list'] });
        } catch (e) {
            console.warn('menus.create failed (ignored):', e?.message || e);
        }
    }

    UI.openPreflightAndWait = openPreflightAndWait;
    UI.openConfirmPageAndWait = openConfirmPageAndWait;
    UI.createMenus = createMenus;

})(globalThis.BD);
