# Bulk Attachment Deleter for Thunderbird

Delete attachments from selected messages in Thunderbird 128 or later.

## Usage

1. Select messages and choose **Delete attachments from selection…** from the message-list context menu.
2. For more than 100 messages, accept the initial confirmation. Scanning displays its own progress and Cancel button.
3. Review the attachment list and the backup mode, then choose Delete.
4. The result window stays open with saved/deleted/failed/unprocessed counts, errors, and actual backup paths.

Backups are enabled by default. Only attachments whose backup completed and whose saved file exists are eligible for deletion. Failed items are left in the message and reported once; subsequent items continue. All attachments of a message are backed up before that message is modified.

Cancel or close the progress window to stop new work. A deletion request already submitted to Thunderbird must finish; completed changes are retained. A second operation cannot start until the first has finished. A missing or unresponsive progress window prevents further deletion.

## Settings

- **Backup subfolder** is relative to Thunderbird's configured download directory. The default is `BulkAttachmentBackup`. The result window shows the actual paths; the base directory is not assumed to be the operating system's Downloads folder.
- **Save location** defaults to following Thunderbird's settings. You can instead ask for every file or save automatically. Cancelling an individual Save As dialog leaves that attachment in the message.
- **Back up attachments before deleting** can be disabled explicitly. The deletion confirmation then states that no backup will be made. Settings are captured before confirmation and remain unchanged for that operation.
- Optional delays between files and messages are in milliseconds (0–60000). Both default to zero and can be interrupted by Cancel.
- **Reset to defaults** restores all settings, including enabling backups.

Backup names preserve normal extensions and include a short identifier. Unicode names are shortened on code-point boundaries; the combined filename and relative path have byte limits. An inaccessible destination or other filesystem failure is reported without deleting the affected attachment.

## Development and verification

### Localization

The interface follows Thunderbird's language. Translations are provided for English (`en`), Japanese (`ja`), Simplified Chinese (`zh_CN`), and Traditional Chinese (`zh_TW`). Unsupported languages and missing messages fall back to English through Thunderbird's WebExtension i18n API.

All interface strings are in `_locales/<locale>/messages.json`, including add-on metadata, context menus, notifications, dialogs, settings, and add-on-generated errors. `shared/i18n.js` provides safe text/attribute rendering and locale-aware number, size, and date formatting. Messages use named placeholders so translators can change word order. User content, backup paths, and diagnostic details returned by Thunderbird are preserved verbatim.

To add a language, copy `_locales/en/messages.json` into a supported locale directory, translate the messages, set its `locale` (BCP 47 tag) and `direction` (`ltr`/`rtl`), and retain the message keys and placeholder definitions. HTML uses `data-i18n` and `data-i18n-aria-label`; its English text is the initial fallback. The localization tests check key/placeholder parity and referenced message keys.

### Tests

No dependencies are needed. With Node.js 20 or later, run:

```sh
npm test
```

The tests use simulated Thunderbird APIs and page event handlers. They cover early dialog responses, timeouts and cleanup, 101 selected messages, download races, bounded retries, failures, cancellation, concurrent runs, filenames, and settings. They do not substitute for live Thunderbird integration testing.

For live validation, load `manifest.json` as a temporary add-on in Thunderbird's add-on debugging tools. Use a test folder with disposable copies of messages and verify:

- One message, multiple messages, and 101 messages; include messages without attachments and previously deleted attachments.
- Automatic saving and Thunderbird's ask-every-time setting; inspect the actual saved files and result paths.
- Cancel during scanning, saving, and between messages; close each dialog with its window close button.
- A denied/unavailable backup destination, long Japanese filenames, and a message that Thunderbird refuses to modify.
- Reset settings, enable/disable backup, and start another operation after completion or cancellation.
- Switch Thunderbird between Japanese, English, Simplified Chinese, Traditional Chinese, and an unsupported language. Check page titles, table headers, context menus, notifications, and error messages. Confirm that the unsupported language falls back to English.

The runtime entry points are the scripts listed in `manifest.json`. The obsolete monolithic background implementation has been removed.
