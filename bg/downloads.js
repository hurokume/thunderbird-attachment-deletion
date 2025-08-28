// bg/downloads.js（堅牢化版：タイムアウト付・確実なクリーンアップ・厳格検証・リトライ）
(function (BD) {
    'use strict';

    const api = BD.api;
    const { MAX_DOWNLOAD_RETRIES, RETRY_BACKOFF_MS } = BD.const;
    const { sleep, addSuffixToPath } = BD.utils;

    /**
     * ダウンロード完了/中断を待つ（タイムアウト付）
     * @param {number} id downloads.download が返すID
     * @param {number} timeoutMs タイムアウト（既定120秒）
     * @returns {Promise<"complete"|"interrupted"|"timeout">}
     */
    function waitForDownloadState(id, timeoutMs = 120000) {
        return new Promise((resolve) => {
            let done = false;
            const cleanup = () => {
                if (done) return;
                done = true;
                try { api.downloads.onChanged.removeListener(onChanged); } catch { }
                clearTimeout(timer);
            };

            const onChanged = (delta) => {
                if (delta.id !== id || !delta.state) return;
                const cur = delta.state.current;
                if (cur === 'complete') { cleanup(); resolve('complete'); }
                else if (cur === 'interrupted') { cleanup(); resolve('interrupted'); }
            };

            const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);

            try { api.downloads.onChanged.addListener(onChanged); }
            catch {
                // 古い環境等で onChanged が使えない場合はタイムアウトで抜ける
            }
        });
    }

    /**
     * 完了＋存在確認（厳格）
     * downloads.search は反映が遅れることがあるので、少し待ちながら複数回確認
     */
    async function verifyExistsStrictById(id) {
        for (let i = 0; i < 5; i++) {
            try {
                const list = await api.downloads.search({ id });
                const rec = list && list[0];
                if (rec && rec.state === 'complete' && rec.exists === true) return true;
            } catch (e) {
                // 一時的な失敗はリトライ
            }
            await sleep(200);
        }
        return false;
    }

    /**
     * Blob→downloads API 経由で保存し、存在確認まで行う
     * 失敗時は指数的バックオフでリトライ（ファイル名に _retryN を付与）
     * @param {Blob|File} fileOrBlob
     * @param {string} filename 保存先（サブフォルダ含むパス）
     * @returns {Promise<{ok:true, finalPath:string, id:number} | {ok:false}>}
     */
    async function downloadViaBlobAndVerify(fileOrBlob, filename) {
        for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
            const url = URL.createObjectURL(fileOrBlob);
            try {
                const attemptName = (attempt === 1) ? filename : addSuffixToPath(filename, `_retry${attempt}`);
                const id = await api.downloads.download({
                    url,
                    filename: attemptName,
                    conflictAction: 'uniquify',
                    saveAs: false
                });

                // すでに complete のこともあるので軽くチェック
                try {
                    const [rec0] = await api.downloads.search({ id });
                    if (!rec0 || rec0.state !== 'complete') {
                        await waitForDownloadState(id).catch(() => { });
                    }
                } catch {
                    // search 失敗は後段 verifyExists で最終判断
                }

                const ok = await verifyExistsStrictById(id);
                if (ok) {
                    const [rec] = await api.downloads.search({ id }).catch(() => [null]);
                    return { ok: true, finalPath: (rec && rec.filename) || attemptName, id };
                }
            } catch (e) {
                console.warn('download attempt failed:', e?.message || e);
            } finally {
                URL.revokeObjectURL(url);
            }

            if (attempt < MAX_DOWNLOAD_RETRIES) {
                await sleep(RETRY_BACKOFF_MS * attempt); // 逓増バックオフ
            }
        }
        return { ok: false };
    }

    BD.downloads = {
        waitForDownloadState,
        verifyExistsStrictById,
        downloadViaBlobAndVerify,
    };
})(globalThis.BD);
