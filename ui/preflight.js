(() => {
    'use strict';
    const api = typeof messenger !== 'undefined' ? messenger : browser;
    const { t, number, apply, details } = globalThis.BDI18n;
    document.addEventListener('DOMContentLoaded', () => {
        apply();
        const key = new URLSearchParams(location.search).get('key');
        document.getElementById('count').textContent = t('selectedMessages', number(new URLSearchParams(location.search).get('count') || 0));
        const ok = document.getElementById('ok'), cancel = document.getElementById('cancel');
        const error = document.getElementById('error');
        let sending = false;
        async function submit(value) {
            if (sending) return;
            sending = true;
            ok.disabled = cancel.disabled = true;
            try {
                const response = await api.runtime.sendMessage({ type: 'preflight-result', key, ok: value });
                if (!response?.ack) throw new Error(t('operationInactive'));
                // The background closes the window after accepting the result.
            } catch (e) {
                error.textContent = details(t('communicationFailed'), e);
                error.hidden = false;
                sending = false;
                ok.disabled = cancel.disabled = false;
            }
        }
        ok.addEventListener('click', () => submit(true));
        cancel.addEventListener('click', () => submit(false));
    });
})();
