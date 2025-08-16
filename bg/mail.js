// bg/mail.js
(function (BD) {
    'use strict';

    const api = BD.api;
    const { SAVE_ROOT } = BD.const;
    const { timestampFromDate, sanitize } = BD.utils;
    const { downloadViaBlobAndVerify } = BD.downloads;

    async function getAllSelectedMessageIds() {
        let page = await api.mailTabs.getSelectedMessages();
        const ids = [...page.messages.map(m => m.id)];
        while (page.id) {
            page = await api.messages.continueList(page.id);
            ids.push(...page.messages.map(m => m.id));
        }
        return ids;
    }

    // ---- 受信日時の決定を強化 ----
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

    /**
     * 析出: 削除候補と統計(UI用)
     * metaById: { subject, stampDate: Date, stamp: 'yyyymmdd-hhmmss' }
     */
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
            const usable = atts
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
            .sort((a, b) => b.bytes - a.bytes);

        return {
            targets,
            metaById,
            stats: { affectedMessages: affected, totalAttachments: totalCount, totalBytes, extSummary },
            messages,
            idsWithAttachments: targets.map(t => t.id)
        };
    }

    // 本文抽出
    async function extractPlainBody(id) {
        try {
            const parts = await api.messages.listInlineTextParts(id);
            const plain = parts.find(p => (p.contentType || '').toLowerCase().startsWith('text/plain'));
            if (plain?.content) return plain.content;
            const html = parts.find(p => (p.contentType || '').toLowerCase().startsWith('text/html'));
            if (html?.content) {
                if (api?.messengerUtilities?.convertToPlainText) {
                    return await api.messengerUtilities.convertToPlainText(html.content);
                }
                return (html.content || '').replace(/<[^>]+>/g, '');
            }
        } catch (e) { /* fallback */ }

        try {
            const full = await api.messages.getFull(id);
            const q = []; if (full) q.push(full);
            while (q.length) {
                const node = q.shift();
                const ct = (node.contentType || '').toLowerCase();
                if (ct.startsWith('text/plain') && node.body) return node.body;
                if (ct.startsWith('text/html') && node.body) {
                    if (api?.messengerUtilities?.convertToPlainText) {
                        return await api.messengerUtilities.convertToPlainText(node.body);
                    }
                    return (node.body || '').replace(/<[^>]+>/g, '');
                }
                if (Array.isArray(node.parts)) q.push(...node.parts);
            }
        } catch (e) { /* give up */ }

        return '';
    }

    // 添付を保存（検証つき）
    async function saveAllAttachmentsVerified(targets, metaById) {
        if (!api?.downloads?.download) throw new Error("downloads API unavailable (missing 'downloads' permission?)");
        const successMap = new Map();
        let failCount = 0, savedCount = 0;

        for (const { id, partNames } of targets) {
            const meta = metaById.get(id);
            const title = sanitize(meta?.subject || 'no_subject');
            const stamp = meta?.stamp;

            const okSet = new Set();
            for (const partName of partNames) {
                try {
                    const file = await api.messages.getAttachmentFile(id, partName);
                    const orig = sanitize(file.name || 'attachment');
                    const logicalPath = `${SAVE_ROOT}/${stamp}_${title}_${orig}`;
                    const res = await downloadViaBlobAndVerify(file, logicalPath);
                    if (res.ok) { okSet.add(partName); savedCount++; }
                    else { failCount++; console.warn('verify failed for', logicalPath); }
                } catch (e) {
                    failCount++;
                    console.warn('attachment save error:', e?.message || e);
                }
            }
            if (okSet.size > 0) successMap.set(id, okSet);
        }

        return { successMap, failCount, savedCount };
    }

    // 本文を保存（検証つき）
    async function saveMessageBodiesVerified(messageIds, metaById) {
        const bodyOkMap = new Map();
        let bodyFailCount = 0;

        for (const id of messageIds) {
            try {
                const meta = metaById.get(id);
                const title = sanitize(meta?.subject || 'no_subject');
                const stamp = meta?.stamp;

                const text = await extractPlainBody(id);
                const logicalPath = `${SAVE_ROOT}/${stamp}_${title}.txt`;
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });

                const res = await downloadViaBlobAndVerify(blob, logicalPath);
                if (res.ok) { bodyOkMap.set(id, true); }
                else { bodyFailCount++; console.warn('verify failed for body', logicalPath); }
            } catch (e) {
                bodyFailCount++;
                console.warn('body save error:', e?.message || e);
            }
        }

        return { bodyOkMap, bodyFailCount };
    }

    BD.mail = {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        extractPlainBody,
        saveAllAttachmentsVerified,
        saveMessageBodiesVerified
    };
})(globalThis.BD);
