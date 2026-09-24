const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, fakeClock, flush, page } = require('./helpers.cjs');

test('options page saves normalized values and Reset restores enabled backups and the default folder', async () => {
    const f = fixture({ stored: { 'settings.saveRoot': 'Custom', 'settings.backupEnabled': false } });
    const ids = ['title', 'subtitle', 'labelDir', 'hint', 'labelBackup', 'labelMode', 'inherit', 'ask', 'automatic',
        'labelFileDelay', 'labelMessageDelay', 'save', 'reset', 'dir', 'backup', 'mode', 'fileDelay', 'messageDelay',
        'preview', 'msg', 'err', 'backup-warning'];
    const p = page('ui/options.js', f.api, 'moz-extension://test/ui/options.html', ids);
    await p.ready(); await flush();
    assert.equal(p.nodes.dir.value, 'Custom');
    assert.equal(p.nodes.backup.checked, false);
    assert.equal(p.nodes['backup-warning'].hidden, false);
    await p.nodes.reset.click();
    assert.equal(p.nodes.dir.value, 'BulkAttachmentBackup');
    assert.equal(p.nodes.backup.checked, true);
    assert.equal(p.nodes.mode.value, 'inherit');
    p.nodes.dir.value = ' New//Folder/ ';
    p.nodes.mode.value = 'ask';
    await p.nodes.save.click();
    assert.equal(p.nodes.dir.value, 'New/Folder');
    assert.equal((await f.BD.settings.getSettings()).saveMode, 'ask');
});

const progressIds = ['heading', 'subtitle', 'bar', 'pct', 'label', 'summary', 'warn', 'error', 'cancel', 'close', 'details', 'details-title', 'results'];
const confirmIds = ['heading', 'subtitle', 'affected', 'total', 'bytes', 'ok', 'cancel', 'warn', 'error', 'backup-mode'];
const payload = {
    stats: { selectedMessages: 1, affectedMessages: 1, totalAttachments: 1, totalBytes: 3, extSummary: [] },
    messages: [], settings: { backupEnabled: true, saveRoot: 'Backup' }
};
const result = {
    totals: { totalToDelete: 10, totalProcessed: 3, totalSaved: 3, totalDeleted: 2, totalFailedSave: 0, totalFailedDelete: 1, totalUnprocessed: 7 },
    issues: [{ id: 1, partName: '1.2', stage: 'delete', error: 'denied' }],
    savedFiles: [{ id: 1, partName: '1.2', path: 'C:/ActualBackup/a.pdf' }],
    cancelled: true, backupEnabled: true
};

test('both immediate preflight decisions are accepted before window creation resolves', async () => {
    for (const decision of [true, false]) {
        const clock = fakeClock();
        const f = fixture({ clock, onWindow: async (win, api) => {
            const p = page('ui/preflight.js', api, win.url, ['count', 'ok', 'cancel', 'error']);
            await p.ready();
            await p.nodes[decision ? 'ok' : 'cancel'].click();
            assert.equal(p.nodes.ok.disabled, true);
        } });
        const listeners = f.api.runtime.onMessage.listeners.size;
        assert.equal(await f.BD.ui.openPreflightAndWait(101), decision);
        assert.equal(f.calls.closed.length, 1);
        assert.equal(clock.tasks.size, 0);
        assert.equal(f.api.runtime.onMessage.listeners.size, listeners);
        assert.equal(f.api.windows.onRemoved.listeners.size, 0);
    }
});

test('closing a dialog during creation immediately cancels instead of waiting ten minutes', async () => {
    const clock = fakeClock();
    const f = fixture({ clock, onWindow: (win, api) => api.windows.remove(win.id) });
    assert.equal(await f.BD.ui.openPreflightAndWait(101), false);
    assert.equal(clock.tasks.size, 0);
    assert.equal(f.api.windows.onRemoved.listeners.size, 0);
});

test('a timed-out confirmation closes and removes its preview data and listeners', async () => {
    const clock = fakeClock(), f = fixture({ clock });
    const listeners = f.api.runtime.onMessage.listeners.size;
    const pending = f.BD.ui.openConfirmPageAndWait(payload);
    await flush();
    assert.ok(Object.keys(f.stored).some(key => key.startsWith('confirm_')));
    clock.fire(600000);
    assert.equal(await pending, false);
    assert.equal(Object.keys(f.stored).length, 0);
    assert.equal(f.calls.closed.length, 1);
    assert.equal(f.api.runtime.onMessage.listeners.size, listeners);
    assert.equal(clock.tasks.size, 0);
});

test('window creation failure cleans up confirmation storage and message listeners', async () => {
    const f = fixture();
    const listeners = f.api.runtime.onMessage.listeners.size;
    f.api.windows.create = async () => { throw new Error('cannot open'); };
    await assert.rejects(f.BD.ui.openConfirmPageAndWait(payload), /cannot open/);
    assert.equal(Object.keys(f.stored).length, 0);
    assert.equal(f.api.runtime.onMessage.listeners.size, listeners);
    assert.equal(f.api.windows.onRemoved.listeners.size, 0);
});

test('unacknowledged preflight messages re-enable controls and show an error', async () => {
    const f = fixture();
    const p = page('ui/preflight.js', f.api, 'moz-extension://test/ui/preflight.html?key=missing&count=101',
        ['count', 'ok', 'cancel', 'error']);
    await p.ready();
    await p.nodes.ok.click();
    assert.equal(p.nodes.ok.disabled, false);
    assert.equal(p.nodes.cancel.disabled, false);
    assert.equal(p.nodes.error.hidden, false);
});

test('early progress-ready is accepted; finishing removes background listeners', async () => {
    const f = fixture({ onWindow: async (win, api) => {
        const key = new URL(win.url).searchParams.get('key');
        const response = await api.runtime.sendMessage({ type: 'progress-ready', key });
        assert.equal(response.ack, true);
    } });
    const baseline = f.api.runtime.onMessage.listeners.size;
    const ctrl = await f.BD.ui.openProgressPage({ total: 10 });
    const receiver = msg => msg.type === 'progress-cancelled' ? Promise.resolve({ ack: true }) : undefined;
    f.api.runtime.onMessage.addListener(receiver);
    await ctrl.finish(result);
    assert.equal(f.api.runtime.onMessage.listeners.size, baseline + 1);
    assert.equal(f.api.windows.onRemoved.listeners.size, 0);
    await ctrl.dispose();
    assert.equal(f.api.runtime.onMessage.listeners.size, baseline + 1);
});

test('progress readiness timeout fails closed and releases all resources', async () => {
    const clock = fakeClock(), f = fixture({ clock });
    const baseline = f.api.runtime.onMessage.listeners.size;
    const pending = f.BD.ui.openProgressPage();
    await flush();
    clock.fire(20000);
    await assert.rejects(pending, /did not become ready/);
    assert.equal(clock.tasks.size, 0);
    assert.equal(f.calls.closed.length, 1);
    assert.equal(f.api.runtime.onMessage.listeners.size, baseline);
    assert.equal(f.api.windows.onRemoved.listeners.size, 0);
});

test('cancel arriving before progress-ready is retained', async () => {
    const f = fixture({ onWindow: async (win, api) => {
        const key = new URL(win.url).searchParams.get('key');
        await api.runtime.sendMessage({ type: 'progress-cancel', key });
    } });
    await assert.rejects(f.BD.ui.openProgressPage(), { name: 'AbortError' });
    assert.equal(f.api.windows.onRemoved.listeners.size, 0);
    assert.equal(f.calls.closed.length, 1);
});

test('closing an active progress window aborts the controller', async () => {
    const f = fixture({ onWindow: async (win, api) => {
        await api.runtime.sendMessage({ type: 'progress-ready', key: new URL(win.url).searchParams.get('key') });
    } });
    const ctrl = await f.BD.ui.openProgressPage();
    await f.api.windows.remove(f.calls.windows[0].id);
    assert.equal(ctrl.signal.aborted, true);
    await ctrl.dispose();
    assert.equal(f.api.windows.onRemoved.listeners.size, 0);
});

test('cancelled progress keeps its actual percentage, errors and saved paths visible', async () => {
    let p;
    const f = fixture({ onWindow: async (win, api) => {
        p = page('ui/progress.js', api, win.url, progressIds);
        await p.ready();
    } });
    const ctrl = await f.BD.ui.openProgressPage({ total: 10 });
    await ctrl.finish(result);
    assert.equal(p.nodes.label.textContent, 'Cancelled');
    assert.equal(p.nodes.pct.textContent, '30%');
    assert.equal(p.nodes.close.hidden, false);
    assert.equal(p.nodes.cancel.hidden, true);
    assert.ok(p.nodes.results.textContent.includes('C:/ActualBackup/a.pdf'));
    assert.ok(p.nodes.results.textContent.includes('denied'));
    assert.equal(f.calls.closed.length, 0);
});

test('a partial failure is not labeled as full success', async () => {
    let p;
    const f = fixture({ onWindow: async (win, api) => {
        p = page('ui/progress.js', api, win.url, progressIds);
        await p.ready();
    } });
    const ctrl = await f.BD.ui.openProgressPage({ total: 10 });
    await ctrl.finish({ ...result, cancelled: false });
    assert.equal(p.nodes.label.textContent, 'Completed with errors');
    assert.equal(p.nodes.close.hidden, false);
});

test('confirmation explicitly shows disabled backup before enabling deletion', async () => {
    let p;
    const f = fixture({ onWindow: async (win, api) => {
        p = page('ui/confirm.js', api, win.url, confirmIds);
        await p.ready();
        assert.equal(p.nodes.ok.disabled, false);
        assert.equal(p.nodes.ok.textContent, 'Delete without backup');
        assert.ok(p.nodes['backup-mode'].textContent.includes('Backup is disabled'));
        await p.nodes.ok.click();
    } });
    assert.equal(await f.BD.ui.openConfirmPageAndWait({
        ...payload, settings: { backupEnabled: false }
    }), true);
    assert.equal(Object.keys(f.stored).length, 0);
});

test('missing confirmation data never enables deletion', async () => {
    const f = fixture();
    const p = page('ui/confirm.js', f.api, 'moz-extension://test/ui/confirm.html?key=missing', confirmIds);
    await p.ready();
    assert.equal(p.nodes.ok.disabled, true);
    assert.equal(p.nodes.cancel.disabled, false);
    assert.equal(p.nodes.error.hidden, false);
});

test('101-message workflow completes through real page handlers and a frozen settings snapshot', async () => {
    const pages = [];
    const f = fixture({ onWindow: async (win, api) => {
        const pathname = new URL(win.url).pathname;
        if (pathname.endsWith('preflight.html')) {
            const p = page('ui/preflight.js', api, win.url, ['count', 'ok', 'cancel', 'error']);
            await p.ready(); await p.nodes.ok.click();
        } else if (pathname.endsWith('confirm.html')) {
            const p = page('ui/confirm.js', api, win.url, confirmIds);
            await p.ready();
            assert.ok(p.nodes['backup-mode'].textContent.includes('backed up'));
            // Changing settings in another window cannot change this confirmed run.
            await api.storage.local.set({ 'settings.backupEnabled': false });
            await p.nodes.ok.click();
        } else {
            const p = page('ui/progress.js', api, win.url, progressIds);
            pages.push(p);
            await p.ready();
        }
    } });
    f.api.mailTabs.getSelectedMessages = async () => ({ messages: Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })) });
    await f.BD.main.deleteAllAttachmentsOnSelectedMessages();
    assert.equal(f.calls.deleted.length, 101);
    assert.equal(f.calls.downloads.length, 101);
    assert.equal(pages.at(-1).nodes.label.textContent, 'Completed');
    assert.equal(pages.at(-1).nodes.pct.textContent, '100%');
    assert.equal(f.BD.state.running, false);
    assert.equal(Object.keys(f.stored).filter(k => k.startsWith('confirm_')).length, 0);
    assert.equal(f.calls.closed.length, 3); // preflight, scan, confirmation; results stay open
    assert.ok(f.calls.notices.some(n => n.title === 'Completed'));
});
