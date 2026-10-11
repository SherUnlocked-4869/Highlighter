'use strict'

// Domain locale table: main-process, user-visible copy (S13 / P0-1-T6).
//
// Layout decision (2026-10-11, Lead; plan §10.3): one file per domain, each file
// registering all three languages for that domain, so wave-9 streams never share
// a write target. This file owns `main.*` alone.
//
// Scope (plan §10.4-T6 + decision D6 / §10.5-2):
//   * tray menu labels
//   * update-service status/error copy that the settings window renders
//   * Everything sidecar status copy that the local-search window renders
//   * AI connection-error copy returned to the settings window
//   * the image-picker filter display name
// Deliberately NOT translated here:
//   * `throw new Error('中文…')` inside main/** — D6 defers those to a later
//     release (test/*.test.js asserts on ~430 lines of that text);
//   * log and diagnostic strings — plan §10.5-5 keeps those in English/verbatim.
//
// Checker contract (scripts/check-i18n.js): every file in shared/locales/ is
// loaded, every language must be registered here, and every key must match
// /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/ — camelCase segments must use a hyphen
// instead, hence `main.tray.screenshot-full-screen` and `main.ai.api-key`.
//
// Loaded by main/services/i18n-bootstrap.js for the CommonJS main process and by
// `<script src="../shared/locales/main.js">` in a window that needs these keys.
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    // --- tray menu (main/services/tray-menu.js) ---
    'main.tray.screenshot': '截图',
    'main.tray.screenshot-full-screen': '截取全屏',
    'main.tray.screenshot-focused-window': '截取焦点窗口',
    'main.tray.pin-image': '固定图片到屏幕',
    'main.tray.video-record': '视频录制',
    'main.tray.local-search': '本地搜索',
    'main.tray.game-mode': '游戏模式',
    'main.tray.exit-all-click-through': '取消全部穿透',
    'main.tray.show-selection-chat': '显示划词对话',
    'main.tray.capture-history': '截图历史',
    'main.tray.show-main-window': '显示主界面',
    'main.tray.quit': '退出',

    // --- update service (main/services/update-service.js) ---
    'main.update.signature-invalid.message': '更新包签名或完整性校验失败。',
    'main.update.signature-invalid.action': '请从项目发布页下载安装包，并确认发布者为 Highlighter。',
    'main.update.disk-full.message': '磁盘空间不足，无法保存更新包。',
    'main.update.disk-full.action': '请释放系统盘空间后重试。',
    'main.update.metadata-invalid.message': '更新服务返回了无效的版本信息。',
    'main.update.metadata-invalid.action': '当前版本不会被修改，请稍后重试或从项目发布页确认版本状态。',
    'main.update.network.message': '无法连接更新服务。',
    'main.update.network.action': '请检查网络连接后重试，或从项目发布页手动下载。',
    'main.update.timeout.message': '检查或下载更新超时。',
    'main.update.download-failed.message': '更新包下载失败。',
    'main.update.download-failed.action': '请重新下载；若问题持续，请从项目发布页手动下载。',
    'main.update.failed.message': '更新操作失败。',
    'main.update.failed.action': '请稍后重试；若问题持续，请从项目发布页手动下载。',
    'main.update.unsupported.message': '当前运行方式不支持应用内更新。',
    'main.update.unsupported.action': '请安装正式安装版，或从项目发布页手动下载。',
    'main.update.cancelled': '下载已取消。',
    'main.update.install-blocked': '当前有任务正在运行，请结束后重试。',

    // --- Everything sidecar status (main/services/everything-service.js) ---
    'main.everything.ready': 'Everything 已就绪',
    'main.everything.index-pending': 'Everything 正在运行，索引尚未就绪',
    'main.everything.checking': '正在检测 Everything...',
    'main.everything.rechecking': '正在重新检测 Everything...',
    'main.everything.unavailable': 'Everything 组件不可用',
    'main.everything.ipc-mismatch': '检测到 Everything，但无法与之通信（可能正在加载索引或权限不一致），请尝试以相同权限运行 Highlighter 与 Everything',
    'main.everything.waiting': '检测到 Everything 正在运行，正在等待索引服务就绪...',
    'main.everything.starting': '未检测到 Everything，正在启动内置 Everything...',
    'main.everything.not-installed': '未检测到 Everything，请安装并启动 Everything 后重试',
    'main.everything.timeout-index': 'Everything 初始化超时，索引尚未就绪',
    'main.everything.timeout-start': 'Everything 初始化超时，请确认 Everything 可正常启动（NTFS 索引需要管理员权限或 Everything 服务）',

    // --- AI connection errors (main/services/ai/client.js) ---
    'main.ai.model-missing': '连接失败：模型不存在或不可用（HTTP {status}），请检查模型目录',
    'main.ai.unauthorized': '连接失败：API 密钥无效或没有访问权限（HTTP {status}）',
    'main.ai.endpoint-missing': '连接失败：接口地址不存在（HTTP 404/405）。请检查 API 地址是否以 /v1 结尾，以及 API 协议是否与供应商兼容',
    'main.ai.bad-request': '连接失败：请求被供应商拒绝（HTTP 400）',
    'main.ai.http-status': '连接失败：供应商返回 HTTP {status}',
    'main.ai.network': '连接失败：{detail}',
    'main.ai.fallback': '网络请求失败，请检查 API 地址',

    // --- dialogs (main/services/function-router.js) ---
    'main.dialog.image-filter': '图片'
  })

  add('en-US', {
    // --- tray menu ---
    'main.tray.screenshot': 'Screenshot',
    'main.tray.screenshot-full-screen': 'Capture Full Screen',
    'main.tray.screenshot-focused-window': 'Capture Focused Window',
    'main.tray.pin-image': 'Pin Image to Screen',
    'main.tray.video-record': 'Record Video',
    'main.tray.local-search': 'Local Search',
    'main.tray.game-mode': 'Game Mode',
    'main.tray.exit-all-click-through': 'Exit All Click-Through',
    'main.tray.show-selection-chat': 'Show Selection Chat',
    'main.tray.capture-history': 'Capture History',
    'main.tray.show-main-window': 'Show Main Window',
    'main.tray.quit': 'Quit',

    // --- update service ---
    'main.update.signature-invalid.message': 'The update package failed its signature or integrity check.',
    'main.update.signature-invalid.action': 'Download the installer from the project releases page and confirm the publisher is Highlighter.',
    'main.update.disk-full.message': 'Not enough disk space to save the update package.',
    'main.update.disk-full.action': 'Free up space on the system drive and try again.',
    'main.update.metadata-invalid.message': 'The update service returned invalid version information.',
    'main.update.metadata-invalid.action': 'Your current version is untouched. Try again later, or confirm the release status on the project releases page.',
    'main.update.network.message': 'Cannot reach the update service.',
    'main.update.network.action': 'Check your network connection and try again, or download manually from the project releases page.',
    'main.update.timeout.message': 'Checking for or downloading the update timed out.',
    'main.update.download-failed.message': 'The update package failed to download.',
    'main.update.download-failed.action': 'Try downloading again; if the problem persists, download manually from the project releases page.',
    'main.update.failed.message': 'The update operation failed.',
    'main.update.failed.action': 'Try again later; if the problem persists, download manually from the project releases page.',
    'main.update.unsupported.message': 'This way of running the app does not support in-app updates.',
    'main.update.unsupported.action': 'Install the regular installer version, or download manually from the project releases page.',
    'main.update.cancelled': 'Download cancelled.',
    'main.update.install-blocked': 'A task is currently running. Try again once it finishes.',

    // --- Everything sidecar status ---
    'main.everything.ready': 'Everything is ready',
    'main.everything.index-pending': 'Everything is running but its index is not ready yet',
    'main.everything.checking': 'Checking Everything...',
    'main.everything.rechecking': 'Re-checking Everything...',
    'main.everything.unavailable': 'The Everything component is unavailable',
    'main.everything.ipc-mismatch': 'Everything was detected but cannot be reached (its index may still be loading, or the privilege level differs). Try running Highlighter and Everything with the same privilege level',
    'main.everything.waiting': 'Everything is running; waiting for its index service to become ready...',
    'main.everything.starting': 'Everything was not detected; starting the bundled Everything...',
    'main.everything.not-installed': 'Everything was not detected. Install and start Everything, then try again',
    'main.everything.timeout-index': 'Everything initialization timed out; the index is not ready yet',
    'main.everything.timeout-start': 'Everything initialization timed out. Make sure Everything can start normally (NTFS indexing needs administrator rights or the Everything service)',

    // --- AI connection errors ---
    'main.ai.model-missing': 'Connection failed: the model is missing or unavailable (HTTP {status}). Check the model catalog',
    'main.ai.unauthorized': 'Connection failed: the API key is invalid or lacks access (HTTP {status})',
    'main.ai.endpoint-missing': 'Connection failed: the endpoint does not exist (HTTP 404/405). Check that the API address ends with /v1 and that the API protocol matches the provider',
    'main.ai.bad-request': 'Connection failed: the provider rejected the request (HTTP 400)',
    'main.ai.http-status': 'Connection failed: the provider returned HTTP {status}',
    'main.ai.network': 'Connection failed: {detail}',
    'main.ai.fallback': 'the network request failed. Check the API address',

    // --- dialogs ---
    'main.dialog.image-filter': 'Images'
  })

  add('zh-TW', {
    // --- tray menu ---
    'main.tray.screenshot': '截圖',
    'main.tray.screenshot-full-screen': '截取全螢幕',
    'main.tray.screenshot-focused-window': '截取焦點視窗',
    'main.tray.pin-image': '將圖片釘選到螢幕',
    'main.tray.video-record': '螢幕錄影',
    'main.tray.local-search': '本機搜尋',
    'main.tray.game-mode': '遊戲模式',
    'main.tray.exit-all-click-through': '取消全部穿透',
    'main.tray.show-selection-chat': '顯示劃詞對話',
    'main.tray.capture-history': '截圖歷史',
    'main.tray.show-main-window': '顯示主介面',
    'main.tray.quit': '結束',

    // --- update service ---
    'main.update.signature-invalid.message': '更新套件簽章或完整性驗證失敗。',
    'main.update.signature-invalid.action': '請從專案發佈頁下載安裝檔，並確認發佈者為 Highlighter。',
    'main.update.disk-full.message': '磁碟空間不足，無法儲存更新套件。',
    'main.update.disk-full.action': '請釋放系統碟空間後重試。',
    'main.update.metadata-invalid.message': '更新服務傳回了無效的版本資訊。',
    'main.update.metadata-invalid.action': '目前版本不會被修改，請稍後重試或從專案發佈頁確認版本狀態。',
    'main.update.network.message': '無法連線更新服務。',
    'main.update.network.action': '請檢查網路連線後重試，或從專案發佈頁手動下載。',
    'main.update.timeout.message': '檢查或下載更新逾時。',
    'main.update.download-failed.message': '更新套件下載失敗。',
    'main.update.download-failed.action': '請重新下載；若問題持續，請從專案發佈頁手動下載。',
    'main.update.failed.message': '更新操作失敗。',
    'main.update.failed.action': '請稍後重試；若問題持續，請從專案發佈頁手動下載。',
    'main.update.unsupported.message': '目前執行方式不支援應用程式內更新。',
    'main.update.unsupported.action': '請安裝正式安裝版，或從專案發佈頁手動下載。',
    'main.update.cancelled': '下載已取消。',
    'main.update.install-blocked': '目前有工作正在執行，請結束後重試。',

    // --- Everything sidecar status ---
    'main.everything.ready': 'Everything 已就緒',
    'main.everything.index-pending': 'Everything 正在執行，索引尚未就緒',
    'main.everything.checking': '正在偵測 Everything...',
    'main.everything.rechecking': '正在重新偵測 Everything...',
    'main.everything.unavailable': 'Everything 元件無法使用',
    'main.everything.ipc-mismatch': '偵測到 Everything，但無法與之通訊（可能正在載入索引或權限不一致），請嘗試以相同權限執行 Highlighter 與 Everything',
    'main.everything.waiting': '偵測到 Everything 正在執行，正在等待索引服務就緒...',
    'main.everything.starting': '未偵測到 Everything，正在啟動內建 Everything...',
    'main.everything.not-installed': '未偵測到 Everything，請安裝並啟動 Everything 後重試',
    'main.everything.timeout-index': 'Everything 初始化逾時，索引尚未就緒',
    'main.everything.timeout-start': 'Everything 初始化逾時，請確認 Everything 可正常啟動（NTFS 索引需要管理員權限或 Everything 服務）',

    // --- AI connection errors ---
    'main.ai.model-missing': '連線失敗：模型不存在或無法使用（HTTP {status}），請檢查模型目錄',
    'main.ai.unauthorized': '連線失敗：API 金鑰無效或沒有存取權限（HTTP {status}）',
    'main.ai.endpoint-missing': '連線失敗：介面位址不存在（HTTP 404/405）。請檢查 API 位址是否以 /v1 結尾，以及 API 協定是否與供應商相容',
    'main.ai.bad-request': '連線失敗：請求被供應商拒絕（HTTP 400）',
    'main.ai.http-status': '連線失敗：供應商傳回 HTTP {status}',
    'main.ai.network': '連線失敗：{detail}',
    'main.ai.fallback': '網路請求失敗，請檢查 API 位址',

    // --- dialogs ---
    'main.dialog.image-filter': '圖片'
  })
})()
