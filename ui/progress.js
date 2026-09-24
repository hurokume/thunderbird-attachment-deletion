(() => {
    'use strict';
    const api = typeof messenger !== 'undefined' ? messenger : browser;
    const $ = id => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const key = params.get('key');
    const { t, number, apply, details } = globalThis.BDI18n;
    let mode = params.get('mode'), terminal = false;
    const show = (id, value) => { $(id).textContent = value || ''; $(id).hidden = !value; };
    function update(i, n) {
        n = Math.max(0, Number(n) || 0);
        i = Math.min(n, Math.max(0, Number(i) || 0));
        $('bar').max = n || 1;
        $('bar').value = i;
        $('pct').textContent = number(n ? Math.floor(i / n * 100) / 100 : 0, { style: 'percent', maximumFractionDigits: 0 });
        $('label').textContent = t(mode === 'scan' ? 'progressScanCount' : 'progressAttachmentCount', [number(i), number(n)]);
    }
    function summary(totals) {
        show('summary', t('progressSummary', [
            totals.totalSaved, totals.totalDeleted, totals.totalFailedSave + totals.totalFailedDelete,
            totals.totalUnprocessed ?? Math.max(0, totals.totalToDelete - totals.totalProcessed)
        ].map(value => number(value))));
    }
    function stop() {
        terminal = true;
        $('cancel').hidden = true;
        $('close').hidden = false;
    }

    $('close').addEventListener('click', async () => {
        const win = await api.windows.getCurrent();
        await api.windows.remove(win.id);
    });
    $('cancel').addEventListener('click', async () => {
        $('cancel').disabled = true;
        $('cancel').textContent = t('cancelling');
        try {
            const response = await api.runtime.sendMessage({ type: 'progress-cancel', key });
            if (!response?.ack) throw new Error(t('communicationFailed'));
        } catch {
            show('error', t('communicationFailed'));
            $('close').hidden = false;
        }
    });

    api.runtime.onMessage.addListener(msg => {
        if (msg?.key !== key || terminal) return;
        if (msg.type === 'progress-scan') {
            mode = 'scan';
            update(msg.i, msg.n);
        } else if (msg.type === 'progress-update') {
            mode = 'attachments';
            update(msg.totals.totalProcessed, msg.totals.totalToDelete);
            summary(msg.totals);
            show('warn', msg.backupEnabled === false ? t('backupDisabled') : '');
        } else if (msg.type === 'progress-error') {
            show('error', details(t('operationFailed'), msg.message));
            stop();
        } else if (msg.type === 'progress-done' || msg.type === 'progress-cancelled') {
            const result = msg.result;
            update(result.totals.totalProcessed, result.totals.totalToDelete);
            summary(result.totals);
            $('label').textContent = result.cancelled ? t('cancelled') : result.issues.length ? t('completedWithErrors') : t('completed');
            const lines = [
                ...result.issues.map(r => t('issueDetail', [t(r.stage === 'backup' ? 'stageBackup' : 'stageDelete'), r.id, r.partName, r.error])),
                ...result.savedFiles.map(r => t('backupPathDetail', [r.id, r.partName, r.path]))
            ];
            if (lines.length) {
                $('details').hidden = false;
                $('details-title').textContent = t('resultsAndPaths');
                $('results').textContent = lines.join('\n');
            }
            stop(); // Keep results visible, including partial progress after cancellation.
        } else return;
        return Promise.resolve({ ack: true });
    });

    document.addEventListener('DOMContentLoaded', async () => {
        apply();
        document.querySelector('header .subtitle').textContent = mode === 'scan' ? t('scanning') : t('processing');
        update(0, Number(params.get('total')));
        try {
            const response = await api.runtime.sendMessage({ type: 'progress-ready', key });
            if (!response?.ack) throw new Error(t('communicationFailed'));
        } catch {
            show('error', t('communicationFailed'));
            stop();
        }
    });
})();
