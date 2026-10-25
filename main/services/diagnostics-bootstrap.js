'use strict'

// Pure helpers the diagnostics service is assembled from. They used to sit in
// main.js; nothing here touches Electron at module scope, so the whole set is
// unit-testable and main.js keeps only the assembly (the DiagnosticsService
// constructor call, which stays beside the app/window handles it reads).
//
// Everything that identifies the running installation is injected rather than
// imported, because main.js is the only place that knows it: the portable data
// root, the resolved ffmpeg path and the app/packaging state.

// Sensitive-value harvest for the diagnostics bundle: the top-level apiKey plus
// every nested string whose key path looks like a credential or prompt. The
// settings service is only consulted once the store exists, so a very early
// caller gets an empty list instead of a crash.
function createSensitiveValueCollector({ getStore, getSettings }) {
  return function collectDiagnosticSensitiveValues() {
    if (!getStore()) return []
    const settings = getSettings()
    const values = [settings.apiKey]
    function visit(value, keyPath = '') {
      if (typeof value === 'string') {
        if (/(api[-_]?key|authorization|password|secret|token|prompt)/i.test(keyPath)) values.push(value)
        return
      }
      if (!value || typeof value !== 'object') return
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        visit(nestedValue, keyPath ? `${keyPath}.${nestedKey}` : nestedKey)
      }
    }
    visit(settings)
    return values.filter(Boolean)
  }
}

// 'development' | 'portable' | 'unpacked' | 'nsis'. The win-unpacked probe keeps
// its meaning: an electron-builder unpacked tree reports as unpacked, a real
// installer as nsis.
function createInstallTypeResolver({ app, path, isPortable, execPath = process.execPath }) {
  return function getInstallType() {
    if (!app.isPackaged) return 'development'
    if (isPortable()) return 'portable'
    if (path.basename(path.dirname(execPath)).toLowerCase() === 'win-unpacked') return 'unpacked'
    return 'nsis'
  }
}

// Component inventory of the bundle: the two native sidecars plus FFmpeg. Each
// path probe is best-effort, so a missing ffmpeg-static still yields an entry
// (with an empty version) rather than failing the whole bundle.
function createComponentLister({ app, path, getResourceRoot, resolveFfmpegPath, requireFfmpegVersion = () => require('ffmpeg-static/package.json').version }) {
  return function getDiagnosticComponents() {
    const resourceRoot = getResourceRoot()
    let ffmpegPath = ''
    let ffmpegVersion = ''
    try { ffmpegPath = resolveFfmpegPath() } catch {}
    try { ffmpegVersion = requireFfmpegVersion() } catch {}
    const version = app.getVersion()
    return [
      { name: 'SmartSelect', path: path.join(resourceRoot, 'native', 'smart-select', 'SmartSelect.exe'), version },
      { name: 'OCR sidecar', path: path.join(resourceRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe'), version },
      { name: 'FFmpeg', path: ffmpegPath, version: ffmpegVersion }
    ]
  }
}

module.exports = {
  createComponentLister,
  createInstallTypeResolver,
  createSensitiveValueCollector
}
