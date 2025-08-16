// ui/preflight.js
(() => {
    'use strict';
    const api = (typeof messenger !== 'undefined') ? messenger : browser;

    function qs(id) { return document.getElementById(id); }

    document.addEventListener('DOMContentLoaded', () => {
        const params = new URLSearchParams(location.search);
        const key = params.get('key') || '';
        const count = Number(params.get('count') || 0);
        qs('count').textContent = String(count);

        function disable() { qs('ok').disabled = true; qs('cancel').disabled = true; }

        qs('ok').addEventListener('click', () => {
            disable();
            api.runtime.sendMessage({ type: 'preflight-result', key, ok: true }).catch(() => { });
        });
        qs('cancel').addEventListener('click', () => {
            disable();
            api.runtime.sendMessage({ type: 'preflight-result', key, ok: false }).catch(() => { });
        });
    });
})();
