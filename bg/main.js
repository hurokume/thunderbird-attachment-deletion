// bg/main.js
// 確認後に進捗フォームを表示し、添付は「保存→検証→（成功分だけ）即削除」を小刻みに実行。
// ※ 本文保存は行わない。
// 依存: BD.api / BD.mail / BD.ui / （あれば）BD.runner

(function (BD) {
    'use strict';

    const api = BD.api;

    const {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        saveAllAttachmentsVerified // runner が無い場合のフォールバック用
    } = BD.mail;

    const {
        openConfirmPageAndWait,
        openPreflightAndWait,
        createMenus,
        openProgressPage
    } = BD.ui;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 進捗コントローラを安全に取得（失敗時は no-op を返す）
    async function openProgressSafely(total) {
        try {
            const ctrl = await openProgressPage({ total });
            if (ctrl && typeof ctrl.update === 'function') return ctrl;
        } catch (e) {
            console.warn('[BAD] progress window open failed:', e?.message || e);
        }
        // no-op
        return {
            start() { },
            update() { },
            done() { },
            error() { }
        };
    }

    async function deleteAllAttachmentsOnSelectedMessages() {
        if (!api?.messages?.deleteAttachments) {
            await api.notifications.create({
                type: 'basic',
                title: 'Unable to use messages.deleteAttachments API',
                message:
                    'messages.deleteAttachments is unavailable. ' +
                    'Check permissions (messagesModifyPermanent) and Thunderbird 123+.'
            });
            console.error('messages.deleteAttachments unavailable');
            return;
        }

        let progressCtrl = null;

        try {
            // 0) 選択メッセージIDの取得
            const ids = await getAllSelectedMessageIds();

            // 0.5) 大量選択時のプリフライト
            if (ids.length > 100) {
                const proceed = await openPreflightAndWait(ids.length);
                if (!proceed) {
                    await api.notifications.create({
                        type: 'basic',
                        title: 'Cancelled',
                        message: 'Preflight cancelled. No evaluation or changes made.'
                    });
                    return;
                }
            }

            // 1) 評価（添付列挙・サイズ集計）
            const { targets, metaById, stats, messages } = await buildTargetsAndStats(ids);

            if (!stats || typeof stats.totalAttachments !== 'number') {
                throw new Error('stats is undefined or invalid from buildTargetsAndStats');
            }
            if (stats.totalAttachments === 0) {
                await api.notifications.create({
                    type: 'basic',
                    title: 'No deletable attachments',
                    message: 'No removable attachments were found in the selected messages.'
                });
                return;
            }

            // 2) 確認ダイアログ
            const ok = await openConfirmPageAndWait({ stats, messages });
            if (!ok) {
                await api.notifications.create({
                    type: 'basic',
                    title: 'Cancelled',
                    message: 'User cancelled at confirmation dialog. No changes made.'
                });
                return;
            }

            // 2.5) 進捗ページを開く
            progressCtrl = await openProgressSafely(stats.totalAttachments);

            // 3) 添付：保存→検証→（成功分だけ）即削除（小刻み）
            let runResult = null;

            if (BD?.runner?.runBackupThenDelete) {
                runResult = await BD.runner.runBackupThenDelete(
                    targets,
                    metaById,
                    {
                        perFileDelayMs: 1000,               // 添付1ファイルごと待機
                        cooldownAfterEachMessageMs: 5000,   // 1通ごと 5 秒クールダウン
                        onProgress: (p) => {
                            try {
                                if (p?.phase === 'start') {
                                    const n = p.totalToDelete ?? stats.totalAttachments;
                                    progressCtrl.start(n);
                                } else if (p?.phase === 'progress') {
                                    // 処理済み = 保存成功 + 保存失敗 とみなす
                                    const n = (p.totals?.totalToDelete) ?? stats.totalAttachments;
                                    const i = (p.totals?.totalSaved || 0) + (p.totals?.totalFailedSave || 0);
                                    progressCtrl.update(i, n);
                                } else if (p?.phase === 'done') {
                                    progressCtrl.done();
                                }
                            } catch { }
                        }
                    }
                );
            } else {
                // フォールバック：旧フロー（全件保存→全件削除）
                try { progressCtrl.start(stats.totalAttachments); } catch { }
                const { successMap } = await saveAllAttachmentsVerified(targets, metaById);
                let processed = 0;

                const okTargets = [];
                for (const [id, okSet] of successMap.entries()) {
                    processed += okSet.size;
                    try { progressCtrl.update(processed, stats.totalAttachments); } catch { }
                    if (okSet.size) okTargets.push({ id, partNames: [...okSet] });
                }

                if (okTargets.length) {
                    if (BD?.runner?.deleteAttachmentsSafely) {
                        await BD.runner.deleteAttachmentsSafely(okTargets);
                    } else {
                        for (const { id, partNames } of okTargets) {
                            try { await api.messages.deleteAttachments(id, partNames); }
                            catch (e) {
                                // フォールバック：1件ずつ
                                for (const p of partNames) {
                                    try { await api.messages.deleteAttachments(id, [p]); }
                                    catch (ee) { console.warn('delete one failed', id, p, ee?.message || ee); }
                                }
                            }
                            // 1通ごとに 5 秒のクールダウン
                            await sleep(500);
                        }
                    }
                }
                try { progressCtrl.update(stats.totalAttachments, stats.totalAttachments); progressCtrl.done(); } catch { }
                runResult = { totals: { totalSaved: processed, totalDeleted: 0, totalFailedSave: stats.totalAttachments - processed, totalFailedDelete: 0, totalToDelete: stats.totalAttachments }, fallback: true };
            }

            // 4) 結果通知
            const t = runResult?.totals || { totalSaved: 0, totalDeleted: 0, totalFailedSave: 0, totalFailedDelete: 0, totalToDelete: stats.totalAttachments };
            const issues = [];
            if (t.totalFailedSave) issues.push(`${t.totalFailedSave} attachment(s) had backup errors`);
            if (t.totalFailedDelete) issues.push(`${t.totalFailedDelete} attachment(s) had deletion errors`);
            const tail = issues.length ? `\nNotes: ${issues.join('; ')}` : '';

            await api.notifications.create({
                type: 'basic',
                title: 'Backup & Deletion Completed',
                message:
                    `${stats.affectedMessages} messages selected\n` +
                    `${t.totalSaved}/${stats.totalAttachments} attachments saved\n` +
                    `${t.totalDeleted} attachments deleted${tail}`
            });

        } catch (e) {
            console.error(e);
            try { progressCtrl?.error?.(e?.message || String(e)); } catch { }
            await api.notifications.create({
                type: 'basic',
                title: 'Error during backup/verify/delete',
                message: e?.message || String(e)
            });
        }
    }

    // ===== メニュー多重作成の防止（idempotent wrapper）=====
    function ensureMenusOnce() {
        if (BD.state.menusCreated) return;
        BD.state.menusCreated = true;
        try { createMenus(); }
        catch (e) {
            BD.state.menusCreated = false;
            console.warn('createMenus failed (will ignore if already exists):', e?.message || e);
        }
    }

    // 初期バインド（多重登録防止）
    if (!BD.state.bound) {
        api.action.onClicked.addListener(deleteAllAttachmentsOnSelectedMessages);
        api.runtime.onInstalled.addListener(() => ensureMenusOnce());
        api.runtime.onStartup.addListener(() => ensureMenusOnce());
        api.menus.onClicked.addListener(info => {
            if (info.menuItemId === BD.const.MENU_ID) deleteAllAttachmentsOnSelectedMessages();
        });
        BD.state.bound = true;
    }
})(globalThis.BD);
