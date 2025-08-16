// bg/main.js
'use strict';
const { BD } = globalThis;
const { api } = BD;
const { STRICT_BACKUP } = BD.const;
const { humanSize } = BD.utils;
const { getAllSelectedMessageIds, buildTargetsAndStats,
    saveAllAttachmentsVerified, saveMessageBodiesVerified } = BD.mail;
const { openConfirmPageAndWait, createMenus } = BD.ui;

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
        const ids = await getAllSelectedMessageIds();
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

        // 1) 添付バックアップ＆厳格検証
        const { successMap, failCount: attFail, savedCount: attSaved } =
            await saveAllAttachmentsVerified(targets, metaById);

        // 2) 本文バックアップ＆厳格検証（全選択）
        const { bodyOkMap, bodyFailCount } =
            await saveMessageBodiesVerified(ids, metaById);

        // ---- ★ STRICT: すべて保存できていなければ削除を中止 ----
        // 期待される添付総数
        const expectedAttachmentTotal = targets.reduce((n, t) => n + t.partNames.length, 0);
        // 実際に保存できた添付数
        const actualAttachmentSaved = [...successMap.values()].reduce((n, set) => n + set.size, 0);

        // 添付のあるメール数に対する本文保存成功数
        const expectedBodyCount = idsWithAttachments.length;
        const actualBodySaved = idsWithAttachments.filter(id => bodyOkMap.has(id)).length;

        let strictAbort = false;
        const missingDetails = [];

        if (STRICT_BACKUP) {
            if (actualAttachmentSaved !== expectedAttachmentTotal) {
                strictAbort = true;
                // 欠損の明細（上限5件）
                const missing = [];
                for (const { id, partNames } of targets) {
                    const okSet = successMap.get(id) || new Set();
                    for (const pn of partNames) {
                        if (!okSet.has(pn)) missing.push({ id, partName: pn });
                        if (missing.length >= 5) break;
                    }
                    if (missing.length >= 5) break;
                }
                missingDetails.push(`attachments saved ${actualAttachmentSaved}/${expectedAttachmentTotal}` + (missing.length ? ` (missing sample: ${missing.map(m => `${m.id}:${m.partName}`).join(', ')})` : ''));
            }
            if (actualBodySaved !== expectedBodyCount) {
                strictAbort = true;
                const missingIds = idsWithAttachments.filter(id => !bodyOkMap.has(id)).slice(0, 5);
                missingDetails.push(`bodies saved ${actualBodySaved}/${expectedBodyCount}` + (missingIds.length ? ` (missing sample IDs: ${missingIds.join(', ')})` : ''));
            }
        }

        if (strictAbort) {
            await api.notifications.create({
                type: 'basic',
                title: 'Backup not complete — Deletion aborted',
                message: `Backup verification failed.\n${missingDetails.join('\n')}`
            });
            return;
        }

        // 3) （念のため）削除対象 = 「本文OK」かつ「添付バックアップOK」のパーツのみ
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

        // 4) 削除実行
        let deleted = 0;
        for (const { id, partNames } of deleteTargets) {
            await api.messages.deleteAttachments(id, partNames);
            deleted += partNames.length;
        }

        // 5) 結果通知
        const issues = [];
        if (attFail) issues.push(`${attFail} attachment(s) failed backup`);
        if (bodyFailCount) issues.push(`${bodyFailCount} message bodies failed backup`);
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
