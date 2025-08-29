// bg/runner.js
// 保存→検証→（成功分だけ）即削除を小刻みに実行。Cancel/クールダウン対応。
(function (BD) {
    'use strict';

    const api = BD.api;

    const SAVE_CHUNK = 8;
    const DEL_CHUNK = 16;
    const MSG_COOLDOWN_MS_DEFAULT = 5000;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const parsePart = (s) => s.split('.').map(n => parseInt(n, 10)).filter(Number.isFinite);
    const cmpPartDesc = (a, b) => {
        const A = parsePart(a), B = parsePart(b), L = Math.max(A.length, B.length);
        for (let i = 0; i < L; i++) { const av = A[i] ?? -1, bv = B[i] ?? -1; if (av !== bv) return bv - av; }
        return B.length - A.length;
    };

    async function deleteAttachmentsSafely(targets) {
        let deleted = 0, failed = 0;
        for (const { id, partNames: wanted } of (targets || [])) {
            let remaining = [...wanted];
            while (remaining.length) {
                const liveSet = new Set((await api.messages.listAttachments(id)).map(a => a.partName));
                const candidates = remaining.filter(p => liveSet.has(p)).sort(cmpPartDesc);
                if (!candidates.length) break;

                const chunk = candidates.slice(0, DEL_CHUNK);
                try {
                    await api.messages.deleteAttachments(id, chunk);
                    deleted += chunk.length;
                } catch (e) {
                    for (const p of chunk) {
                        try { await api.messages.deleteAttachments(id, [p]); deleted++; }
                        catch (ee) { console.warn('delete one failed', id, p, ee?.message || ee); failed++; }
                    }
                }
                const done = new Set(chunk);
                remaining = remaining.filter(p => !done.has(p));
                await sleep(0);
            }
        }
        return { deleted, failed };
    }

    /**
     * @param {{id:number|string, partNames:string[]}[]} targets
     * @param {Map|Object|undefined} metaById
     * @param {{ perFileDelayMs?: number, cooldownAfterEachMessageMs?: number, onProgress?: function, shouldCancel?: function }} [opts]
     */
    async function runBackupThenDelete(targets, metaById, opts = {}) {
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => { };
        const cooldownMs = Number.isFinite(opts.cooldownAfterEachMessageMs)
            ? opts.cooldownAfterEachMessageMs
            : MSG_COOLDOWN_MS_DEFAULT;
        const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : () => false;

        const saveAll =
            (BD.mail && typeof BD.mail.saveAllAttachmentsVerified === 'function')
                ? BD.mail.saveAllAttachmentsVerified
                : (typeof globalThis.saveAllAttachmentsVerified === 'function'
                    ? globalThis.saveAllAttachmentsVerified
                    : null);

        if (!saveAll) throw new Error('saveAllAttachmentsVerified not available');

        const safeMeta = metaById ?? new Map();

        let totalToDelete = 0, totalSaved = 0, totalDeleted = 0, totalFailedSave = 0, totalFailedDelete = 0;
        for (const t of targets || []) totalToDelete += (t.partNames?.length || 0);
        onProgress({ phase: 'start', totalToDelete });

        let cancelled = false;

        outer:
        for (let idx = 0; idx < (targets || []).length; idx++) {
            if (shouldCancel()) { cancelled = true; break outer; }
            const { id, partNames } = targets[idx];
            let rest = Array.isArray(partNames) ? [...partNames] : [];

            while (rest.length) {
                if (shouldCancel()) { cancelled = true; break; }

                const saveChunk = rest.slice(0, SAVE_CHUNK);

                // 1) 保存＋検証（このチャンクだけ）
                const { successMap, failCount, savedCount } =
                    await saveAll([{ id, partNames: saveChunk }], safeMeta);

                totalSaved += savedCount;
                totalFailedSave += failCount;

                const okSet = successMap.get(id) || new Set();
                const okParts = [...okSet];

                // 2) 成功分だけ即削除
                if (okParts.length) {
                    const { deleted, failed } = await deleteAttachmentsSafely([{ id, partNames: okParts }]);
                    totalDeleted += deleted;
                    totalFailedDelete += failed;
                }

                // 3) 次の保存対象を更新
                const okFast = new Set(okParts);
                rest = rest.filter(p => !okFast.has(p));

                onProgress({
                    phase: 'progress',
                    messageId: id,
                    savedThisChunk: savedCount,
                    deletedThisChunk: okParts.length,
                    remainingForMessage: rest.length,
                    totals: { totalSaved, totalDeleted, totalFailedSave, totalFailedDelete, totalToDelete }
                });
            }

            if (cancelled) break;
            if (cooldownMs > 0 && idx < targets.length - 1) {
                if (shouldCancel()) { cancelled = true; break; }
                await sleep(cooldownMs);
            }
        }

        onProgress({ phase: 'done', totals: { totalSaved, totalDeleted, totalFailedSave, totalFailedDelete, totalToDelete }, cancelled });
        return { totals: { totalSaved, totalDeleted, totalFailedSave, totalFailedDelete, totalToDelete }, cancelled };
    }

    BD.runner = { runBackupThenDelete, deleteAttachmentsSafely };
})(globalThis.BD || (globalThis.BD = {}));
