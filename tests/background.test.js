const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, flush, fakeClock } = require('./helpers.cjs');

test('a completed download without an existing file never authorizes deletion', async () => {
    const clock = fakeClock(), f = fixture({ clock });
    const download = f.api.downloads.download;
    f.api.downloads.download = async request => {
        const id = await download(request);
        f.downloads.get(id).exists = false;
        return id;
    };
    let finished = false;
    const pending = f.BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2'] }], new Map())
        .then(result => { finished = true; return result; });
    for (let i = 0; i < 30 && !finished; i++) {
        await flush();
        for (const task of [...clock.tasks.values()]) clock.fire(task.ms);
    }
    assert.equal(finished, true);
    const result = await pending;
    assert.equal(f.calls.downloads.length, 3);
    assert.equal(f.calls.deleted.length, 0);
    assert.equal(result.totals.totalFailedSave, 1);
    assert.equal(result.totals.totalProcessed, 1);
    assert.equal(clock.tasks.size, 0);
});

test('all attachments in a message are backed up before any of them are deleted', async () => {
    const f = fixture();
    f.api.messages.listAttachments = async () => ['1.2', '1.3'].map(partName => ({ partName, contentType: 'application/pdf' }));
    f.api.messages.deleteAttachments = async (id, parts) => {
        assert.equal(f.calls.downloads.length, 2);
        assert.deepEqual(Array.from(parts), ['1.2', '1.3']);
        f.calls.deleted.push(id);
    };
    const result = await f.BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2', '1.3'] }], new Map());
    assert.equal(result.totals.totalDeleted, 2);
    assert.equal(f.calls.deleted.length, 1);
});

test('a long subfolder reduces the final filename budget', async () => {
    const f = fixture();
    const settings = await f.BD.settings.setSettings({ saveRoot: 'a'.repeat(59) + '/' + 'b'.repeat(60) });
    f.api.messages.getAttachmentFile = async () => ({ name: '日本語'.repeat(80) + '.pdf' });
    await f.BD.mail.saveAllAttachmentsVerified([{ id: 1, partNames: ['1.2'] }], new Map([[1, { subject: '長い件名'.repeat(100) }]]), { settings });
    const filename = f.calls.downloads[0].filename;
    assert.ok(new TextEncoder().encode(filename).length <= 220);
    assert.ok(filename.endsWith('.pdf'));
});

test('cancelling during a configured message cooldown prevents the next message', async () => {
    const clock = fakeClock(), f = fixture({ clock }), controller = new AbortController();
    const settings = { ...await f.BD.settings.getSettings(), cooldownAfterEachMessageMs: 4321 };
    const pending = f.BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2'] }, { id: 2, partNames: ['1.2'] }], new Map(), {
        signal: controller.signal, settings
    });
    await flush();
    assert.ok([...clock.tasks.values()].some(t => t.ms === 4321));
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(f.calls.deleted.length, 1);
    assert.equal(f.calls.reads.length, 1);
    assert.equal(clock.tasks.size, 0);
});

test('empty and blank roots reset to the default; empty separators are not named item', async () => {
    const { BD } = fixture();
    assert.equal((await BD.settings.setSettings({ saveRoot: '' })).saveRoot, 'BulkAttachmentBackup');
    assert.equal((await BD.settings.setSettings({ saveRoot: '  ' })).saveRoot, 'BulkAttachmentBackup');
    assert.equal((await BD.settings.setSettings({ saveRoot: 'a//b/' })).saveRoot, 'a/b');
    await assert.rejects(BD.settings.setSettings({ saveRoot: '../outside' }), /relative/);
});

test('legacy root settings are preserved and backup remains enabled by default', async () => {
    const { BD } = fixture({ stored: { 'settings.saveRoot': 'OldBackups' } });
    const settings = await BD.settings.getSettings();
    assert.equal(settings.saveRoot, 'OldBackups');
    assert.equal(settings.backupEnabled, true);
    assert.equal(settings.saveMode, 'inherit');
    assert.equal(settings.perFileDelayMs, 0);
    assert.equal(settings.cooldownAfterEachMessageMs, 0);
});

test('a failed settings write does not change effective settings', async () => {
    const { BD, api } = fixture();
    api.storage.local.set = async () => { throw new Error('disk full'); };
    await assert.rejects(BD.settings.setSettings({ backupEnabled: false, saveRoot: 'Changed' }), /disk full/);
    const settings = await BD.settings.getSettings();
    assert.equal(settings.backupEnabled, true);
    assert.equal(settings.saveRoot, 'BulkAttachmentBackup');
});

test('combined backup names fit byte limits, preserve extensions and distinguish parts', () => {
    const { BD } = fixture();
    for (const name of ['a'.repeat(300) + '.pdf', '日本語😀'.repeat(100) + '.pdf']) {
        const meta = { subject: '長い件名'.repeat(80), stamp: '20260924-120000' };
        const filename = BD.utils.backupFilename(meta, name, 1, '1.2');
        assert.ok(new TextEncoder().encode(filename).length <= 180);
        assert.ok(filename.endsWith('.pdf'));
        assert.ok(!filename.includes('\uFFFD'));
        assert.notEqual(filename, BD.utils.backupFilename(meta, name, 1, '1.3'));
        assert.ok(new TextEncoder().encode(BD.utils.addSuffixToPath(filename, '_retry3')).length < 255);
    }
});

test('completed and interrupted downloads are detected without waiting for an event', async () => {
    const { BD, downloads, api } = fixture();
    for (const state of ['complete', 'interrupted']) {
        downloads.set(1, { state });
        assert.equal(await BD.downloads.waitForDownloadState(1, 1000), state);
        assert.equal(api.downloads.onChanged.listeners.size, 0);
    }
});

test('completion while reading the initial snapshot is not lost', async () => {
    const { BD, api } = fixture();
    api.downloads.search = async ({ id }) => {
        api.downloads.onChanged.emit({ id, state: { current: 'complete' } });
        return [{ state: 'in_progress' }];
    };
    assert.equal(await BD.downloads.waitForDownloadState(1, 1000), 'complete');
    assert.equal(api.downloads.onChanged.listeners.size, 0);
});

test('inherit omits saveAs, and ask/automatic modes explicitly set it', async () => {
    const { BD, calls } = fixture();
    for (const saveMode of ['inherit', 'ask', 'automatic']) {
        const result = await BD.downloads.downloadViaBlobAndVerify({}, 'file.pdf', { saveMode });
        assert.equal(result.ok, true);
        assert.ok(result.finalPath.startsWith('C:/Backups/'));
    }
    assert.equal(Object.hasOwn(calls.downloads[0], 'saveAs'), false);
    assert.equal(calls.downloads[1].saveAs, true);
    assert.equal(calls.downloads[2].saveAs, false);
});

test('download timeouts cancel the active download and retry only three times', async () => {
    const clock = fakeClock();
    const { BD, api, calls, downloads } = fixture({ clock });
    const download = api.downloads.download;
    api.downloads.download = async request => {
        const id = await download(request);
        downloads.get(id).state = 'in_progress';
        return id;
    };
    const pending = BD.downloads.downloadViaBlobAndVerify({}, 'file.pdf', { timeoutMs: 10 });
    for (let attempt = 1; attempt <= 3; attempt++) {
        await flush();
        clock.fire(10);
        await flush();
        if (attempt < 3) clock.fire(400 * attempt);
    }
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(calls.downloads.length, 3);
    assert.equal(calls.cancelled.length, 3);
    assert.equal(api.downloads.onChanged.listeners.size, 0);
    assert.equal(clock.tasks.size, 0);
});

test('cancelling a pending backup cancels its download and releases its listener', async () => {
    const { BD, api, downloads, calls } = fixture();
    const controller = new AbortController();
    const download = api.downloads.download;
    api.downloads.download = async request => {
        const id = await download(request);
        downloads.get(id).state = 'in_progress';
        return id;
    };
    const pending = BD.downloads.downloadViaBlobAndVerify({}, 'file.pdf', { signal: controller.signal });
    await flush();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls.downloads.length, 1);
    assert.ok(calls.cancelled.length >= 1);
    assert.equal(api.downloads.onChanged.listeners.size, 0);
});

test('a download ID returned after cancellation is cancelled too', async () => {
    const { BD, api, calls } = fixture();
    const later = deferred(), controller = new AbortController();
    api.downloads.download = () => later.promise;
    const pending = BD.downloads.downloadViaBlobAndVerify({}, 'file.pdf', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    later.resolve(77);
    await flush();
    assert.ok(calls.cancelled.includes(77));
});

test('cancelling a Save As dialog does not reopen it', async () => {
    const { BD, api } = fixture();
    let attempts = 0;
    api.downloads.download = async () => { attempts++; throw new Error('Download canceled by the user'); };
    const result = await BD.downloads.downloadViaBlobAndVerify({}, 'file.pdf');
    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
});

test('permanent backup failure is counted once and does not block later messages', async () => {
    const { BD, api, calls } = fixture();
    api.messages.getAttachmentFile = async id => {
        calls.reads.push(id);
        if (id === 1) throw new Error('missing attachment');
        return { name: 'ok.pdf' };
    };
    const progress = [];
    const result = await BD.runner.runBackupThenDelete([
        { id: 1, partNames: ['1.2'] }, { id: 2, partNames: ['1.2'] }
    ], new Map(), { onProgress: p => progress.push(p) });
    assert.deepEqual(calls.reads, [1, 2]);
    assert.deepEqual(calls.deleted, [[2, ['1.2']]]);
    assert.equal(result.totals.totalFailedSave, 1);
    assert.equal(result.totals.totalProcessed, 2);
    assert.equal(result.totals.totalUnprocessed, 0);
    assert.ok(progress.every(p => p.totals.totalProcessed <= p.totals.totalToDelete));
    assert.equal(result.issues[0].stage, 'backup');
    assert.ok(result.savedFiles[0].path.includes('C:/Backups/'));
});

test('cancellation during backup prevents all new deletion calls', async () => {
    const { BD, calls } = fixture();
    const controller = new AbortController();
    const result = await BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2', '1.3'] }], new Map(), {
        signal: controller.signal,
        onProgress: p => { if (p.totals.totalSaved === 1) controller.abort(); }
    });
    assert.equal(result.cancelled, true);
    assert.equal(calls.deleted.length, 0);
    assert.equal(calls.reads.length, 1);
    assert.equal(result.totals.totalSaved, 1);
    assert.equal(result.totals.totalProcessed, 0);
    assert.equal(result.totals.totalUnprocessed, 2);
});

test('cancellation during final live enumeration prevents deletion', async () => {
    const { BD, api, calls } = fixture();
    const controller = new AbortController();
    api.messages.listAttachments = async () => {
        controller.abort();
        return [{ partName: '1.2', contentType: 'application/pdf' }];
    };
    const result = await BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2'] }], new Map(), { signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.equal(calls.deleted.length, 0);
});

test('an in-flight deletion settles before cancellation finishes; later messages are untouched', async () => {
    const { BD, api, calls } = fixture();
    const controller = new AbortController(), pendingDelete = deferred();
    api.messages.deleteAttachments = (id, parts) => {
        calls.deleted.push([id, [...parts]]);
        controller.abort();
        return pendingDelete.promise;
    };
    let finished = false;
    const run = BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2'] }, { id: 2, partNames: ['1.2'] }], new Map(), {
        signal: controller.signal
    }).then(result => { finished = true; return result; });
    await flush();
    assert.equal(finished, false);
    pendingDelete.resolve();
    const result = await run;
    assert.equal(result.cancelled, true);
    assert.equal(calls.deleted.length, 1);
    assert.equal(result.totals.totalDeleted, 1);
    assert.equal(result.totals.totalUnprocessed, 1);
});

test('backup disabled skips saving; deletion failures remain visible and processing continues', async () => {
    const { BD, api, calls } = fixture();
    api.messages.deleteAttachments = async id => { if (id === 1) throw new Error('encrypted message'); calls.deleted.push(id); };
    const settings = { ...await BD.settings.getSettings(), backupEnabled: false };
    const result = await BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2'] }, { id: 2, partNames: ['1.2'] }], new Map(), { settings });
    assert.equal(calls.downloads.length, 0);
    assert.equal(calls.reads.length, 0);
    assert.equal(result.totals.totalDeleted, 1);
    assert.equal(result.totals.totalFailedDelete, 1);
    assert.equal(result.totals.totalProcessed, 2);
    assert.equal(result.issues[0].error, 'encrypted message');
});

test('deleted placeholders cannot be counted as newly deleted attachments', async () => {
    const { BD, api, calls } = fixture();
    api.messages.listAttachments = async () => [{ partName: '1.2', contentType: 'text/x-moz-deleted' }];
    const settings = { ...await BD.settings.getSettings(), backupEnabled: false };
    const result = await BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2'] }], new Map(), { settings });
    assert.equal(calls.deleted.length, 0);
    assert.equal(result.totals.totalFailedDelete, 1);
});

test('file delays are honored and interruptible; no default message cooldown remains', async () => {
    const clock = fakeClock(), controller = new AbortController();
    const { BD, calls } = fixture({ clock });
    const settings = { ...await BD.settings.getSettings(), perFileDelayMs: 1234 };
    const pending = BD.runner.runBackupThenDelete([{ id: 1, partNames: ['1.2', '1.3'] }], new Map(), {
        settings, signal: controller.signal
    });
    await flush();
    assert.ok([...clock.tasks.values()].some(t => t.ms === 1234));
    controller.abort();
    assert.equal((await pending).cancelled, true);
    assert.equal(calls.deleted.length, 0);
    assert.equal(clock.tasks.size, 0);
});

test('selection includes every page and keeps the originating tab', async () => {
    const { BD, api } = fixture();
    api.mailTabs.getSelectedMessages = async tabId => { assert.equal(tabId, 7); return { id: 'page2', messages: [{ id: 1 }] }; };
    api.messages.continueList = async id => { assert.equal(id, 'page2'); return { messages: [{ id: 2 }, { id: 1 }] }; };
    assert.deepEqual(Array.from(await BD.mail.getAllSelectedMessageIds(7)), [1, 2]);
});

test('scanning reports progress and cancellation prevents the next message read', async () => {
    const { BD, api } = fixture();
    const controller = new AbortController(), read = [];
    api.messages.get = async id => { read.push(id); return { subject: 's', date: new Date() }; };
    await assert.rejects(BD.mail.buildTargetsAndStats([1, 2], {
        signal: controller.signal, onProgress: p => { assert.equal(p.i, 1); controller.abort(); }
    }), { name: 'AbortError' });
    assert.deepEqual(read, [1]);
});

test('concurrent runs are rejected and the lock is released after an early return', async () => {
    const { BD, api, calls } = fixture();
    const selection = deferred();
    let reads = 0;
    api.mailTabs.getSelectedMessages = () => { reads++; return selection.promise; };
    const first = BD.main.deleteAllAttachmentsOnSelectedMessages();
    await BD.main.deleteAllAttachmentsOnSelectedMessages();
    assert.equal(reads, 1);
    assert.ok(calls.notices.some(n => n.title === 'Already running'));
    selection.resolve({ messages: [] });
    await first;
    assert.equal(BD.state.running, false);
});

test('failure to open progress stops the run before any backup or deletion', async () => {
    const { BD, api, calls } = fixture();
    api.windows.create = async () => { throw new Error('window failed'); };
    const listeners = api.runtime.onMessage.listeners.size;
    await BD.main.deleteAllAttachmentsOnSelectedMessages();
    assert.equal(calls.downloads.length, 0);
    assert.equal(calls.deleted.length, 0);
    assert.equal(BD.state.running, false);
    assert.equal(api.runtime.onMessage.listeners.size, listeners);
    assert.equal(api.windows.onRemoved.listeners.size, 0);
    assert.ok(calls.notices.some(n => n.message.includes('window failed')));
});
