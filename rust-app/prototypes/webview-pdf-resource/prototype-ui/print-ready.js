// R0-06 打印样例页的“就绪”信号。
//
// 同一份 HTML 会被两个后端加载：
//   - Tauri/WebView2：本脚本通过 `pdf_page_ready` 命令通知宿主（load 完成、字体与图片解码完成），
//     宿主收到后才调用 PrintToPdfStream；
//   - Electron：没有 window.__TAURI__，脚本只设置 __PDF_SAMPLE_READY__，
//     scripts/rust/probe-electron-pdf.js 用 executeJavaScript 等待同一个信号。
//
// 之所以把“就绪”写进页面而不是由宿主轮询，是因为样例里有内嵌 PNG 和中文系统字体：
// 打印必须发生在字体加载与图片解码之后，否则两个后端的产物差异会包含竞态噪声。
function notifyWhenReady() {
  const docId = document.documentElement.getAttribute('data-doc') || 'unknown'
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke
  const finish = async (payload) => {
    window.__PDF_SAMPLE_READY__ = { document: docId, readyState: document.readyState, ...payload }
    if (invoke) {
      try {
        await invoke('pdf_page_ready', { document: docId, ...(payload.error ? { error: payload.error } : {}) })
      } catch {}
    }
  }
  return (async () => {
    try {
      if (document.readyState !== 'complete') {
        await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }))
      }
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready
      }
      const images = Array.from(document.images || [])
      const decoded = await Promise.all(
        images.map((image) =>
          typeof image.decode === 'function'
            ? image.decode().then(() => ({ ok: true, width: image.naturalWidth, height: image.naturalHeight })).catch(() => null)
            : Promise.resolve(null)
        )
      )
      const imageFailures = decoded.filter((item) => item === null).length
      await finish({ imageCount: images.length, imageFailures })
    } catch (error) {
      await finish({ error: String((error && error.message) || error) })
    }
  })()
}

notifyWhenReady()
