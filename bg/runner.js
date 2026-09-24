(function (BD) {
    'use strict';
    const api = BD.api;
    const { t } = globalThis.BDI18n;
    const { sleep, throwIfAborted, withAbort } = BD.utils;

    // Back up all parts of a message before modifying its MIME structure.
    async function deleteAttachmentsSafely(targets, { signal, onResult } = {}) {
        let deleted = 0, failed = 0;
        for (const { id, partNames } of targets) {
            throwIfAborted(signal);
            if (!partNames.length) continue;
            let liveSet;
            try {
                const live = await withAbort(api.messages.listAttachments(id), signal);
                liveSet = new Set(live.filter(a => a.contentType !== 'text/x-moz-deleted').map(a => a.partName));
                throwIfAborted(signal);
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                failed += partNames.length;
                for (const partName of partNames) await onResult?.({ id, partName, ok: false, error: error.message || String(error) });
                continue;
            }
            const candidates = partNames.filter(p => liveSet.has(p));
            for (const partName of partNames.filter(p => !liveSet.has(p))) {
                failed++;
                await onResult?.({ id, partName, ok: false, error: t('attachmentChanged') });
            }
            if (!candidates.length) continue;
            // Do not race this destructive call against cancellation. An already
            // submitted call must settle before releasing the run lock.
            let error;
            try {
                throwIfAborted(signal);
                await api.messages.deleteAttachments(id, candidates);
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                error = e.message || String(e);
            }
            for (const partName of candidates) {
                if (error) failed++; else deleted++;
                await onResult?.({ id, partName, ok: !error, error });
            }
        }
        return { deleted, failed };
    }

    async function runBackupThenDelete(targets, metaById, options = {}) {
        const { signal, onProgress = () => {} } = options;
        const settings = options.settings || await BD.settings.getSettings();
        const totals = {
            totalToDelete: targets.reduce((sum, t) => sum + t.partNames.length, 0),
            totalSaved: 0, totalDeleted: 0, totalFailedSave: 0, totalFailedDelete: 0,
            totalProcessed: 0
        };
        const issues = [], savedFiles = [];
        let cancelled = false;
        const report = phase => onProgress({ phase, totals: { ...totals }, backupEnabled: settings.backupEnabled });
        try {
            await report('start');
            for (let index = 0; index < targets.length; index++) {
                throwIfAborted(signal);
                const { id, partNames } = targets[index];
                let eligible = partNames;
                if (settings.backupEnabled) {
                    const saved = await BD.mail.saveAllAttachmentsVerified([{ id, partNames }], metaById, {
                        settings, signal,
                        onResult: async result => {
                            if (result.ok) {
                                totals.totalSaved++;
                                savedFiles.push({ id, partName: result.partName, path: result.finalPath });
                            } else {
                                totals.totalFailedSave++;
                                totals.totalProcessed++;
                                issues.push({ ...result, stage: 'backup' });
                            }
                            await report('backup');
                        }
                    });
                    eligible = [...(saved.successMap.get(id) || [])];
                }
                throwIfAborted(signal);
                await deleteAttachmentsSafely([{ id, partNames: eligible }], {
                    signal,
                    onResult: async result => {
                        if (result.ok) totals.totalDeleted++;
                        else { totals.totalFailedDelete++; issues.push({ ...result, stage: 'delete' }); }
                        totals.totalProcessed++;
                        await report('delete');
                    }
                });
                throwIfAborted(signal);
                if (index < targets.length - 1 && settings.cooldownAfterEachMessageMs) {
                    await sleep(settings.cooldownAfterEachMessageMs, signal);
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') throw error;
            cancelled = true;
        }
        totals.totalUnprocessed = totals.totalToDelete - totals.totalProcessed;
        return { totals, issues, savedFiles, cancelled, backupEnabled: settings.backupEnabled };
    }

    BD.runner = { runBackupThenDelete, deleteAttachmentsSafely };
})(globalThis.BD);
