// confirm.js
// Thunderbird MV3: 確認ページ用スクリプト（すべて出力）
// - storage.local に置かれたプレビュー用データ（stats/messages）を読み出して表示
// - OK/Cancel を background.js に送信（即時ACK想定）
// - 送信後にウィンドウが閉じられても例外にならないように .catch(() => {}) を付与

'use strict';

const api = (typeof messenger !== 'undefined') ? messenger : browser;

// --- utils ---
function humanSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let b = Math.max(0, Number(bytes || 0));
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i ? 1 : 0)} ${units[i]}`;
}

(function main() {
    const params = new URLSearchParams(location.search);
    const key = params.get('key') || '';
    const affectedQS = params.get('affected') || '0';
    const totalQS = params.get('total') || '0';
    const bytesQS = params.get('bytes') || '0';

    // 上段カードはクエリで即表示（体感を速く）
    const affectedEl = document.getElementById('affected');
    const totalEl = document.getElementById('total');
    const bytesEl = document.getElementById('bytes');
    if (affectedEl) affectedEl.textContent = affectedQS;
    if (totalEl) totalEl.textContent = totalQS;
    if (bytesEl) bytesEl.textContent = humanSize(bytesQS);

    const okBtn = document.getElementById('ok');
    const cancelBtn = document.getElementById('cancel');

    function disableButtons() {
        if (okBtn) okBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
    }

    // 表の描画
    function renderExtSummary(extSummary) {
        const tbody = document.querySelector('#extTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!Array.isArray(extSummary) || extSummary.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="3" style="color:var(--muted)">No data</td>`;
            tbody.appendChild(tr);
            return;
        }
        for (const row of extSummary) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
        <td>${row.ext}</td>
        <td class="num">${row.count}</td>
        <td class="num">${humanSize(row.bytes)}</td>
      `;
            tbody.appendChild(tr);
        }
    }

    function renderMessages(messages) {
        const tbody = document.querySelector('#msgTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!Array.isArray(messages) || messages.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="5" style="color:var(--muted)">No target messages</td>`;
            tbody.appendChild(tr);
            return;
        }
        for (const m of messages) {
            const names = (m.attachments || []).map(a => `${a.name} : ${humanSize(a.size)}`);
            const tr = document.createElement('tr');
            tr.innerHTML = `
        <td>${m.subject || ''}</td>
        <td>${m.author || ''}</td>
        <td>${m.date || ''}</td>
        <td class="num">${(m.attachments || []).length}</td>
        <td class="attach-list">${names.join('<br/>')}</td>
      `;
            tbody.appendChild(tr);
        }
    }

    async function loadAndRender() {
        try {
            const got = await api.storage.local.get(key);
            const data = got[key];
            if (!data || !data.stats) {
                // データが無い場合は安全側でキャンセル通知して終了
                disableButtons();
                api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }).catch(() => { });
                return;
            }

            // extSummary / messages を描画
            renderExtSummary(data.stats.extSummary || []);
            renderMessages(data.messages || []);

            // ボタンハンドラ
            if (okBtn) {
                okBtn.addEventListener('click', () => {
                    disableButtons();
                    // 背景がウィンドウを閉じても例外にならないように catch を付ける
                    api.runtime.sendMessage({ type: 'confirm-result', key, ok: true }).catch(() => { });
                });
            }
            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => {
                    disableButtons();
                    api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }).catch(() => { });
                });
            }
        } catch (e) {
            // storage にアクセスできない場合も安全側でキャンセル
            console.error('confirm: storage access failed', e);
            disableButtons();
            api.runtime.sendMessage({ type: 'confirm-result', key, ok: false }).catch(() => { });
        }
    }

    // 初期化
    loadAndRender();
})();
