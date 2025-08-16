// bg/downloads.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const { MAX_DOWNLOAD_RETRIES, RETRY_BACKOFF_MS } = BD.const;
    const { sleep, addSuffixToPath } = BD.utils;

    function waitForDownloadComplete(id) {
        return new Promise((resolve, reject) => {
            const onChanged = (delta) => {
                if (delta.id !== id || !delta.state) return;
                if (delta.state.current === 'complete') {
                    api.downloads.onChanged.removeListener(onChanged); resolve();
                } else if (delta.state.current === 'interrupted') {
                    api.downloads.onChanged.removeListener(onChanged); reject(new Error('download interrupted'));
                }
            };
            api.downloads.onChanged.addListener(onChanged);
        });
    }

    // 完了＋存在確認を厳格化
    async function verifyExistsStrictById(id) {
        for (let i = 0; i < 3; i++) {
            const [rec] = await api.downloads.search({ id });
            if (rec && rec.state === 'complete' && rec.exists === true) return true;
            await sleep(150);
        }
        return false;
    }

    async function downloadViaBlobAndVerify(fileOrBlob, filename) {
        for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
            const url = URL.createObjectURL(fileOrBlob);
            try {
                const attemptName = (attempt === 1) ? filename : addSuffixToPath(filename, `_retry${attempt}`);
                const id = await api.downloads.download({ url, filename: attemptName, conflictAction: 'uniquify', saveAs: false });

                const [rec0] = await api.downloads.search({ id });
                if (!rec0 || rec0.state !== 'complete') {
                    await waitForDownloadComplete(id).catch(() => { });
                }

                const ok = await verifyExistsStrictById(id);
                if (ok) {
                    const [rec] = await api.downloads.search({ id });
                    return { ok: true, finalPath: (rec && rec.filename) || attemptName };
                }
            } catch (e) {
                console.warn('download attempt failed:', e?.message || e);
            } finally {
                URL.revokeObjectURL(url);
            }
            if (attempt < MAX_DOWNLOAD_RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
        }
        return { ok: false };
    }

    BD.downloads = { waitForDownloadComplete, downloadViaBlobAndVerify };
})(globalThis.BD);
