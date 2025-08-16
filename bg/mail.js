'use strict';
const { BD } = globalThis;
const { api } = BD;
const { SAVE_ROOT } = BD.const;
const { timestampFromDate, sanitize } = BD.utils;
const { downloadViaBlobAndVerify } = BD.downloads;

BD.mail = (() => {

    async function getAllSelectedMessageIds() {
        let page = await api.mailTabs.getSelectedMessages();
        const ids = [...page.messages.map(m => m.id)];
        while (page.id) {
            page = await api.messages.continueList(page.id);
            ids.push(...page.messages.map(m => m.id));
        }
        return ids;
    }

    /**
     * 析出: 削除候補と統計(UI用)
     * metaById: { subject, stamp }  ※stampは受信日時 (yyyymmdd-hhmmss)
     */
    async function buildTargetsAndStats(messageIds) {
        let totalBytes = 0, totalCount = 0, affected = 0;
        const targets = [];
        const byExt = new Map();
        const messages = [];
        const metaById = new Map();

        for (const id of messageIds) {
            const meta = await api.messages.get(id);
            const atts = await api.messages.listAttachments(id);

            const usable = atts
                .filter(a => a.contentType !== 'text/x-moz-deleted')
                .map(a => ({
                    name: a.name || '(no name)',
                    size: Number(a.size || 0),
                    contentType: a.contentType || '',
                    partName: a.partName
                }));

            const stamp = meta?.date ? timestampFromDate(meta.date) : timestampFromDate(new Date());

            if (usable.length) {
                affected++;
                targets.push({ id, partNames: usable.map(a => a.partName) });
                metaById.set(id, { subject: meta.subject || '(no subject)', stamp });

                messages.push({
                    id,
                    subject: meta.subject || '(no subject)',
                    author: meta.author || '',
                    date: meta.date ? new Date(meta.date).toLocaleString() : '',
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
                // 添付なしでも本文保存に使うため subject/stamp を保持
                if (!metaById.has(id)) metaById.set(id, { subject: meta.subject || '(no subject)', stamp });
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
            idsWithAttachments: targets.map(t => t.id) // ★ 添付のあるメッセージのID一覧
        };
    }

    // 本文抽出（text/plain 優先、次点で text/html をテキスト化、最後に getFull フォールバック）
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

    // 添付を保存（検証つき）— 件別に try/catch で継続
    async function saveAllAttachmentsVerified(targets, metaById) {
        if (!api?.downloads?.download) throw new Error("downloads API unavailable (missing 'downloads' permission?)");
        const successMap = new Map();
        let failCount = 0, savedCount = 0;

        for (const { id, partNames } of targets) {
            const meta = metaById.get(id) || { subject: 'no_subject', stamp: timestampFromDate(new Date()) };
            const title = sanitize(meta.subject);
            const stamp = meta.stamp;
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
                    // 続行
                }
            }

            if (okSet.size > 0) successMap.set(id, okSet);
        }

        return { successMap, failCount, savedCount };
    }

    // 本文を保存（検証つき）— 件別に try/catch で継続
    async function saveMessageBodiesVerified(messageIds, metaById) {
        const bodyOkMap = new Map();
        let bodyFailCount = 0;

        for (const id of messageIds) {
            try {
                const meta = metaById.get(id) || { subject: 'no_subject', stamp: timestampFromDate(new Date()) };
                const title = sanitize(meta.subject);
                const stamp = meta.stamp;

                const text = await extractPlainBody(id);
                const logicalPath = `${SAVE_ROOT}/${stamp}_${title}.txt`;
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });

                const res = await downloadViaBlobAndVerify(blob, logicalPath);
                if (res.ok) { bodyOkMap.set(id, true); }
                else { bodyFailCount++; console.warn('verify failed for body', logicalPath); }
            } catch (e) {
                bodyFailCount++;
                console.warn('body save error:', e?.message || e);
                // 続行
            }
        }

        return { bodyOkMap, bodyFailCount };
    }

    return {
        getAllSelectedMessageIds,
        buildTargetsAndStats,
        extractPlainBody,
        saveAllAttachmentsVerified,
        saveMessageBodiesVerified
    };
})();
