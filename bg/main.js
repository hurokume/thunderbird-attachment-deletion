// bg/main.js
// 確認後に進捗フォームを表示し、添付は「保存→検証→（成功分だけ）即削除」を小刻みに実行。
// - 本文保存は行わない
// - 添付ファイルごとに 1 秒待機、メッセージごとに 5 秒クールダウン
// - 進捗フォームで Cancel を受け付け、中断可（完了分まで）

(function (BD) {
    'use strict';

    const api = BD.api;

    const {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        saveAllAttachmentsVerified
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
            cancelled() { },
            error() { },
            isCancelled() { return false; }
        };
    }

    async function deleteAllAttachmentsOnSelectedMessages() {
        if (!api?.messages?.deleteAttachments) {
            await api.notifications.create({
                type: 'basic',
                title: 'Unable to use messages.deleteAttachments API',
                message:
                    'messages.deleteAttachments is unavailable. ' +
                    'Check permissions (messagesModifyPermanent) and Thunderbird version.'
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
                        shouldCancel: () => !!progressCtrl.isCancelled?.(),
                        onProgress: (p) => {
                            try {
                                if (p?.phase === 'start') {
                                    const n = p.totalToDelete ?? stats.totalAttachments;
                                    progressCtrl.start(n);
                                } else if (p?.phase === 'progress') {
                                    const n = (p.totals?.totalToDelete) ?? stats.totalAttachments;
                                    const i = (p.totals?.totalSaved || 0) + (p.totals?.totalFailedSave || 0);
                                    progressCtrl.update(i, n);
                                } else if (p?.phase === 'done') {
                                    if (p.cancelled) progressCtrl.cancelled?.();
                                    else progressCtrl.done?.();
                                }
                            } catch { }
                        }
                    }
                );
            } else {
                // フォールバック：runner が無い場合でも逐次的に処理＋Cancel対応
                try { progressCtrl.start(stats.totalAttachments); } catch { }

                // 削除の安全実行（ランナー無し時）
                const parsePart = (s) => s.split('.').map(n => parseInt(n, 10)).filter(Number.isFinite);
                const cmpPartDesc = (a, b) => {
                    const A = parsePart(a), B = parsePart(b), L = Math.max(A.length, B.length);
                    for (let i = 0; i < L; i++) { const av = A[i] ?? -1, bv = B[i] ?? -1; if (av !== bv) return bv - av; }
                    return B.length - A.length;
                };
                const deleteAttachmentsSafely = async (delTargets) => {
                    let deleted = 0, failed = 0;
                    for (const { id, partNames: wanted } of (delTargets || [])) {
                        let remaining = [...wanted];
                        while (remaining.length) {
                            const liveSet = new Set((await api.messages.listAttachments(id)).map(a => a.partName));
                            const candidates = remaining.filter(p => liveSet.has(p)).sort(cmpPartDesc);
                            if (!candidates.length) break;
                            const chunk = candidates.slice(0, 16);
                            try {
                                await api.messages.deleteAttachments(id, chunk);
                                deleted += chunk.length;
                            } catch {
                                for (const p of chunk) {
                                    try { await api.messages.deleteAttachments(id, [p]); deleted++; }
                                    catch { failed++; }
                                }
                            }
                            const done = new Set(chunk);
                            remaining = remaining.filter(p => !done.has(p));
                            await sleep(0);
                        }
                    }
                    return { deleted, failed };
                };

                let totalToDelete = stats.totalAttachments;
                let totalSaved = 0, totalFailedSave = 0, totalDeleted = 0, totalFailedDelete = 0;

                for (let idx = 0; idx < targets.length; idx++) {
                    if (progressCtrl.isCancelled?.()) break;

                    const { id, partNames } = targets[idx];

                    // このメッセージ分だけ保存
                    const { successMap, failCount, savedCount } =
                        await saveAllAttachmentsVerified([{ id, partNames }], metaById);

                    totalSaved += savedCount;
                    totalFailedSave += failCount;

                    // 成功分だけ即削除
                    const okSet = successMap.get(id) || new Set();
                    const okParts = [...okSet];
                    if (okParts.length && !progressCtrl.isCancelled?.()) {
                        const { deleted, failed } = await deleteAttachmentsSafely([{ id, partNames: okParts }]);
                        totalDeleted += deleted;
                        totalFailedDelete += failed;
                    }

                    // 進捗更新（保存成功＋失敗＝「処理済み」とみなす）
                    try {
                        const processed = totalSaved + totalFailedSave;
                        progressCtrl.update(processed, totalToDelete);
                    } catch { }

                    if (progressCtrl.isCancelled?.()) break;

                    // メッセージごとのクールダウン
                    if (idx < targets.length - 1) await sleep(5000);
                }

                // UI 終了通知
                try {
                    if (progressCtrl.isCancelled?.()) progressCtrl.cancelled?.();
                    else progressCtrl.done?.();
                } catch { }

                runResult = {
                    totals: { totalSaved, totalDeleted, totalFailedSave, totalFailedDelete, totalToDelete },
                    cancelled: !!progressCtrl.isCancelled?.()
                };
            }

            // 4) 結果通知（キャンセル時はタイトルを変更）
            const t = runResult?.totals || { totalSaved: 0, totalDeleted: 0, totalFailedSave: 0, totalFailedDelete: 0, totalToDelete: stats.totalAttachments };
            const issues = [];
            if (t.totalFailedSave) issues.push(`${t.totalFailedSave} attachment(s) had backup errors`);
            if (t.totalFailedDelete) issues.push(`${t.totalFailedDelete} attachment(s) had deletion errors`);
            const tail = issues.length ? `\nNotes: ${issues.join('; ')}` : '';

            await api.notifications.create({
                type: 'basic',
                title: runResult?.cancelled ? 'Cancelled by user' : 'Backup & Deletion Completed',
                message:
                    `${stats.selectedMessages} messages selected\n` +
                    `${stats.affectedMessages} messages with attachments\n` +
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
        if (BD.state?.menusCreated) return;
        if (!BD.state) BD.state = {};
        BD.state.menusCreated = true;
        try { createMenus(); }
        catch (e) {
            BD.state.menusCreated = false;
            console.warn('createMenus failed (will ignore if already exists):', e?.message || e);
        }
    }

    // 初期バインド（多重登録防止）
    if (!BD.state?.bound) {
        if (!BD.state) BD.state = {};
        // ★ ここは削除：ツールバーの action を使わない
        // api.action.onClicked.addListener(deleteAllAttachmentsOnSelectedMessages);

        api.runtime.onInstalled.addListener(() => ensureMenusOnce());
        api.runtime.onStartup.addListener(() => ensureMenusOnce());
        api.menus.onClicked.addListener(info => {
            if (info.menuItemId === (BD.const?.MENU_ID || 'bulk-attachment-deleter.menu.delete')) {
                deleteAllAttachmentsOnSelectedMessages();
            }
        });
        BD.state.bound = true;
    }
})(globalThis.BD || (globalThis.BD = {}));
