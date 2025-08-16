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

    async function deleteAllAttachmentsOnSelectedMessages() {
        if (!api?.messages?.deleteAttachments) {
            await api.notifications.create({
                type: 'basic',
                title: 'Unable to use messages.deleteAttachments API',
                message: 'messages.deleteAttachments is unavailable. Check permissions (messagesModifyPermanent) and Thunderbird 123+.'
            });
            console.error('messages.deleteAttachments unavailable');
            return;
        }

        try {
            // 0) まず選択通数だけ取得（軽量）
            const ids = await getAllSelectedMessageIds();

            // ★ 評価（添付走査など）に入る前にプリフライト警告
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

            // 1) ここから評価（添付一覧・サイズ集計など）
            const { targets, metaById, stats, messages, idsWithAttachments } = await buildTargetsAndStats(ids);

            if (stats.totalAttachments === 0) {
                await api.notifications.create({
                    type: 'basic',
                    title: 'No deletable attachments',
                    message: 'No removable attachments were found in the selected messages.'
                });
                return;
            }

            if (!api?.storage?.local) {
                console.error("storage.local is unavailable: check 'storage' permission in manifest.");
            }
            const key = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await api.storage.local.set({ [key]: { createdAt: Date.now(), stats, messages } });

            const ok = await openConfirmPageAndWait(key, stats);
            api.storage.local.remove(key).catch(() => { });
            if (!ok) {
                await api.notifications.create({ type: 'basic', title: 'Cancelled', message: 'Bulk deletion was cancelled.' });
                return;
            }

            // 2) 添付バックアップ＆検証
            const { successMap, failCount: attFail, savedCount: attSaved } =
                await saveAllAttachmentsVerified(targets, metaById);

            // 3) 本文バックアップ＆検証（添付のあるメールのみ）
            const { bodyOkMap, bodyFailCount } =
                await saveMessageBodiesVerified(idsWithAttachments, metaById);

            // 4) すべて保存できていなければ削除を中止
            const expectedAttachmentTotal = targets.reduce((n, t) => n + t.partNames.length, 0);
            const actualAttachmentSaved = [...successMap.values()].reduce((n, set) => n + set.size, 0);
            const expectedBodyCount = idsWithAttachments.length;
            const actualBodySaved = idsWithAttachments.filter(id => bodyOkMap.has(id)).length;

            if (actualAttachmentSaved !== expectedAttachmentTotal || actualBodySaved !== expectedBodyCount) {
                const missAtt = `${actualAttachmentSaved}/${expectedAttachmentTotal} attachments`;
                const missBody = `${actualBodySaved}/${expectedBodyCount} bodies (for messages with attachments)`;
                await api.notifications.create({
                    type: 'basic',
                    title: 'Backup not complete — Deletion aborted',
                    message: `Backup verification failed.\nSaved: ${missAtt}\nSaved: ${missBody}`
                });
                return;
            }

            // 5) 削除対象（冗長防御）
            const deleteTargets = [];
            let deletables = 0;
            for (const { id, partNames } of targets) {
                if (!bodyOkMap.has(id)) continue;
                const okSet = successMap.get(id);
                if (!okSet) continue;
                const okParts = partNames.filter(p => okSet.has(p));
                if (okParts.length) {
                    deleteTargets.push({ id, partNames: okParts });
                    deletables += okParts.length;
                }
            }

            // 6) 削除実行
            let deleted = 0;
            for (const { id, partNames } of deleteTargets) {
                await api.messages.deleteAttachments(id, partNames);
                deleted += partNames.length;
            }

            // 7) 結果通知
            const issues = [];
            if (attFail) issues.push(`${attFail} attachment(s) had backup errors`);
            if (bodyFailCount) issues.push(`${bodyFailCount} message bodies had backup errors`);
            const tail = issues.length ? `\nNotes: ${issues.join(', ')}` : '';

            await api.notifications.create({
                type: 'basic',
                title: 'Backup & Deletion Completed',
                message:
                    `${stats.affectedMessages} messages selected\n` +
                    `${actualAttachmentSaved}/${expectedAttachmentTotal} attachments saved, ${deleted}/${deletables} attachments deleted${tail}`
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

    // 一度だけバインド
    if (!BD.state.bound) {
        api.action.onClicked.addListener(deleteAllAttachmentsOnSelectedMessages);
        api.runtime.onInstalled.addListener(createMenus);
        api.runtime.onStartup.addListener(createMenus);
        api.menus.onClicked.addListener(info => {
            if (info.menuItemId === BD.const.MENU_ID) deleteAllAttachmentsOnSelectedMessages();
        });
        BD.state.bound = true;
    }
})(globalThis.BD);
