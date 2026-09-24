// bg/mail.js
// 添付ファイルの評価と保存（本文保存は行わない）
// - 保存先は実行開始時の設定を使用
// - ファイル名/件名はサニタイズして安全化

(function (BD) {
    'use strict';

    const api = BD.api;
    const { t, date } = globalThis.BDI18n;
    const { timestampFromDate, backupFilename, throwIfAborted, withAbort, sleep } = BD.utils;
    const { downloadViaBlobAndVerify } = BD.downloads;

    /* ========= helpers ========= */

    function getMeta(metaById, id) {
        try {
            if (metaById?.get) return metaById.get(id) || {};
            if (metaById && typeof metaById === 'object') return metaById[id] || {};
        } catch { }
        return {};
    }

    function coerceDate(v) {
        if (!v && v !== 0) return null;
        if (v instanceof Date) return isNaN(v) ? null : v;
        if (typeof v === 'number') {
            const ms = v < 1e11 ? v * 1000 : v;
            const d = new Date(ms);
            return isNaN(d) ? null : d;
        }
        if (typeof v === 'string') {
            const d = new Date(v);
            return isNaN(d) ? null : d;
        }
        try {
            const d = new Date(v);
            return isNaN(d) ? null : d;
        } catch { return null; }
    }

    function parseReceivedLineForDate(line) {
        if (!line) return null;
        // Received: ... ; Tue, 13 Aug 2024 09:31:15 +0900 (JST)
        const semi = line.lastIndexOf(';');
        const candidate = (semi >= 0 ? line.slice(semi + 1) : String(line)).trim();
        const d = new Date(candidate);
        return isNaN(d) ? null : d;
    }

    async function deriveReceivedDate(id, fallbackDate) {
        try {
            const full = await api.messages.getFull(id);
            const headers = full && full.headers;
            if (headers) {
                let recArr = headers['received'] || headers['Received'];
                if (recArr && !Array.isArray(recArr)) recArr = [recArr];
                if (Array.isArray(recArr) && recArr.length) {
                    for (const line of recArr) {
                        const d = parseReceivedLineForDate(line);
                        if (d) return d;
                    }
                }
                let hDate = headers['date'] || headers['Date'];
                if (hDate && !Array.isArray(hDate)) hDate = [hDate];
                if (Array.isArray(hDate) && hDate.length) {
                    const d = coerceDate(hDate[0]);
                    if (d) return d;
                }
            }
        } catch (_) { /* ignore */ }

        const d3 = coerceDate(fallbackDate);
        if (d3) return d3;
        return new Date();
    }

    /* ========= selection ========= */

    async function getAllSelectedMessageIds(tabId) {
        let page = await api.mailTabs.getSelectedMessages(tabId);
        const ids = [...(page.messages || []).map(m => m.id)];
        while (page.id) {
            page = await api.messages.continueList(page.id);
            ids.push(...(page.messages || []).map(m => m.id));
        }
        return [...new Set(ids)];
    }

    /* ========= build targets & stats ========= */

    /**
     * @param {Array<number|string>} messageIds
     * @returns {{
     *   targets: Array<{id:number|string, partNames:string[]}>,
     *   metaById: Map<any, {subject:string, stampDate:Date, stamp:string}>,
     *   stats: { affectedMessages:number, totalAttachments:number, totalBytes:number, totalSize:number, extSummary:Array<{ext:string,count:number,bytes:number}> },
     *   messages: Array<{id:any,subject:string,author:string,date:string,attachments:Array<{name:string,size:number,contentType:string}>}>,
     *   idsWithAttachments: Array<any>
     * }}
     */
    async function buildTargetsAndStats(messageIds, options = {}) {
        let totalBytes = 0, totalCount = 0, affected = 0;
        const targets = [];
        const byExt = new Map();
        const messages = [];
        const metaById = new Map();

        for (const id of messageIds) {
            throwIfAborted(options.signal);
            const meta = await withAbort(api.messages.get(id), options.signal);
            const recvDate = await withAbort(deriveReceivedDate(id, meta?.date), options.signal);
            const stamp = timestampFromDate(recvDate);

            const atts = await withAbort(api.messages.listAttachments(id), options.signal);
            throwIfAborted(options.signal);
            const usable = (atts || [])
                .filter(a => a.contentType !== 'text/x-moz-deleted')
                .map(a => ({
                    name: a.name || t('noName'),
                    size: Number(a.size || 0),
                    contentType: a.contentType || '',
                    partName: a.partName
                }));

            if (usable.length) {
                affected++;
                targets.push({ id, partNames: usable.map(a => a.partName) });
                metaById.set(id, { subject: meta.subject || t('noSubject'), stampDate: recvDate, stamp });

                messages.push({
                    id,
                    subject: meta.subject || t('noSubject'),
                    author: meta.author || '',
                    date: date(recvDate),
                    attachments: usable.map(({ name, size, contentType }) => ({ name, size, contentType }))
                });

                for (const a of usable) {
                    totalBytes += a.size; totalCount += 1;
                    const ext = (() => {
                        const m = /\.[^.]+$/.exec(a.name || '');
                        if (m) return m[0].slice(1).toLowerCase();
                        const ct = (a.contentType || '').split('/')[1];
                        return (ct || '').toLowerCase();
                    })();
                    const cur = byExt.get(ext) || { count: 0, bytes: 0 };
                    cur.count += 1; cur.bytes += a.size || 0;
                    byExt.set(ext, cur);
                }
            } else {
                if (!metaById.has(id)) {
                    metaById.set(id, { subject: meta.subject || t('noSubject'), stampDate: recvDate, stamp });
                }
                messages.push({
                    id,
                    subject: meta.subject || t('noSubject'),
                    author: meta.author || '',
                    date: date(recvDate),
                    attachments: []
                });
            }
            await options.onProgress?.({ i: messages.length, n: messageIds.length });
        }

        const extSummary = [...byExt.entries()]
            .map(([ext, v]) => ({ ext, count: v.count, bytes: v.bytes }))
            .sort((a, b) => b.bytes - a.bytes || b.count - a.count || String(a.ext).localeCompare(String(b.ext)));

        const stats = {
            selectedMessages: messageIds.length,
            affectedMessages: affected,
            totalAttachments: totalCount,
            totalBytes,
            totalSize: totalBytes,
            extSummary
        };

        return {
            targets,
            metaById,
            stats,
            messages,
            idsWithAttachments: targets.map(t => t.id)
        };
    }

    // A failed backup is returned once. The runner never retries this outer loop.
    async function saveAllAttachmentsVerified(targets, metaById, options = {}) {
        const settings = options.settings || await BD.settings.getSettings();
        const { signal, onResult } = options;
        const successMap = new Map();
        let failCount = 0, savedCount = 0, first = true;
        for (const { id, partNames } of targets) {
            const meta = getMeta(metaById, id);
            const okSet = new Set();
            for (const partName of partNames) {
                throwIfAborted(signal);
                if (!first && settings.perFileDelayMs) await sleep(settings.perFileDelayMs, signal);
                first = false;
                let result;
                try {
                    const file = await withAbort(api.messages.getAttachmentFile(id, partName), signal);
                    throwIfAborted(signal);
                    const nameBudget = Math.min(180, 220 - new TextEncoder().encode(settings.saveRoot).length - 1);
                    const path = settings.saveRoot + '/' + backupFilename(meta, file.name, id, partName, nameBudget);
                    result = await downloadViaBlobAndVerify(file, path, { signal, saveMode: settings.saveMode });
                    throwIfAborted(signal);
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    result = { ok: false, error: error.message || String(error) };
                }
                if (result.ok) { okSet.add(partName); savedCount++; }
                else failCount++;
                await onResult?.({ id, partName, ...result });
            }
            if (okSet.size) successMap.set(id, okSet);
        }
        return { successMap, failCount, savedCount };
    }

    BD.mail = {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        saveAllAttachmentsVerified
    };
})(globalThis.BD);
