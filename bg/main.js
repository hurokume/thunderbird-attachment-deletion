(function (BD) {
    'use strict';
    const api = BD.api;
    const { t, number } = globalThis.BDI18n;
    const { throwIfAborted } = BD.utils;
    const notify = (title, message) => api.notifications.create({ type: 'basic', title, message })
        .catch(error => console.warn('Notification:', error));

    async function deleteAllAttachmentsOnSelectedMessages(tabId) {
        if (BD.state.running) {
            await notify(t('alreadyRunning'), t('alreadyRunningMessage'));
            return;
        }
        // Set synchronously, before the first await.
        BD.state.running = true;
        let progress;
        try {
            if (!api.messages?.deleteAttachments) throw new Error(t('deletionUnavailable'));
            const ids = await BD.mail.getAllSelectedMessageIds(tabId);
            if (!ids.length) { await notify(t('noSelection'), t('selectMessages')); return; }
            if (ids.length > 100 && !await BD.ui.openPreflightAndWait(ids.length)) return;

            progress = await BD.ui.openProgressPage({ total: ids.length, mode: 'scan' });
            await progress.scan(0, ids.length);
            const { targets, metaById, stats, messages } = await BD.mail.buildTargetsAndStats(ids, {
                signal: progress.signal,
                onProgress: ({ i, n }) => progress.scan(i, n)
            });
            throwIfAborted(progress.signal);
            await progress.dispose({ close: true });
            progress = null;
            if (!stats.totalAttachments) {
                await notify(t('noDeletableAttachments'), t('noDeletableMessage'));
                return;
            }

            // Freeze settings for both the confirmation and the entire run.
            const settings = await BD.settings.getSettings();
            if (!await BD.ui.openConfirmPageAndWait({ stats, messages, settings })) return;
            progress = await BD.ui.openProgressPage({ total: stats.totalAttachments });
            const result = await BD.runner.runBackupThenDelete(targets, metaById, {
                settings, signal: progress.signal,
                onProgress: event => progress.update(event)
            });
            await progress.finish(result);
            const totals = result.totals;
            const title = result.cancelled ? t('cancelled') : result.issues.length ? t('completedWithErrors') : t('completed');
            await notify(title, t('progressSummary', [totals.totalSaved, totals.totalDeleted,
                totals.totalFailedSave + totals.totalFailedDelete, totals.totalUnprocessed].map(value => number(value))));
        } catch (error) {
            if (error.name === 'AbortError') {
                await progress?.dispose({ close: true });
                await notify(t('cancelled'), t('cancelledMessage'));
            } else {
                console.error(error);
                await progress?.error(error.message || String(error));
                await notify(t('operationFailed'), error.message || String(error));
            }
        } finally {
            await progress?.dispose();
            BD.state.running = false;
        }
    }

    if (!BD.state.bound) {
        const menus = () => BD.ui.createMenus().catch(error => console.error('Menu creation:', error));
        api.runtime.onInstalled.addListener(menus);
        api.runtime.onStartup.addListener(menus);
        api.menus.onClicked.addListener((info, tab) => {
            if (info.menuItemId === BD.const.MENU_ID) return deleteAllAttachmentsOnSelectedMessages(tab?.id);
        });
        BD.state.bound = true;
    }
    BD.main = { deleteAllAttachmentsOnSelectedMessages };
})(globalThis.BD);
