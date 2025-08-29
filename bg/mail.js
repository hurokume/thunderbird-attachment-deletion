// bg/mail.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const { SAVE_ROOT } = BD.const;
    const { timestampFromDate, sanitizePathSegment, sanitizeFilename } = BD.utils;
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

    async function getAllSelectedMessageIds() {
        let page = await api.mailTabs.getSelectedMessages();
        const ids = [...(page.messages || []).map(m => m.id)];
        while (page.id) {
            page = await api.messages.continueList(page.id);
            ids.push(...(page.messages || []).map(m => m.id));
        }
        return ids;
    }

    /* ========= build targets & stats ========= */

    async function buildTargetsAndStats(messageIds) {
        let totalBytes = 0, totalCount = 0, affected = 0;
        const targets = [];
        const byExt = new Map();
        const messages = [];
        const metaById = new Map();

        for (const id of messageIds) {
            const meta = await api.messages.get(id);
            const recvDate = await deriveReceivedDate(id, meta?.date);
            const stamp = timestampFromDate(recvDate);

            const atts = await api.messages.listAttachments(id);
            const usable = (atts || [])
                .filter(a => a.contentType !== 'text/x-moz-deleted')
                .map(a => ({
                    name: a.name || '(no name)',
                    size: Number(a.size || 0),
                    contentType: a.contentType || '',
                    partName: a.partName
                }));

            if (usable.length) {
                affected++;
                targets.push({ id, partNames: usable.map(a => a.partName) });
                metaById.set(id, { subject: meta.subject || '(no subject)', stampDate: recvDate, stamp });

                messages.push({
                    id,
                    subject: meta.subject || '(no subject)',
                    author: meta.author || '',
                    date: recvDate.toLocaleString(),
                    attachments: usable.map(({ name, size, contentType }) => ({ name, size, contentType }))
                });

                for (const a of usable) {
                    totalBytes += a.size; totalCount += 1;
                    const ext = (() => {
                        const m = /\.[^.]+$/.exec(a.name || '');
                        if (m) return m[0].slice(1).toLowerCase();
                        const ct = (a.contentType || '').split('/')[1];
                        return (ct || 'unknown').toLowerCase();
                    })();
                    const cur = byExt.get(ext) || { count: 0, bytes: 0 };
                    cur.count += 1; cur.bytes += a.size || 0;
                    byExt.set(ext, cur);
                }
            } else {
                if (!metaById.has(id)) {
                    metaById.set(id, { subject: meta.subject || '(no subject)', stampDate: recvDate, stamp });
                }
                messages.push({
                    id,
                    subject: meta.subject || '(no subject)',
                    author: meta.author || '',
                    date: recvDate.toLocaleString(),
                    attachments: []
                });
            }
        }

        const extSummary = [...byExt.entries()]
            .map(([ext, v]) => ({ ext, count: v.count, bytes: v.bytes }))
            .sort((a, b) => b.bytes - a.bytes || b.count - a.count || String(a.ext).localeCompare(String(b.ext)));

        const stats = { affectedMessages: affected, totalAttachments: totalCount, totalBytes, totalSize: totalBytes, extSummary };

        return {
            targets,
            metaById,
            stats,
            messages,
            idsWithAttachments: targets.map(t => t.id)
        };
    }

    /* ========= save: attachments (with verify & per-file delay) ========= */

    // 添付を保存（検証つき） — 各ファイルごとに1秒待機（finally）
    async function saveAllAttachmentsVerified(targets, metaById) {
        if (!api?.downloads?.download) throw new Error("downloads API unavailable (missing 'downloads' permission?)");

        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const PER_FILE_DELAY_MS = 1000;

        const successMap = new Map();
        let failCount = 0, savedCount = 0;

        for (const { id, partNames } of (targets || [])) {
            const meta = getMeta(metaById, id);
            // 件名はパスの一部なので「セグメント」としてサニタイズ
            const title = sanitizePathSegment(meta.subject || 'no_subject', { max: 120 });
            const stamp = meta.stamp || timestampFromDate(meta.stampDate || new Date());

            const okSet = new Set();

            for (let i = 0; i < (partNames || []).length; i++) {
                const partName = partNames[i];
                try {
                    const file = await api.messages.getAttachmentFile(id, partName);
                    // 実ファイル名は拡張子保持でサニタイズ
                    const orig = sanitizeFilename(file?.name || 'attachment', { max: 180 });
                    const logicalPath = `${SAVE_ROOT}/${stamp}_${title}_${orig}`;

                    const res = await downloadViaBlobAndVerify(file, logicalPath);
                    if (res?.ok) { okSet.add(partName); savedCount++; }
                    else { failCount++; console.warn('verify failed for', logicalPath); }
                } catch (e) {
                    failCount++;
                    console.warn('attachment save error:', e?.message || e);
                } finally {
                    if (i < (partNames.length - 1)) {
                        await delay(PER_FILE_DELAY_MS);
                    }
                }
            }

            if (okSet.size > 0) successMap.set(id, okSet);
        }

        return { successMap, failCount, savedCount };
    }

    BD.mail = {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        saveAllAttachmentsVerified
    };
})(globalThis.BD);
