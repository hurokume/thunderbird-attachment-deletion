'use strict';
// 共有名前空間
const BD = globalThis.BD || {};
BD.api = (typeof messenger !== 'undefined') ? messenger : browser;

// 定数
BD.const = {
    MENU_ID: 'bulk-del',
    SAVE_ROOT: 'addonname',          // 既定DLフォルダ配下のサブフォルダ
    MAX_DOWNLOAD_RETRIES: 3,
    RETRY_BACKOFF_MS: 400,
    STRICT_BACKUP: true              // ★ すべてのバックアップ成功が確認できない限り削除しない
};

// ランタイム状態（重複バインド防止など）
BD.state = { bound: false };

globalThis.BD = BD;
