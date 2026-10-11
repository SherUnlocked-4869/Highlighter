// S14 / D2-2（Wave 8.5）：`config/config.js` 按路由拆分。
// 路由 settings-*（界面/功能/热键/系统设置）。

function renderGeneralSettings() {
  view.innerHTML = `<div class="page">${pageHeader('界面设置', '控制主界面和截图界面的常用视觉行为。')}<div class="card form-card"><div class="form-row"><div class="form-label"><b>界面缩放</b><small>使用系统 DPI 与窗口缩放</small></div><span>自动</span></div><div class="form-row"><div class="form-label"><b>截图选区遮罩</b></div><input id="selectionMask" type="text" value="${escapeHtml(settings.screenshot.selectionMask)}"></div><div class="form-row"><div class="form-label"><b>双击复制截图</b></div>${switchMarkup(settings.screenshot.doubleClickCopy, 'doubleClickCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>显示取色器入口</b></div>${switchMarkup(settings.screenshot.showColorPicker, 'showColorPicker', 'screenshot')}</div></div><button class="button primary" id="saveGeneral" style="margin-top:16px">保存</button></div>`
  bindSwitches(); document.getElementById('saveGeneral').onclick = () => updateSettings({ screenshot: { selectionMask: document.getElementById('selectionMask').value.trim() } })
}

function renderFunctionSettings() {
  const supportedFrameRates = [5, 16, 24, 30, 60]
  const selectedFrameRate = supportedFrameRates.includes(Number(settings.record.frameRate)) ? Number(settings.record.frameRate) : 24
  const outputSettings = `<section class="section"><h2 class="section-title">截图与输出</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>复制后自动保存</b></div>${switchMarkup(settings.screenshot.autoSaveOnCopy, 'autoSaveOnCopy', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>一键快速保存</b></div>${switchMarkup(settings.screenshot.fastSave, 'fastSave', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>截图快门音</b><small>截图窗口打开时播放一次快门音，关闭后静音</small></div>${switchMarkup(settings.screenshot.shutterSound, 'shutterSound', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>截图带光标</b><small>导出图会在光标位置绘制光标（热点对齐）；关闭时与旧版逐像素一致</small></div>${switchMarkup(settings.screenshot.captureCursor === true, 'captureCursor', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>长截图默认方向</b></div><select id="longCaptureDirection"><option value="vertical">纵向</option><option value="horizontal">横向</option></select></div><div class="form-row"><div class="form-label"><b>保存目录</b></div><input id="saveDirectory" type="text" value="${escapeHtml(settings.screenshot.saveDirectory || '')}"><button class="button" id="chooseSaveDirectory">选择</button></div><div class="form-row"><div class="form-label"><b>文件命名模板</b><small>留空沿用 Highlighter_&lt;date&gt;_&lt;time&gt;.png 旧格式；可用变量 {app}、{date}、{time}、{datetime}。非法字符与 Windows 保留名会被替换，重名自动加序号而不覆盖</small></div><input id="nameTemplate" type="text" value="${escapeHtml(settings.screenshot.nameTemplate || '')}" placeholder="Highlighter_{date}_{time}"></div><div class="form-row"><div class="form-label"><b>序号跨截图保留</b><small>开启后序号在多次截图之间连续累加，关闭时每次从 1 开始</small></div>${switchMarkup(settings.screenshot.keepSerialAcrossCaptures, 'keepSerialAcrossCaptures', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>记录截图历史</b></div>${switchMarkup(settings.screenshot.historyEnabled, 'historyEnabled', 'screenshot')}</div><div class="form-row"><div class="form-label"><b>历史数量上限</b></div><input id="historyLimit" type="number" min="10" max="1000" value="${settings.screenshot.historyLimit}"></div></div></section>`
  const pinSettings = `<section class="section"><h2 class="section-title">固定到屏幕</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>新贴图默认进入点击穿透</b><small>新固定的贴图不拦截鼠标；可用“取消全部穿透”热键或托盘菜单退出</small></div>${switchMarkup(settings.pinned.clickThrough, 'clickThrough', 'pinned')}</div></div></section>`
  const ocrSettings = `<section class="section"><h2 class="section-title">文本识别</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>识别模型</b><small>本地 PaddleOCR v4，支持简体中文与英文</small></div><select id="ocrModel"><option value="ppocr-v4-ch">PaddleOCR v4 中英移动版</option></select></div><div class="form-row"><div class="form-label"><b>运行状态</b><small id="ocrStatusDetail">正在检查本地组件</small></div><span id="ocrStatus">检查中</span></div><div class="form-row"><div class="form-label"><b>文字方向检测</b><small>旋转文字较多时开启，普通截图关闭更快</small></div>${switchMarkup(settings.ocr.detectAngle, 'detectAngle', 'ocr')}</div><div class="form-row"><div class="form-label"><b>最低置信度</b><small>低于该分值的文本块不显示</small></div><input id="ocrMinConfidence" type="number" min="0" max="1" step="0.05" value="${settings.ocr.minConfidence}"></div><div class="form-row"><div class="form-label"><b>识别后操作</b></div><select id="ocrAfterAction"><option value="none">显示识别结果</option><option value="copy">复制全部文本</option><option value="copy-and-close">复制文本并关闭截图</option></select></div></div></section>`
  const aiSettings = `<section class="section"><h2 class="section-title">AI 与翻译</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>供应商与模型</b><small>在“设置 > 模型”中管理多个供应商，并为对话、翻译和划词功能分别指定模型</small></div><button class="button" id="openModelSettings">配置模型</button></div><div class="form-row"><div class="form-label"><b>最大 Token</b></div><input id="maxTokens" type="number" value="${settings.ai.maxTokens}"></div><div class="form-row"><div class="form-label"><b>Temperature</b></div><input id="temperature" type="number" min="0" max="2" step="0.1" value="${settings.ai.temperature}"></div><div class="form-row"><div class="form-label"><b>默认翻译目标语言</b></div><select id="targetLanguage"><option>中文</option><option>英文</option><option>日文</option><option>韩文</option><option>繁体中文</option></select></div></div></section>`
  const recordSettings = `<section class="section"><h2 class="section-title">视频录制</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>帧率</b><small>录制包含画面与所选音轨，保存为 MP4</small></div><select id="frameRate">${supportedFrameRates.map((value) => `<option value="${value}">${value} FPS</option>`).join('')}</select></div><div class="form-row"><div class="form-label"><b>系统声音</b><small>录制电脑正在播放的声音，默认开启；关闭后该音轨不写入 MP4</small></div>${switchMarkup(settings.record.audioSystem !== false, 'audioSystem', 'record')}</div><div class="form-row"><div class="form-label"><b>麦克风</b><small>录制麦克风输入，默认关闭（隐私优先）；音源不可用或中途断开时会在录制状态栏提示</small></div>${switchMarkup(settings.record.audioMicrophone === true, 'audioMicrophone', 'record')}</div><div class="form-row"><div class="form-label"><b>视频保存目录</b></div><input id="recordDirectory" type="text" value="${escapeHtml(settings.record.saveDirectory || '')}"><button class="button" id="chooseRecordDirectory">选择</button></div></div></section>`
  view.innerHTML = `<div class="page">${pageHeader('功能设置', '配置截图、OCR、固定到屏幕、AI、翻译、录屏与输出。')}${outputSettings}${pinSettings}${ocrSettings}${aiSettings}${recordSettings}<button class="button primary" id="saveFunctions">保存功能设置</button></div>`
  document.getElementById('ocrModel').value = settings.ocr.modelProfile
  document.getElementById('ocrAfterAction').value = settings.ocr.afterAction
  document.getElementById('longCaptureDirection').value = settings.screenshot.longCaptureDirection || 'vertical'
  window.electronAPI.getOcrStatus().then((status) => {
    const statusLabel = document.getElementById('ocrStatus')
    const statusDetail = document.getElementById('ocrStatusDetail')
    if (!statusLabel || !statusDetail) return
    statusLabel.textContent = status.available ? (status.ready ? '已就绪' : '可用') : '不可用'
    statusDetail.textContent = status.available ? '三个本地模型文件已安装' : `缺少：${status.missingFiles.join('、') || 'OCR 组件'}`
  }).catch(() => {
    const statusLabel = document.getElementById('ocrStatus')
    if (statusLabel) statusLabel.textContent = '检查失败'
  })
  document.getElementById('targetLanguage').value = settings.ai.targetLanguage
  document.getElementById('frameRate').value = String(selectedFrameRate)
  bindSwitches()
  document.getElementById('openModelSettings').onclick = () => navigate('models')
  document.getElementById('chooseSaveDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('saveDirectory').value = directory }
  document.getElementById('chooseRecordDirectory').onclick = async () => { const directory = await window.electronAPI.chooseDirectory(); if (directory) document.getElementById('recordDirectory').value = directory }
  document.getElementById('saveFunctions').onclick = () => updateSettings({ screenshot: { saveDirectory: document.getElementById('saveDirectory').value.trim(), nameTemplate: document.getElementById('nameTemplate').value.trim(), historyLimit: Number(document.getElementById('historyLimit').value), longCaptureDirection: document.getElementById('longCaptureDirection').value }, ocr: { modelProfile: document.getElementById('ocrModel').value, minConfidence: Math.max(0, Math.min(1, Number(document.getElementById('ocrMinConfidence').value))), afterAction: document.getElementById('ocrAfterAction').value }, ai: { maxTokens: Number(document.getElementById('maxTokens').value), temperature: Number(document.getElementById('temperature').value), targetLanguage: document.getElementById('targetLanguage').value }, record: { frameRate: Number(document.getElementById('frameRate').value), saveDirectory: document.getElementById('recordDirectory').value.trim() } })
}

function renderHotkeySettings() {
  const all = Object.values(functionGroups).flat()
  view.innerHTML = `<div class="page">${pageHeader('热键设置', '点击右侧按键框后录入组合键（输入法组合键等无效按键会被忽略）；右键可清除。红色警告表示快捷键冲突或不可用。')}<div class="function-list">${all.map(([name, label, icon]) => `<div class="function-row"><span class="icon">${iconMarkup(icon)}</span><span class="label">${label}</span>${shortcutButton(name, settings.shortcuts[name] || '')}</div>`).join('')}</div></div>`
  bindShortcutRecorders()
}

async function renderSystemSettings() {
  const dataRoot = await window.electronAPI.getDataRoot()
  if (currentRoute !== 'settings-system') return
  const historyDirectory = settings.screenshot.historyDirectory
  const commonSettings = `<section class="section"><h2 class="section-title">常用</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>开机自动启动</b></div>${switchMarkup(settings.system.autoStart, 'autoStart', 'system')}</div><div class="form-row"><div class="form-label"><b>启用系统托盘</b></div>${switchMarkup(settings.system.enableTray, 'enableTray', 'system')}</div><div class="form-row"><div class="form-label"><b>游戏模式</b><small>暂停全局快捷键、划词工具以及截图、搜索和录屏等唤出入口</small></div>${switchMarkup(settings.system.gameMode, 'gameMode', 'system')}</div><div class="form-row"><div class="form-label"><b>运行日志</b></div>${switchMarkup(settings.system.runLog, 'runLog', 'system')}</div></div></section>`
  const dataSettings = `<section class="section"><h2 class="section-title">软件数据</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>软件数据目录</b><small>存放应用配置、运行日志、缓存及默认截图历史；更改时迁移配置、日志和目录内的截图历史，缓存将重新创建</small></div><input id="dataRoot" type="text" readonly value="${escapeHtml(dataRoot.path)}"><button class="button" id="openDataRoot">打开</button><button class="button" id="changeDataRoot">更改</button></div><div class="form-row"><div class="form-label"><b>截图导出目录</b><small>${settings.screenshot.saveDirectory ? '当前使用自定义目录' : '未自定义时使用系统“图片”目录'}</small></div><button class="button" id="openSave">打开</button></div><div class="form-row"><div class="form-label"><b>截图历史存储目录</b><small>用于保存截图历史中的图片，不能为空</small></div><input id="historyDirectory" type="text" required value="${escapeHtml(historyDirectory)}"><button class="button" id="chooseHistoryDirectory">选择</button></div><div class="form-row"><div class="form-label"><b>清除截图历史</b><small>同时删除截图历史目录中的对应图片文件</small></div><button class="button danger" id="clearData">清除</button></div></div></section>`
  const diagnosticsSettings = `<section class="section"><h2 class="section-title">本地诊断</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>预览诊断信息</b><small>仅展示版本、系统、显示器、组件、退出记录和日志文件摘要；不会上传任何数据</small></div><button class="button" id="previewDiagnostics">预览</button></div><div class="form-row"><div class="form-label"><b>导出诊断包</b><small>默认排除配置、凭据、AI/划词内容、截图、OCR、历史和录屏文件</small></div><button class="button primary" id="exportDiagnostics">导出 ZIP</button></div><div class="form-row"><div class="form-label"><b>包含崩溃转储</b><small>转储可能含进程内存片段，仅在明确需要排查崩溃时勾选</small></div><input id="includeCrashDumps" type="checkbox"></div><pre id="diagnosticsPreview" class="diagnostics-preview" hidden></pre></div></section>`
  view.innerHTML = `<div class="page">${pageHeader('系统设置', '控制自启动、托盘、日志、诊断和数据存储位置。')}${commonSettings}${dataSettings}${diagnosticsSettings}<button class="button danger" id="resetSettings">恢复默认设置</button></div>`
  bindSwitches()
  document.getElementById('previewDiagnostics').onclick = async () => {
    const button = document.getElementById('previewDiagnostics')
    button.disabled = true
    button.textContent = '读取中'
    try {
      const diagnostics = await window.electronAPI.previewDiagnostics()
      const preview = document.getElementById('diagnosticsPreview')
      if (!preview) return
      preview.textContent = JSON.stringify(diagnostics, null, 2)
      preview.hidden = false
    } catch (error) {
      toast(error.message || '无法生成诊断预览')
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = '预览'
      }
    }
  }
  document.getElementById('exportDiagnostics').onclick = async () => {
    const includeCrashDumps = document.getElementById('includeCrashDumps').checked
    if (includeCrashDumps && !confirm('崩溃转储可能包含进程内存片段。确认将本机转储加入诊断包？')) return
    const button = document.getElementById('exportDiagnostics')
    button.disabled = true
    button.textContent = '导出中'
    try {
      const result = await window.electronAPI.exportDiagnostics(includeCrashDumps)
      if (!result.canceled) toast(`诊断包已导出：${result.outputPath}`)
    } catch (error) {
      toast(error.message || '诊断包导出失败')
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = '导出 ZIP'
      }
    }
  }
  document.getElementById('openDataRoot').onclick = () => window.electronAPI.openDataRoot().catch((error) => toast(error.message || '无法打开软件数据目录'))
  document.getElementById('changeDataRoot').onclick = async () => {
    const button = document.getElementById('changeDataRoot')
    button.disabled = true
    button.textContent = '更改中'
    let restarting = false
    try {
      const result = await window.electronAPI.changeDataRoot()
      if (result?.restarting) {
        restarting = true
        toast('数据目录迁移完成，正在重启')
      }
    } catch (error) {
      toast(error.message || '数据目录迁移失败')
    } finally {
      if (!restarting) {
        button.disabled = false
        button.textContent = '更改'
      }
    }
  }
  document.getElementById('openSave').onclick = () => window.electronAPI.openSaveDirectory()
  const historyDirectoryInput = document.getElementById('historyDirectory')
  const saveHistoryDirectory = () => {
    const directory = historyDirectoryInput.value.trim()
    if (!directory) {
      historyDirectoryInput.value = settings.screenshot.historyDirectory
      toast('截图历史存储目录不能为空')
      return null
    }
    return updateSettings({ screenshot: { historyDirectory: directory } }, '截图历史存储目录已更新')
  }
  historyDirectoryInput.onchange = saveHistoryDirectory
  historyDirectoryInput.onkeydown = (event) => { if (event.key === 'Enter') historyDirectoryInput.blur() }
  document.getElementById('chooseHistoryDirectory').onclick = async () => {
    const directory = await window.electronAPI.chooseDirectory()
    if (!directory) return
    historyDirectoryInput.value = directory
    await saveHistoryDirectory()
  }
  document.getElementById('clearData').onclick = async () => {
    if (!confirm('确定清空截图历史并删除对应图片文件？')) return
    try { await window.electronAPI.clearHistory(); toast('截图历史和图片文件已清空') }
    catch (error) { toast(error.message || '部分图片文件删除失败') }
  }
  document.getElementById('resetSettings').onclick = async () => { if (confirm('确定恢复默认设置？')) { settings = await window.electronAPI.resetSettings(); await refreshShortcutStatuses(); applyAppearance(); renderRoute(); toast('已恢复默认设置') } }
}

// D2-2（S14）：登记到主壳 renderRoute() 的分派表（config.html 里本文件先于 config.js 加载）。
// 包一层箭头函数：登记语句本身不解析被指的标识符，调用时才解析（与拆分前调用形态一致）。
window.configRoutes = window.configRoutes || {}
window.configRoutes['renderGeneralSettings'] = () => renderGeneralSettings()
window.configRoutes['renderFunctionSettings'] = () => renderFunctionSettings()
window.configRoutes['renderHotkeySettings'] = () => renderHotkeySettings()
window.configRoutes['renderSystemSettings'] = () => renderSystemSettings()
