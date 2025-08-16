// background.js
// Bulk delete attachments with: pre-confirm (HTML UI), per-message timestamp (received date),
// backup attachments & bodies with verification+retries, then delete only what was safely backed up.

const api = (typeof messenger !== "undefined") ? messenger : browser;

const MENU_ID = "bulk-del";
const SAVE_ROOT = "addonname";          // 既定DLフォルダ配下に作成
const MAX_DOWNLOAD_RETRIES = 3;
const RETRY_BACKOFF_MS = 400;

// ========== Utils ==========
function pad2(n) { return String(n).padStart(2, "0"); }
function timestampFromDate(d) {
    // d: Date or anything parsable by Date
    const x = (d instanceof Date) ? d : new Date(d);
    return `${x.getFullYear()}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}-${pad2(x.getHours())}${pad2(x.getMinutes())}${pad2(x.getSeconds())}`;
}
function sanitize(s) {
    return (s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
}
function humanSize(bytes) {
    const u = ["B", "KB", "MB", "GB", "TB"]; let b = Math.max(0, Number(bytes || 0)), i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function addSuffixToPath(path, suffix) {
    const k = path.lastIndexOf("/");
    const dir = k >= 0 ? path.slice(0, k + 1) : "";
    const name = k >= 0 ? path.slice(k + 1) : path;
    const dot = name.lastIndexOf(".");
    const base = (dot > 0) ? name.slice(0, dot) : name;
    const ext = (dot > 0) ? name.slice(dot) : "";
    return `${dir}${base}${suffix}${ext}`;
}

// ========== Downloads helpers ==========
function waitForDownloadComplete(id) {
    return new Promise((resolve, reject) => {
        const onChanged = (delta) => {
            if (delta.id !== id || !delta.state) return;
            if (delta.state.current === "complete") {
                api.downloads.onChanged.removeListener(onChanged);
                resolve();
            } else if (delta.state.current === "interrupted") {
                api.downloads.onChanged.removeListener(onChanged);
                reject(new Error("download interrupted"));
            }
        };
        api.downloads.onChanged.addListener(onChanged);
    });
}

async function downloadViaBlobAndVerify(fileOrBlob, filename) {
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
        const url = URL.createObjectURL(fileOrBlob);
        try {
            const attemptName = (attempt === 1) ? filename : addSuffixToPath(filename, `_retry${attempt}`);
            const id = await api.downloads.download({
                url, filename: attemptName, conflictAction: "uniquify", saveAs: false
            });

            const [rec0] = await api.downloads.search({ id });
            if (!rec0 || rec0.state !== "complete") {
                await waitForDownloadComplete(id).catch(() => { });
            }

            const [rec] = await api.downloads.search({ id });
            const exists = !!rec && rec.state === "complete" && (rec.exists !== false);
            if (exists) return { ok: true, finalPath: rec.filename || attemptName };
        } catch (e) {
            console.warn("download attempt failed:", e?.message || e);
        } finally {
            URL.revokeObjectURL(url);
        }
        if (attempt < MAX_DOWNLOAD_RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
    }
    return { ok: false };
}

// ========== Selection / Listing ==========
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
        const meta = await api.messages.get(id); // MessageHeader(date: Date あり)
        const atts = await api.messages.listAttachments(id);

        const usable = atts
            .filter(a => a.contentType !== "text/x-moz-deleted")
            .map(a => ({
                name: a.name || "(no name)",
                size: Number(a.size || 0),
                contentType: a.contentType || "",
                partName: a.partName
            }));

        // per-message stamp from received date
        const stamp = meta?.date ? timestampFromDate(meta.date) : timestampFromDate(new Date());

        if (usable.length) {
            affected++;
            targets.push({ id, partNames: usable.map(a => a.partName) });
            metaById.set(id, { subject: meta.subject || "(no subject)", stamp });

            messages.push({
                id,
                subject: meta.subject || "(no subject)",
                author: meta.author || "",
                date: meta.date ? new Date(meta.date).toLocaleString() : "",
                attachments: usable.map(({ name, size, contentType }) => ({ name, size, contentType }))
            });

            for (const a of usable) {
                totalBytes += a.size; totalCount += 1;
                const ext = (() => {
                    const m = /\.[^.]+$/.exec(a.name || "");
                    if (m) return m[0].slice(1).toLowerCase();
                    const ct = (a.contentType || "").split("/")[1];
                    return (ct || "unknown").toLowerCase();
                })();
                const cur = byExt.get(ext) || { count: 0, bytes: 0 };
                cur.count += 1; cur.bytes += a.size || 0;
                byExt.set(ext, cur);
            }
        } else {
            // 添付がないが本文は保存したいケースもあるので subject/stamp だけ登録
            if (!metaById.has(id)) metaById.set(id, { subject: meta.subject || "(no subject)", stamp });
        }
    }

    const extSummary = [...byExt.entries()]
        .map(([ext, v]) => ({ ext, count: v.count, bytes: v.bytes }))
        .sort((a, b) => b.bytes - a.bytes);

    return {
        targets,
        metaById,
        stats: { affectedMessages: affected, totalAttachments: totalCount, totalBytes, extSummary },
        messages
    };
}

// ========== Confirm Page ==========
function openConfirmPageAndWait(key, stats) {
    return new Promise(async (resolve) => {
        const onMsg = (msg, sender, sendResponse) => {
            if (!msg || msg.type !== "confirm-result" || msg.key !== key) return;
            try { sendResponse({ ack: true }); } catch (_) { }
            api.runtime.onMessage.removeListener(onMsg);
            if (sender?.tab?.windowId) {
                api.windows.remove(sender.tab.windowId).catch(() => { });
            }
            resolve(!!msg.ok);
        };
        api.runtime.onMessage.addListener(onMsg);

        const url = `confirm.html?key=${encodeURIComponent(key)}&affected=${encodeURIComponent(stats.affectedMessages)}&total=${encodeURIComponent(stats.totalAttachments)}&bytes=${encodeURIComponent(stats.totalBytes)}`;
        await api.windows.create({ url, type: "popup", width: 680, height: 560 });
    });
}

// ========== Save Attachments with verification (per-message received timestamp) ==========
async function saveAllAttachmentsVerified(targets, metaById) {
    if (!api?.downloads?.download) throw new Error("downloads API unavailable (missing 'downloads' permission?)");

    const successMap = new Map();
    let failCount = 0, savedCount = 0;

    for (const { id, partNames } of targets) {
        const meta = metaById.get(id) || { subject: "no_subject", stamp: timestampFromDate(new Date()) };
        const title = sanitize(meta.subject);
        const stamp = meta.stamp;
        const okSet = new Set();

        for (const partName of partNames) {
            const file = await api.messages.getAttachmentFile(id, partName); // File
            const orig = sanitize(file.name || "attachment");
            const logicalPath = `${SAVE_ROOT}/${stamp}_${title}_${orig}`;

            const res = await downloadViaBlobAndVerify(file, logicalPath);
            if (res.ok) { okSet.add(partName); savedCount++; }
            else { failCount++; console.warn("verify failed for", logicalPath); }
        }

        if (okSet.size > 0) successMap.set(id, okSet);
    }

    return { successMap, failCount, savedCount };
}

// ========== Save Message Bodies (.txt) with verification (per-message received timestamp) ==========
async function extractPlainBody(id) {
    // 1) TB128+: listInlineTextParts を優先
    try {
        const parts = await api.messages.listInlineTextParts(id);
        const plain = parts.find(p => (p.contentType || "").toLowerCase().startsWith("text/plain"));
        if (plain?.content) return plain.content;
        const html = parts.find(p => (p.contentType || "").toLowerCase().startsWith("text/html"));
        if (html?.content) {
            if (api?.messengerUtilities?.convertToPlainText) {
                return await api.messengerUtilities.convertToPlainText(html.content);
            }
            return (html.content || "").replace(/<[^>]+>/g, "");
        }
    } catch (e) {
        // fall through to getFull
    }

    // 2) フォールバック: getFull で木をたどる
    try {
        const full = await api.messages.getFull(id, { decodeContent: true });
        const q = []; if (full) q.push(full);
        while (q.length) {
            const node = q.shift();
            const ct = (node.contentType || "").toLowerCase();
            if (ct.startsWith("text/plain") && node.body) return node.body;
            if (ct.startsWith("text/html") && node.body) {
                if (api?.messengerUtilities?.convertToPlainText) {
                    return await api.messengerUtilities.convertToPlainText(node.body);
                }
                return (node.body || "").replace(/<[^>]+>/g, "");
            }
            if (Array.isArray(node.parts)) q.push(...node.parts);
        }
    } catch (e) {
        console.warn("getFull fallback failed:", e?.message || e);
    }

    // 3) 最後の手段: 空文字（ファイルは作る）
    return "";
}

async function saveMessageBodiesVerified(messageIds, metaById) {
    const bodyOkMap = new Map();
    let bodyFailCount = 0;

    for (const id of messageIds) {
        const meta = metaById.get(id) || { subject: "no_subject", stamp: timestampFromDate(new Date()) };
        const title = sanitize(meta.subject);
        const stamp = meta.stamp;

        const text = await extractPlainBody(id);
        const logicalPath = `${SAVE_ROOT}/${stamp}_${title}.txt`;
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });

        const res = await downloadViaBlobAndVerify(blob, logicalPath);
        if (res.ok) { bodyOkMap.set(id, true); }
        else { bodyFailCount++; console.warn("verify failed for body", logicalPath); }
    }

    return { bodyOkMap, bodyFailCount };
}

// ========== Main ==========
async function deleteAllAttachmentsOnSelectedMessages() {
    if (!api?.messages?.deleteAttachments) {
        await api.notifications.create({
            type: "basic",
            title: "Unable to use messages.deleteAttachments API",
            message: "messages.deleteAttachments is unavailable. Check permissions (messagesModifyPermanent) and Thunderbird 123+."
        });
        console.error("messages.deleteAttachments unavailable");
        return;
    }

    try {
        const ids = await getAllSelectedMessageIds();
        const { targets, metaById, stats, messages } = await buildTargetsAndStats(ids);

        if (stats.totalAttachments === 0) {
            await api.notifications.create({
                type: "basic",
                title: "No deletable attachments",
                message: "No removable attachments were found in the selected messages."
            });
            // ただし本文バックアップはこの後でも行える仕様にしたければここでreturnしない
            return;
        }

        if (!api?.storage?.local) {
            console.error("storage.local is unavailable: check 'storage' permission in manifest.");
        }
        const key = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await api.storage.local.set({ [key]: { createdAt: Date.now(), stats, messages } });

        const ok = await openConfirmPageAndWait(key, stats);
        api.storage.local.remove(key).catch(() => { });
        if (!ok) {
            await api.notifications.create({ type: "basic", title: "Cancelled", message: "Bulk deletion was cancelled." });
            return;
        }

        // 1) 添付を保存＆確認（成功パーツのみ記録）
        const { successMap, failCount: attFail, savedCount: attSaved } =
            await saveAllAttachmentsVerified(targets, metaById);

        // 2) 本文を保存＆確認（成功メッセージのみ記録）
        const { bodyOkMap, bodyFailCount } =
            await saveMessageBodiesVerified(ids, metaById);

        // 3) 削除対象 = 「本文OK」かつ「添付バックアップOK」のパーツのみ
        const deleteTargets = [];
        let deletables = 0;
        for (const { id, partNames } of targets) {
            if (!bodyOkMap.has(id)) continue;
            const okSet = successMap.get(id);
            if (!okSet) continue;
            const okParts = partNames.filter(p => okSet.has(p));
            if (okParts.length) {
                deleteTargets.push({ id, partNames: okParts });
                deletables += okParts.length;
            }
        }

        // 4) 削除実行
        let deleted = 0;
        for (const { id, partNames } of deleteTargets) {
            await api.messages.deleteAttachments(id, partNames);
            deleted += partNames.length;
        }

        // 5) 結果通知
        const issues = [];
        if (attFail) issues.push(`${attFail} attachment(s) failed backup`);
        if (bodyFailCount) issues.push(`${bodyFailCount} message bodies failed backup`);
        const tail = issues.length ? `\nSkipped unsafe items: ${issues.join(", ")}` : "";
        await api.notifications.create({
            type: "basic",
            title: "Backup & Deletion Completed",
            message:
                `${stats.affectedMessages} messages selected\n` +
                `${attSaved} attachments saved, ${deleted}/${deletables} attachments deleted${tail}`
        });

    } catch (e) {
        console.error(e);
        await api.notifications.create({
            type: "basic",
            title: "Error during backup/verify/delete",
            message: e?.message || String(e)
        });
    }
}

// ========== UI ==========
api.action.onClicked.addListener(deleteAllAttachmentsOnSelectedMessages);
function createMenus() {
    if (api?.menus?.create) {
        api.menus.create({ id: MENU_ID, title: "Delete attachments from selection…", contexts: ["message_list"] });
    }
}
api.runtime.onInstalled.addListener(createMenus);
api.runtime.onStartup.addListener(createMenus);
api.menus.onClicked.addListener(info => {
    if (info.menuItemId === MENU_ID) deleteAllAttachmentsOnSelectedMessages();
});
