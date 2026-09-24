const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function event() {
    const listeners = new Set();
    return {
        listeners,
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        emit: (...args) => [...listeners].map(fn => fn(...args))
    };
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fakeClock() {
    let id = 0;
    const tasks = new Map();
    return {
        tasks,
        setTimeout: (fn, ms) => { tasks.set(++id, { fn, ms }); return id; },
        clearTimeout: id => tasks.delete(id),
        fire: ms => {
            for (const [id, task] of [...tasks]) if (task.ms === ms) { tasks.delete(id); task.fn(); }
        }
    };
}

function translations(language = 'en') {
    const root = path.join(__dirname, '..', '_locales');
    const base = JSON.parse(fs.readFileSync(path.join(root, 'en', 'messages.json'), 'utf8'));
    const names = fs.readdirSync(root);
    const tag = language.replace(/-/g, '_').toLowerCase();
    const locale = names.find(name => name.toLowerCase() === tag) ||
        names.find(name => name.toLowerCase() === tag.split('_')[0]) || 'en';
    const catalog = JSON.parse(fs.readFileSync(path.join(root, locale, 'messages.json'), 'utf8'));
    return {
        getUILanguage: () => language,
        getMessage: (key, substitutions = []) => {
            const item = catalog[key] || base[key];
            if (!item) return '';
            const values = Array.isArray(substitutions) ? substitutions : [substitutions];
            return item.message.replace(/\$([a-z_]+)\$/gi, (_, name) =>
                item.placeholders[name.toLowerCase()].content.replace(/\$(\d+)/g, (_, index) => String(values[index - 1] ?? '')));
        }
    };
}

function fixture(options = {}) {
    const stored = { ...options.stored }, downloads = new Map(), windows = new Map();
    const calls = { downloads: [], cancelled: [], deleted: [], notices: [], windows: [], closed: [], reads: [] };
    let nextId = 0;
    const api = {
        i18n: translations(options.language),
        runtime: {
            onMessage: event(), onInstalled: event(), onStartup: event(),
            getURL: p => 'moz-extension://test/' + p,
            sendMessage: async message => {
                let response, responded = false;
                const respond = value => { if (!responded) { response = value; responded = true; } };
                const replies = api.runtime.onMessage.emit(message, { id: 'test' }, respond);
                for (const reply of replies) if (reply?.then) respond(await reply);
                return response;
            }
        },
        storage: { local: {
            get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in stored).map(k => [k, stored[k]])),
            set: async values => { Object.assign(stored, values); },
            remove: async key => { delete stored[key]; }
        } },
        windows: {
            onRemoved: event(),
            create: async props => {
                const win = { id: ++nextId, ...props };
                calls.windows.push(win); windows.set(win.id, win);
                await options.onWindow?.(win, api);
                return win;
            },
            remove: async id => { windows.delete(id); calls.closed.push(id); api.windows.onRemoved.emit(id); }
        },
        menus: { onClicked: event(), onShown: event(), create: item => { calls.menu = item; }, remove: async () => {}, update: async () => {}, refresh: async () => {} },
        notifications: { create: async notice => { calls.notices.push(notice); } },
        mailTabs: { getSelectedMessages: async () => ({ messages: [{ id: 1 }] }) },
        messages: {
            get: async id => ({ id, subject: 'Subject', author: 'Sender', date: new Date('2026-09-24T12:00:00Z') }),
            getFull: async () => ({ headers: {} }),
            listAttachments: async () => [{ partName: '1.2', contentType: 'application/pdf', name: 'test.pdf', size: 3 }],
            getAttachmentFile: async (id, partName) => { calls.reads.push([id, partName]); return { name: 'test.pdf', size: 3 }; },
            deleteAttachments: async (id, parts) => { calls.deleted.push([id, [...parts]]); }
        },
        downloads: {
            onChanged: event(),
            download: async request => {
                calls.downloads.push(request);
                const id = ++nextId;
                downloads.set(id, { id, state: 'complete', exists: true, filename: 'C:/Backups/' + request.filename });
                return id;
            },
            search: async ({ id }) => downloads.has(id) ? [downloads.get(id)] : [],
            cancel: async id => { calls.cancelled.push(id); }
        }
    };
    const context = vm.createContext({
        browser: api, console: options.console || { log() {}, warn() {}, error() {} },
        setTimeout: options.clock?.setTimeout || setTimeout, clearTimeout: options.clock?.clearTimeout || clearTimeout,
        DOMException, AbortController, TextEncoder, URLSearchParams, Date, crypto: webcrypto,
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }
    });
    const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    for (const file of manifest.background.scripts) load(file);
    return { api, BD: context.BD, context, load, calls, stored, downloads, windows };
}

function page(file, api, url, ids) {
    function node(attrs = {}, content = '') {
        return {
            attributes: attrs, textContent: content, value: attrs.value || '',
            hidden: 'hidden' in attrs, disabled: 'disabled' in attrs, checked: 'checked' in attrs,
            getAttribute(name) { return this.attributes[name] ?? null; },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(type, fn) { this[type] = fn; }
        };
    }
    const nodes = Object.fromEntries(ids.map(id => [id, node()]));
    const handlers = {};
    const html = fs.readFileSync(path.join(__dirname, '..', file.replace(/\.js$/, '.html')), 'utf8');
    const parsed = [], templates = [];
    let titleNode;
    function parse(fragment) {
        const elements = [];
        for (const match of fragment.matchAll(/<([a-z][\w-]*)\b([^>]*)>([^<]*)/gi)) {
            const attrs = Object.fromEntries([...match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
            const el = attrs.id && nodes[attrs.id] ? Object.assign(nodes[attrs.id], node(attrs, match[3].trim())) : node(attrs, match[3].trim());
            if (attrs.id) nodes[attrs.id] = el;
            if (match[1] === 'title') titleNode = el;
            if (match[1] === 'h1') nodes.heading = el;
            if (match[1] === 'p' && attrs.class === 'subtitle') nodes.subtitle = el;
            elements.push(el);
        }
        return elements;
    }
    const rootHtml = html.replace(/<template\b[^>]*>([\s\S]*?)<\/template>/g, (_, content) => {
        const elements = parse(content);
        templates.push({ content: { querySelectorAll: selector => select(elements, selector) } });
        return '';
    });
    function select(elements, selector) {
        const attribute = /^\[([^\]]+)\]$/.exec(selector)?.[1];
        return attribute ? elements.filter(el => el.getAttribute(attribute) !== null) : [];
    }
    parsed.push(...parse(rootHtml));
    const document = {
        documentElement: { lang: 'en', dir: 'ltr' },
        get title() { return titleNode?.textContent || ''; },
        getElementById: id => nodes[id],
        querySelector: selector => selector === 'header h1' ? nodes.heading : selector === 'header .subtitle' ? nodes.subtitle : null,
        querySelectorAll: selector => selector === 'template' ? templates : select(parsed, selector),
        addEventListener: (type, fn) => { handlers[type] = fn; }
    };
    const context = vm.createContext({ browser: api, document, location: new URL(url), URLSearchParams, console, navigator: { language: api.i18n.getUILanguage() } });
    // Load the page's actual script list, including shared localization.
    for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
        const script = path.posix.join(path.posix.dirname(file), match[1]);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), context, { filename: script });
    }
    return { nodes, document, context, parsed, templates, ready: () => handlers.DOMContentLoaded() };
}
module.exports = { fixture, event, deferred, flush, fakeClock, page, translations };
