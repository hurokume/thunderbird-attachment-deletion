(function (BD) {
    'use strict';
    const api = BD.api;
    const { t, details } = globalThis.BDI18n;
    const { MAX_DOWNLOAD_RETRIES, RETRY_BACKOFF_MS } = BD.const;
    const { sleep, addSuffixToPath, throwIfAborted, withAbort } = BD.utils;

    function waitForDownloadState(id, timeoutMs = 120000, signal) {
        throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (state, error) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                api.downloads.onChanged.removeListener(onChanged);
                signal?.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(state);
            };
            const abort = () => finish(null, new DOMException('Cancelled', 'AbortError'));
            const onChanged = delta => {
                if (delta.id === id && ['complete', 'interrupted'].includes(delta.state?.current)) {
                    finish(delta.state.current);
                }
            };
            const timer = setTimeout(() => finish('timeout'), timeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            // Subscribe before the snapshot: completion cannot fall between them.
            try {
                api.downloads.onChanged.addListener(onChanged);
                api.downloads.search({ id }).then(([item]) => {
                    if (['complete', 'interrupted'].includes(item?.state)) finish(item.state);
                }, error => finish(null, error));
            } catch (error) { finish(null, error); }
        });
    }

    async function verifyExistsStrictById(id, signal) {
        for (let i = 0; i < 5; i++) {
            throwIfAborted(signal);
            const [record] = await withAbort(api.downloads.search({ id }), signal);
            if (record?.state === 'complete' && record.exists === true) return record;
            if (record?.state === 'interrupted') return null;
            if (i < 4) await sleep(200, signal);
        }
        return null;
    }

    async function cancelDownload(id) {
        if (id != null) await api.downloads.cancel(id).catch(() => {});
    }

    async function downloadViaBlobAndVerify(fileOrBlob, filename, options = {}) {
        const { signal, saveMode = 'inherit', timeoutMs = 120000 } = options;
        let lastError = t('backupNotVerified');
        for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
            throwIfAborted(signal);
            const url = URL.createObjectURL(fileOrBlob);
            let id;
            try {
                const request = {
                    url,
                    filename: attempt === 1 ? filename : addSuffixToPath(filename, '_retry' + attempt),
                    conflictAction: 'uniquify'
                };
                if (saveMode !== 'inherit') request.saveAs = saveMode === 'ask';
                const started = api.downloads.download(request);
                // A file picker may return an ID after the run was cancelled.
                started.then(lateId => {
                    if (signal?.aborted) return cancelDownload(lateId);
                }).catch(() => {});
                id = await withAbort(started, signal);
                const state = await waitForDownloadState(id, timeoutMs, signal);
                if (state === 'timeout') {
                    await cancelDownload(id);
                    lastError = t('downloadTimedOut');
                } else if (state === 'interrupted') {
                    const [record] = await withAbort(api.downloads.search({ id }), signal);
                    lastError = details(t('downloadInterrupted'), record?.error);
                    if (record?.error === 'USER_CANCELED') return { ok: false, error: t('downloadCancelled') };
                } else {
                    const record = await verifyExistsStrictById(id, signal);
                    throwIfAborted(signal);
                    if (record) return { ok: true, finalPath: record.filename || request.filename, id };
                    lastError = t('backupFileMissing');
                }
            } catch (error) {
                await cancelDownload(id);
                if (error.name === 'AbortError') throw error;
                lastError = details(t('downloadInterrupted'), error);
                // Closing a native Save As dialog must not reopen it repeatedly.
                if (/cancel/i.test(error.message || String(error))) return { ok: false, error: t('downloadCancelled') };
            } finally {
                URL.revokeObjectURL(url);
            }
            if (attempt < MAX_DOWNLOAD_RETRIES) await sleep(RETRY_BACKOFF_MS * attempt, signal);
        }
        return { ok: false, error: lastError };
    }

    BD.downloads = { waitForDownloadState, verifyExistsStrictById, downloadViaBlobAndVerify };
})(globalThis.BD);
