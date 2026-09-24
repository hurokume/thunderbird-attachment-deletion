const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, flush, page, translations } = require('./helpers.cjs');

const root = path.join(__dirname, '..');
const locales = fs.readdirSync(path.join(root, '_locales'));
const catalog = locale => JSON.parse(fs.readFileSync(path.join(root, '_locales', locale, 'messages.json'), 'utf8'));
const english = catalog('en');
const placeholderNames = text => [...new Set([...text.matchAll(/\$([a-z_]+)\$/gi)].map(m => m[1].toLowerCase()))].sort();

test('all locales have complete messages and matching named placeholder definitions', () => {
    assert.deepEqual([...locales].sort(), ['en', 'ja', 'zh_CN', 'zh_TW']);
    for (const locale of locales) {
        const messages = catalog(locale);
        assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort(), locale);
        assert.ok(Intl.getCanonicalLocales(messages.locale.message).length === 1);
        assert.ok(['ltr', 'rtl'].includes(messages.direction.message));
        for (const [key, item] of Object.entries(messages)) {
            assert.ok(item.message.trim(), locale + ': ' + key);
            const names = placeholderNames(item.message);
            assert.deepEqual(names, Object.keys(item.placeholders || {}).sort(), locale + ': ' + key);
            assert.deepEqual(names, placeholderNames(english[key].message), locale + ': ' + key);
            for (const name of names) {
                assert.equal(item.placeholders[name].content, english[key].placeholders[name].content);
                assert.match(item.placeholders[name].content, /^\$[1-9]$/);
            }
        }
    }
});

test('manifest and runtime message references exist in the English catalog', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.default_locale, 'en');
    assert.equal(manifest.name, '__MSG_extensionName__');
    assert.equal(manifest.description, '__MSG_extensionDescription__');
    assert.ok(manifest.background.scripts.includes('shared/i18n.js'));
    const files = ['manifest.json'];
    for (const directory of ['bg', 'ui', 'shared']) {
        files.push(...fs.readdirSync(path.join(root, directory)).filter(f => /\.(js|html)$/.test(f)).map(f => directory + '/' + f));
    }
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        for (const expression of [/\bt\(\s*'([^']+)'/g, /data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]+)"/g, /__MSG_(\w+)__/g]) {
            for (const match of source.matchAll(expression)) assert.ok(english[match[1]], file + ': ' + match[1]);
        }
        if (file.endsWith('.html')) {
            const scripts = [...source.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
            assert.equal(scripts[0], '../shared/i18n.js', file);
            for (const script of scripts) assert.ok(fs.existsSync(path.join(root, path.dirname(file), script)));
        }
    }
});

const cases = [
    { language: 'en-US', locale: 'en', settings: 'Settings', confirm: 'Review before deleting', preflight: 'Confirm before evaluation', progress: 'Progress', cancel: 'Cancelled', close: 'Close', none: 'No messages selected', totalSize: 'Total size' },
    { language: 'ja-JP', locale: 'ja', settings: '設定', confirm: '削除前の確認', preflight: '事前確認', progress: '進捗', cancel: 'キャンセルしました', close: '閉じる', none: 'メールが選択されていません', totalSize: '合計サイズ' },
    { language: 'zh-CN', locale: 'zh-CN', settings: '设置', confirm: '删除前确认', preflight: '评估前确认', progress: '进度', cancel: '已取消', close: '关闭', none: '未选择邮件', totalSize: '总大小' },
    { language: 'zh-TW', locale: 'zh-TW', settings: '設定', confirm: '刪除前確認', preflight: '評估前確認', progress: '進度', cancel: '已取消', close: '關閉', none: '未選取郵件', totalSize: '總大小' }
];
for (const expected of cases) {
    test(expected.language + ': settings, confirmations, progress and notifications are localized', async () => {
        let progress;
        const f = fixture({
            language: expected.language,
            onWindow: async (win, api) => {
                progress = page('ui/progress.js', api, win.url, []);
                await progress.ready();
            }
        });
        const settings = page('ui/options.js', f.api, 'moz-extension://test/ui/options.html', []);
        await settings.ready(); await flush();
        assert.equal(settings.document.documentElement.lang, expected.locale);
        assert.equal(settings.document.documentElement.dir, 'ltr');
        assert.equal(settings.nodes.title.textContent, expected.settings);
        assert.ok(settings.document.title.endsWith(expected.settings));
        settings.nodes.dir.value = '../outside';
        await settings.nodes.save.click();
        assert.ok(settings.nodes.err.textContent.includes(f.api.i18n.getMessage('invalidSubfolder')));

        const preflight = page('ui/preflight.js', f.api, 'moz-extension://test/ui/preflight.html?key=pre&count=1200', []);
        await preflight.ready();
        assert.equal(preflight.nodes.heading.textContent, expected.preflight);
        assert.equal(preflight.nodes.count.textContent, f.api.i18n.getMessage('selectedMessages', ['1,200']));
        await preflight.nodes.ok.click();
        assert.ok(preflight.nodes.error.textContent.includes(f.api.i18n.getMessage('communicationFailed')));

        f.stored.preview = {
            stats: { affectedMessages: 1234, totalAttachments: 2345, totalBytes: 1048576, extSummary: [] },
            messages: [], settings: { backupEnabled: false }
        };
        const confirm = page('ui/confirm.js', f.api, 'moz-extension://test/ui/confirm.html?key=preview', []);
        await confirm.ready();
        assert.equal(confirm.nodes.heading.textContent, expected.confirm);
        assert.equal(confirm.nodes.ok.textContent, f.api.i18n.getMessage('deleteWithoutBackup'));
        assert.equal(confirm.nodes.affected.textContent, '1,234');
        assert.equal(confirm.nodes.total.textContent, '2,345');
        assert.equal(confirm.nodes.bytes.textContent, '1.0 MB');
        assert.equal(confirm.parsed.find(el => el.getAttribute('data-i18n') === 'totalSize').textContent, expected.totalSize);
        for (const template of confirm.templates) {
            for (const el of template.content.querySelectorAll('[data-i18n]')) {
                assert.equal(el.textContent, f.api.i18n.getMessage(el.getAttribute('data-i18n')));
            }
        }

        const ctrl = await f.BD.ui.openProgressPage({ total: 10 });
        try {
            assert.equal(progress.nodes.heading.textContent, expected.progress);
            assert.equal(progress.nodes.bar.getAttribute('aria-label'), f.api.i18n.getMessage('progressBarLabel'));
            await ctrl.finish({
                totals: { totalToDelete: 10, totalProcessed: 3, totalSaved: 3, totalDeleted: 2, totalFailedSave: 0, totalFailedDelete: 1, totalUnprocessed: 7 },
                issues: [{ stage: 'delete', id: 1, partName: '1.2', error: 'FILE_ACCESS_DENIED' }],
                savedFiles: [{ id: 1, partName: '1.2', path: 'C:/原文/backup.pdf' }],
                cancelled: true, backupEnabled: true
            });
            assert.equal(progress.nodes.label.textContent, expected.cancel);
            assert.equal(progress.nodes.close.textContent, expected.close);
            assert.equal(progress.nodes.pct.textContent, '30%');
            assert.ok(progress.nodes.results.textContent.includes(f.api.i18n.getMessage('stageDelete')));
            assert.ok(progress.nodes.results.textContent.includes('FILE_ACCESS_DENIED'));
            assert.ok(progress.nodes.results.textContent.includes('C:/原文/backup.pdf'));
        } finally { await ctrl.dispose({ close: true }); }

        await f.BD.ui.createMenus();
        assert.equal(f.calls.menu.title, f.api.i18n.getMessage('menuDelete'));
        f.api.mailTabs.getSelectedMessages = async () => ({ messages: [] });
        await f.BD.main.deleteAllAttachmentsOnSelectedMessages();
        assert.equal(f.calls.notices.at(-1).title, expected.none);

        f.api.downloads.download = async () => { throw new Error('USER_CANCELED'); };
        const backup = await f.BD.downloads.downloadViaBlobAndVerify({}, 'test.pdf');
        assert.equal(backup.ok, false);
        assert.equal(backup.error, f.api.i18n.getMessage('downloadCancelled'));
    });
}

test('an unsupported UI language falls back to English messages, metadata and document language', async () => {
    const f = fixture({ language: 'fr-FR' });
    const p = page('ui/options.js', f.api, 'moz-extension://test/ui/options.html', []);
    await p.ready(); await flush();
    assert.equal(p.nodes.title.textContent, 'Settings');
    assert.equal(p.document.documentElement.lang, 'en');
    assert.equal(p.document.documentElement.dir, 'ltr');
    assert.equal(f.api.i18n.getMessage('extensionDescription'), english.extensionDescription.message);
    assert.equal(f.context.BDI18n.number(1234.5), '1,234.5');
});

test('substitutions and diagnostic details preserve literal user content', () => {
    const api = translations('ja');
    assert.equal(api.getMessage('notInAnyCatalog'), '');
    const f = fixture({ language: 'ja' });
    const rawPath = '<b>日本語 & $COUNT$</b>';
    assert.ok(f.context.BDI18n.t('backupLocation', rawPath).endsWith(rawPath));
    assert.equal(f.context.BDI18n.details('説明', 'FILE_FAILED'), '説明 詳細: FILE_FAILED');
});

test('mail content is preserved while missing labels and dates follow the interface language', async () => {
    const f = fixture({ language: 'ja' });
    const stamp = new Date('2026-09-24T12:34:56Z');
    f.api.messages.get = async id => ({ subject: id === 1 ? 'Original subject <>&' : '', author: 'original@example.com', date: stamp });
    f.api.messages.listAttachments = async id => [{ partName: '1.2', contentType: 'application/pdf', size: 3, name: id === 1 ? '原文.pdf' : '' }];
    const built = await f.BD.mail.buildTargetsAndStats([1, 2]);
    assert.equal(built.messages[0].subject, 'Original subject <>&');
    assert.equal(built.messages[0].attachments[0].name, '原文.pdf');
    assert.equal(built.messages[1].subject, '（件名なし）');
    assert.equal(built.messages[1].attachments[0].name, '（名前なし）');
    assert.equal(built.messages[0].date, new Intl.DateTimeFormat('ja', { dateStyle: 'medium', timeStyle: 'medium' }).format(stamp));
});

test('the DOM translator uses textContent and localized accessibility attributes, never HTML', () => {
    const f = fixture({ language: 'ja' });
    const text = { textContent: '', getAttribute: () => 'settingsTitle', set innerHTML(_) { throw new Error('unsafe HTML'); } };
    const aria = { getAttribute: () => 'progressBarLabel', setAttribute(name, value) { this[name] = value; } };
    const fragment = {
        documentElement: {},
        querySelectorAll: selector => selector === '[data-i18n]' ? [text] : selector === '[data-i18n-aria-label]' ? [aria] : []
    };
    f.context.BDI18n.apply(fragment);
    assert.equal(text.textContent, '設定');
    assert.equal(aria['aria-label'], '添付ファイル処理の進捗');
    assert.equal(fragment.documentElement.lang, 'ja');
});
