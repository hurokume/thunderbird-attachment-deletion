'use strict';
// 共有名前空間
const BD = globalThis.BD || {};
BD.api = (typeof messenger !== 'undefined') ? messenger : browser;

// 定数
BD.const = {
    MENU_ID: 'bulk-del',
    MAX_DOWNLOAD_RETRIES: 3,
    RETRY_BACKOFF_MS: 400
};

// ランタイム状態（重複バインド防止など）
BD.state = { bound: false, running: false };

globalThis.BD = BD;
