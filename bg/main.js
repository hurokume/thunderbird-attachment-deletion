// bg/main.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const { humanSize } = BD.utils;
    const {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        saveAllAttachmentsVerified,
        saveMessageBodiesVerified
    } = BD.mail;
    const { openConfirmPageAndWait, openPreflightAndWait, createMenus } = BD.ui;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

        try {
            // 0) 選択メッセージIDの取得
            const ids = await getAllSelectedMessageIds();

            // 0.5) 大量選択時のプリフライト（UIを必ず開く）
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
            const { targets, metaById, stats, messages, idsWithAttachments } = await buildTargetsAndStats(ids);

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

            // 2) 確認ダイアログ（ページ仕様と同期）
            // confirm.html は URL クエリで概要を表示し、storage.local の [key] から詳細を読む設計。:contentReference[oaicite:9]{index=9} :contentReference[oaicite:10]{index=10}
            const ok = await openConfirmPageAndWait({
                stats,
                messages
                // idsWithAttachments はページで未使用なので不要（必要なら保存対象に含めても可）
            });
            if (!ok) {
                await api.notifications.create({
                    type: 'basic',
                    title: 'Cancelled',
                    message: 'User cancelled at confirmation dialog. No changes made.'
                });
                return;
            }

            // 3) バックアップ：添付
            const { savedCount: attSavedCount, failCount: attFail } =
                await saveAllAttachmentsVerified(targets, metaById);

            // 4) バックアップ：本文
            const { savedCount: bodySavedCount, failCount: bodyFailCount } =
                await saveMessageBodiesVerified(ids);

            // 5) 削除対象の集約
            const deleteTargets = [];
            let deletables = 0;
            for (const t of targets) {
                if (t.partNames?.length) {
                    deleteTargets.push({ id: t.id, partNames: t.partNames });
                    deletables += t.partNames.length;
                }
            }

            // 6) 削除（チャンク化＋再解決＋フォールバック）
            const CHUNK_SIZE = 16; // 小さめが安全（16〜32 推奨）
            const parsePart = (s) => s.split('.').map(n => parseInt(n, 10)).filter(Number.isFinite);
            // “深い/大きい順” に消すと再番号付けの影響を受けにくい
            const cmpPartDesc = (a, b) => {
                const A = parsePart(a), B = parsePart(b);
                const L = Math.max(A.length, B.length);
                for (let i = 0; i < L; i++) {
                    const av = A[i] ?? -1, bv = B[i] ?? -1;
                    if (av !== bv) return bv - av;       // 大きい方を先に
                }
                return B.length - A.length;
            };

            let deleted = 0;
            for (const { id, partNames: original } of deleteTargets) {
                // まだ削除していない “狙いリスト”
                let remaining = [...original];

                while (remaining.length) {
                    // いま実在する添付の partName を取り直す
                    const live = new Set((await BD.api.messages.listAttachments(id)).map(a => a.partName)); // Thunderbid messages API
                    // まだ残っていて、今も存在するものを抽出
                    const candidates = remaining.filter(p => live.has(p)).sort(cmpPartDesc);
                    if (!candidates.length) break;

                    const chunk = candidates.slice(0, CHUNK_SIZE);
                    try {
                        await BD.api.messages.deleteAttachments(id, chunk);
                        deleted += chunk.length;
                    } catch (e) {
                        // 失敗時は 1 件ずつフォールバック
                        for (const p of chunk) {
                            try { await BD.api.messages.deleteAttachments(id, [p]); deleted += 1; }
                            catch (ee) { console.warn('deleteAttachments failed for', id, p, ee?.message || ee); }
                        }
                    }
                    // 今回処理したものを remaining から除去
                    const done = new Set(chunk);
                    remaining = remaining.filter(p => !done.has(p));
                    await sleep(0); // イベントループに譲る（UI 固まり対策）
                }
            }

            // 7) 結果通知
            const issues = [];
            if (attFail) issues.push(`${attFail} attachment(s) had backup errors`);
            if (bodyFailCount) issues.push(`${bodyFailCount} message bodies had backup errors`);
            const tail = issues.length ? `\nNotes: ${issues.join('; ')}` : '';

            const expectedAttachmentsSaved = stats.totalAttachments;
            const actualAttachmentsSaved = attSavedCount;

            await api.notifications.create({
                type: 'basic',
                title: 'Backup & Deletion Completed',
                message:
                    `${stats.affectedMessages} messages selected\n` +
                    `${actualAttachmentsSaved}/${expectedAttachmentsSaved} attachments saved\n` +
                    `${deleted}/${deletables} attachments deleted${tail}`
            });

        } catch (e) {
            console.error(e);
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
