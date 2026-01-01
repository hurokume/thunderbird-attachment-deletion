// bg/ui.js
// - 確認フォーム（confirm.html）: openConfirmPageAndWait
// - 進捗フォーム（progress.html）: openProgressPage（Cancel対応）
// - 多量選択時プリフライト: openPreflightAndWait（ページ無ければ true）
// - 右クリックメニュー: createMenus（i18n & 選択件数に応じた動的タイトル）

(function (BD) {
    'use strict';

    const api = BD.api || (typeof messenger !== 'undefined' ? messenger : browser);

    /* ================= i18n ================= */

    function detectLang() {
        const lang = (api?.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
        if (lang.startsWith('ja')) return 'ja';
        if (lang.startsWith('zh')) return 'zh';
        return 'en';
    }
    const LANG = detectLang();

    const T = {
        en: {
            // 固定ラベル（固定表示にしたい場合はこれだけ編集）
            menuDelete: 'Delete attachments (with backup)',
            // 選択件数に応じて変える場合はこちらが使われます
            menuDeleteDynamic: (n) => n === 1
                ? 'Delete attachments (with backup) — 1 message'
                : `Delete attachments (with backup) — ${n} messages`,
            preflightTitle: 'Preflight',
            preflightSubtitle: (n) => `You selected ${n} messages. Do you want to proceed?`
        },
        ja: {
            menuDelete: '添付ファイルを削除（バックアップ保存あり）',
            menuDeleteDynamic: (n) => `添付ファイルを削除（バックアップ保存）— ${n}件`,
            preflightTitle: '事前確認',
            preflightSubtitle: (n) => `${n}件のメッセージが選択されています。続行しますか？`
        },
        zh: {
            menuDelete: '删除附件（含备份）',
            menuDeleteDynamic: (n) => `删除附件（含备份）— ${n} 封`,
            preflightTitle: '预检查',
            preflightSubtitle: (n) => `已选择 ${n} 封邮件。是否继续？`
        }
    }[LANG];

    /* ================= helpers ================= */

    function _uuid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }

    async function _openWindow(url, { width = 900, height = 700, type = 'popup' } = {}) {
        try { return await api.windows.create({ url, type, width, height }); }
        catch { return await api.windows.create({ url }); }
    }

    function _onceMessage(predicate, timeoutMs = 30000) {
        return new Promise((resolve) => {
            let finished = false;
            const handler = (msg) => {
                try {
                    if (predicate(msg)) {
                        finished = true;
                        api.runtime.onMessage.removeListener(handler);
                        resolve(msg);
                    }
                } catch { }
            };
            api.runtime.onMessage.addListener(handler);
            if (timeoutMs > 0) {
                setTimeout(() => {
                    if (finished) return;
                    try { api.runtime.onMessage.removeListener(handler); } catch { }
                    resolve(undefined);
                }, timeoutMs);
            }
        });
    }

    async function _getSelectionCount(tabId) {
        try {
            let page = await api.mailTabs.getSelectedMessages(tabId);
            let count = (page.messages || []).length;
            while (page.id) {
                page = await api.messages.continueList(page.id);
                count += (page.messages || []).length;
            }
            return count;
        } catch {
            return 0;
        }
    }

    /* ================= confirm.html ================= */

    async function openConfirmPageAndWait(payload) {
        const key = _uuid();

        // confirm.js が使うデータを保存
        try {
            await api.storage.local.set({
                [key]: {
                    stats: payload?.stats || {},
                    messages: Array.isArray(payload?.messages) ? payload.messages : []
                }
            });
        } catch (e) {
            console.error('[BAD] storage set failed for confirm data:', e?.message || e);
            return false;
        }

        const affected = Number(payload?.stats?.affectedMessages ?? 0);
        const total = Number(payload?.stats?.totalAttachments ?? 0);
        const bytesF = (typeof payload?.stats?.totalSize === 'number')
            ? payload.stats.totalSize
            : (typeof payload?.stats?.totalBytes === 'number' ? payload.stats.totalBytes : NaN);

        // フォールバックで bytes 推定
        let bytesNum = Number.isFinite(bytesF) ? bytesF : 0;
        if (!bytesNum && Array.isArray(payload?.stats?.extSummary)) {
            bytesNum = payload.stats.extSummary.reduce((s, r) => s + (Number(r?.bytes) || 0), 0);
        }
        if (!bytesNum && Array.isArray(payload?.messages)) {
            bytesNum = payload.messages.reduce((s, m) =>
                s + (m?.attachments || []).reduce((a, x) => a + (Number(x?.size) || 0), 0), 0
            );
        }

        const url = api.runtime.getURL(
            `ui/confirm.html?affected=${encodeURIComponent(affected)}&total=${encodeURIComponent(total)}&bytes=${encodeURIComponent(bytesNum)}&key=${encodeURIComponent(key)}`
        );

        await _openWindow(url, { width: 980, height: 720 });

        // confirm.js → runtime.sendMessage({ type:'confirm-result', key, ok })
        const msg = await _onceMessage((m) => m && m.type === 'confirm-result' && m.key === key, 600000);
        try { await api.storage.local.remove(key); } catch { }

        return !!(msg && msg.ok === true);
    }

    /* ================= progress.html ================= */

    async function openProgressPage({ total = 0 } = {}) {
        const key = _uuid();
        const url = api.runtime.getURL(
            `ui/progress.html?total=${encodeURIComponent(total)}&key=${encodeURIComponent(key)}`
        );

        await _openWindow(url, { width: 520, height: 240 });

        // ページの ready を待機（progress.js → 'progress-ready'）
        await _onceMessage((m) => m && m.type === 'progress-ready' && m.key === key, 20000);

        let cancelled = false;
        const cancelHandler = (msg) => {
            if (msg && msg.type === 'progress-cancel' && msg.key === key) {
                cancelled = true;
            }
        };
        api.runtime.onMessage.addListener(cancelHandler);

        const send = (type, payload) => api.runtime.sendMessage(Object.assign({ type, key }, payload || {}));

        return {
            key,
            start: (n) => send('progress-start', { n }),
            update: (i, n) => send('progress-update', { i, n }),
            done: () => send('progress-done'),
            cancelled: () => send('progress-cancelled'),
            error: (message) => send('progress-error', { message }),
            isCancelled: () => cancelled
        };
    }

    /* ================= preflight.html（任意） ================= */

    async function openPreflightAndWait(count) {
        const key = _uuid();
        const url = api.runtime.getURL(
            `ui/preflight.html?count=${encodeURIComponent(count)}&key=${encodeURIComponent(key)}`
        );
        try {
            await _openWindow(url, { width: 420, height: 220 });
            // ready
            await _onceMessage((m) => m && m.type === 'preflight-ready' && m.key === key, 20000);
            // result
            const res = await _onceMessage((m) => m && m.type === 'preflight-result' && m.key === key, 600000);
            return !!(res && res.ok === true);
        } catch {
            // ページが無い/開けない場合は、既定で進める
            return true;
        }
    }

    /* ================= menus ================= */

    function createMenus() {
        const id = (BD?.const && BD.const.MENU_ID) ? BD.const.MENU_ID : 'bulk-attachment-deleter.menu.delete';

        // 既に存在していても例外にしない
        try {
            api.menus.create({
                id,
                title: T.menuDelete,     // 初期タイトル（のちほど onShown で動的更新）
                contexts: ['message_list'],
                // Thunderbird/Firefox ではアイコンを指定できる場合があります（任意）
                // icons: { 16: 'images/icon.svg' }
            }, () => void 0);
        } catch (e) {
            console.warn('menus.create warn:', e?.message || e);
        }

        // 右クリックが開かれるたびに選択件数に応じてタイトルを差し替え
        try {
            api.menus.onShown.addListener(async (info, tab) => {
                try {
                    if (!info?.contexts || !info.contexts.includes('message_list')) return;

                    const tabId = tab?.id ?? info?.tabId;
                    const count = await _getSelectionCount(tabId);

                    const title = (typeof T.menuDeleteDynamic === 'function')
                        ? T.menuDeleteDynamic(count)
                        : T.menuDelete;

                    await api.menus.update(id, { title });
                    try { await api.menus.refresh(); } catch { }
                } catch (e) {
                    console.warn('menus.onShown update failed:', e?.message || e);
                }
            });
        } catch (e) {
            // 古い環境などで onShown が無い場合は無視
        }
    }

    /* ================= export ================= */

    BD.ui = Object.assign(BD.ui || {}, {
        openConfirmPageAndWait,
        openProgressPage,
        openPreflightAndWait,
        createMenus
    });

})(globalThis.BD || (globalThis.BD = {}));
