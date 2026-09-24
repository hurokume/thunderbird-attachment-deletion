(() => {
    'use strict';
    const api = typeof messenger !== 'undefined' ? messenger : browser;
    const $ = id => document.getElementById(id);
    const { t, apply, details } = globalThis.BDI18n;
    const show = (id, value) => { $(id).textContent = value || ''; $(id).hidden = !value; };
    function preview() {
        $('preview').textContent = t('settingsPreview', $('dir').value);
        show('backup-warning', $('backup').checked ? '' : t('settingsBackupWarning'));
    }
    function render(value) {
        $('dir').value = value.saveRoot;
        $('backup').checked = value.backupEnabled;
        $('mode').value = value.saveMode;
        $('fileDelay').value = value.perFileDelayMs;
        $('messageDelay').value = value.cooldownAfterEachMessageMs;
        preview();
    }
    async function request(type, value) {
        $('save').disabled = $('reset').disabled = true;
        show('err', ''); show('msg', '');
        try {
            const result = await api.runtime.sendMessage({ type, value });
            if (!result?.ok) throw new Error(t(type === 'get-settings' ? 'settingsLoadFailed' : 'settingsSaveFailed'));
            render(result.value);
            if (type !== 'get-settings') show('msg', t('saved'));
        } catch (e) {
            show('err', details(t(type === 'get-settings' ? 'settingsLoadFailed' : 'settingsSaveFailed'), e));
        } finally {
            $('save').disabled = $('reset').disabled = false;
        }
    }
    document.addEventListener('DOMContentLoaded', () => {
        apply();
        $('dir').addEventListener('input', preview);
        $('backup').addEventListener('change', preview);
        $('save').addEventListener('click', () => request('set-settings', {
            saveRoot: $('dir').value, backupEnabled: $('backup').checked, saveMode: $('mode').value,
            perFileDelayMs: $('fileDelay').value, cooldownAfterEachMessageMs: $('messageDelay').value
        }));
        $('reset').addEventListener('click', () => request('reset-settings'));
        request('get-settings');
    });
})();
