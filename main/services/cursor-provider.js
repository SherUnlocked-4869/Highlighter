'use strict'

// P0-2-T2 光标采集的主进程封装。
//
// 职责边界：
//   * 传输：按需拉起 native/smart-select/SmartSelect.exe，走它既有的 line-JSON 协议
//     发 `cursor <id>`，把响应解析成 snapshot（解析本身是 shared/cursor-geometry.js
//     里的纯函数 parseHelperMessage）。
//   * 缓存：光标**形状**（位图 + 热点）几乎不变，默认 250ms 内复用上一次快照，
//     避免高频轮询把 pipe 打满。位置与形状同一个响应回来，所以缓存命中时的位置
//     也最多旧 250ms；需要"此刻精确位置"的调用方（截图链路）传 `{ fresh: true }`
//     绕过缓存 —— 接线说明里给出的就是 fresh:true。
//   * 降级：helper 不存在 / 拉不起来 / 启动超时 / 查询超时 / 中间退出，一律
//     返回 null（= 不画光标），绝不抛错。CURSOR_SHOWING=0 同样返回 null。
//
// 不修改 main/domains/capture/smart-select.js：那是 S4/S9a 的作用域，本模块自带
// 一个薄会话（只发 cursor 命令，不碰 `id x y` 命中测试），两者各起各的进程。
//
// Electron 依赖全部可注入（spawn / app / rootDirectory / existsSync / now / log），
// 因此本模块在纯 node 下可加载、可单测（同 main/services/pdf-export.js 的约定）。

const fs = require('fs')
const path = require('path')

const { parseHelperMessage, toCursorDataUrl } = require('../../shared/cursor-geometry')

const ROOT_DIRECTORY = path.resolve(__dirname, '..', '..')
const HELPER_RELATIVE_PATH = path.join('native', 'smart-select', 'SmartSelect.exe')
// 与 main/domains/capture/smart-select.js 的 350ms 同口径。
const DEFAULT_QUERY_TIMEOUT_MS = 350
const DEFAULT_READY_TIMEOUT_MS = 1000
const DEFAULT_CACHE_TTL_MS = 250

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

// 与 main/domains/capture/index.js:80-86 同口径：打包后 helper 在
// `process.resourcesPath/native/smart-select/`，开发态在仓库根目录下。
function resolveCursorHelperPath(options = {}) {
  if (typeof options.executablePath === 'string' && options.executablePath) return options.executablePath
  const rootDirectory = typeof options.rootDirectory === 'string' && options.rootDirectory
    ? options.rootDirectory
    : ROOT_DIRECTORY
  const packaged = !!(options.app && options.app.isPackaged === true) && !!process.resourcesPath
  return packaged
    ? path.join(process.resourcesPath, HELPER_RELATIVE_PATH)
    : path.join(rootDirectory, HELPER_RELATIVE_PATH)
}

// helper 的 cursor 响应 → 供渲染层消费的快照。showing !== true（含 CURSOR_SHOWING=0）
// 一律返回 null，调用方据此不画。
function createCursorSnapshot(message, at) {
  if (!message || message.kind !== 'cursor' || message.showing !== true) return null
  return {
    showing: true,
    png: message.png,
    dataUrl: toCursorDataUrl(message.png),
    width: message.width,
    height: message.height,
    hotspot: { x: message.hotspot.x, y: message.hotspot.y },
    physicalPoint: { x: message.physicalPoint.x, y: message.physicalPoint.y },
    at: Number.isFinite(at) ? at : 0,
    cached: false
  }
}

function createCursorProvider(options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : null
  const log = typeof options.log === 'function' ? options.log : () => {}
  const existsSync = typeof options.existsSync === 'function' ? options.existsSync : fs.existsSync
  const now = typeof options.now === 'function' ? options.now : Date.now
  const executablePath = typeof options.executablePath === 'string' && options.executablePath
    ? options.executablePath
    : resolveCursorHelperPath(options)
  const queryTimeoutMs = positiveNumber(options.queryTimeoutMs, DEFAULT_QUERY_TIMEOUT_MS)
  const readyTimeoutMs = positiveNumber(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS)
  const cacheTtlMs = positiveNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS)

  let child = null
  let buffer = ''
  let ready = false
  let available = true
  let disposed = false
  let readySettled = true
  let resolveReady = null
  let readyPromise = null
  let nextRequestId = 1
  let shapeCache = null
  let expectedExit = false
  const pending = new Map()

  function settleReady(ok) {
    if (readySettled) return
    readySettled = true
    if (resolveReady) resolveReady(ok)
  }

  function clearPending() {
    const requests = [...pending.values()]
    pending.clear()
    for (const request of requests) {
      clearTimeout(request.timer)
      request.resolve(null)
    }
  }

  // 内部原因（启动失败 / helper 缺失 / 写管道失败）：标记**永久**不可用并收掉子进程。
  // 先置 available=false，子进程随后的 exit 事件会被 handleExit 的守卫吞掉。
  // 注意：查询超时**不走这里** —— 那次只是这一张没光标，不该让整会话失去能力（见 recycleChild）。
  function markUnavailable(reason) {
    if (!available) return
    available = false
    log('Cursor helper unavailable:', reason)
    const process2 = child
    child = null
    ready = false
    shapeCache = null
    settleReady(false)
    clearPending()
    if (process2) {
      try { process2.stdin.end('quit\n') } catch {}
      try { process2.kill() } catch {}
    }
  }

  // 主动回收子进程但**保留 available**：下一次 query() 会重新 spawn。
  // 用于"这一次查询超时"（helper 慢/卡住），而不是"helper 根本不可用"。
  // expectedExit 让随后的 exit 事件只做收尾，不再把 available 打成 false。
  function recycleChild(reason) {
    if (!child) return
    log('Cursor helper recycled:', reason)
    expectedExit = true
    const process2 = child
    child = null
    ready = false
    shapeCache = null
    settleReady(false)
    clearPending()
    try { process2.stdin.end('quit\n') } catch {}
    try { process2.kill() } catch {}
  }

  // 子进程自己退出（崩溃 / 被杀 / 初始化失败）：只收尾，不再重复杀。
  function handleExit(reason) {
    // 我们自己回收的那次（查询超时）：只收尾，available 保持 true，下次查询重新拉起。
    if (expectedExit) {
      expectedExit = false
      child = null
      ready = false
      shapeCache = null
      settleReady(false)
      clearPending()
      return
    }
    if (!available) return
    available = false
    child = null
    ready = false
    shapeCache = null
    settleReady(false)
    clearPending()
    log('Cursor helper exited:', reason)
  }

  function handleOutput(chunk) {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = parseHelperMessage(line)
      if (message.kind === 'ready') {
        ready = true
        settleReady(true)
      } else if (message.kind === 'cursor') {
        dispatchCursor(message)
      } else if (message.kind === 'invalid' && line.trim()) {
        log('Cursor helper response error:', message.reason)
      }
      // kind === 'rects'：本 provider 不发 `id x y`，按协议忽略（不影响既有链路）。
      newline = buffer.indexOf('\n')
    }
  }

  function dispatchCursor(message) {
    // 不管这次是不是 showing，都让形状缓存失效：形状可能刚刚变了。
    shapeCache = null
    if (message.id === null) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    request.resolve(message.showing === true ? message : null)
  }

  function ensureStarted() {
    if (child || !available || disposed) return
    if (!spawn) {
      markUnavailable('spawn not injected')
      return
    }
    if (!executablePath || !existsSync(executablePath)) {
      markUnavailable(`helper missing (${executablePath || 'empty path'})`)
      return
    }

    readyPromise = new Promise((resolve) => { resolveReady = resolve })
    readySettled = false
    try {
      child = spawn(executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      child = null
      markUnavailable(error.message)
      return
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => handleOutput(chunk))
    // 写管道在 helper 猝死时可能异步报 EPIPE。本机实测（Node 24，5 种时序）未复现崩溃，
    // 但无监听器的 stream 'error' 一旦触发就是主进程未捕获异常 —— 加一行只记日志的兜底，
    // 不在这里调 handleExit（瞬时写失败不该升级成整会话不可用）。
    child.stdin.on('error', (error) => log('Cursor helper stdin:', error.message))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim()
      if (text) log('Cursor helper:', text)
    })
    child.once('error', (error) => handleExit(error.message))
    child.once('exit', (code) => handleExit(`helper exited (${code})`))
  }

  async function awaitReady() {
    if (ready) return true
    if (!readyPromise) return false
    let timer
    try {
      const result = await Promise.race([
        readyPromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), readyTimeoutMs) })
      ])
      return result === true
    } finally {
      clearTimeout(timer)
    }
  }

  // → Promise<snapshot | null>；null 表示"现在不要画光标"（含 helper 不可用）。
  async function query(queryOptions = {}) {
    if (disposed || !available) return null
    ensureStarted()
    if (!available || !child) return null

    if (queryOptions.fresh !== true && shapeCache && now() - shapeCache.at < cacheTtlMs) {
      return { ...shapeCache, cached: true }
    }

    if (!ready) {
      const started = await awaitReady()
      if (!started) {
        markUnavailable('startup timeout')
        return null
      }
    }
    if (!child) return null

    const id = nextRequestId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
        // 查询超时只回收这一次的子进程：下一次 query() 会重新 spawn。
        // 若在这里 markUnavailable，一次 CPU 争用就会让整会话（以及将来的录屏轮询）永久无光标。
        recycleChild('query timeout')
      }, queryTimeoutMs)
      pending.set(id, {
        timer,
        resolve: (message) => {
          const snapshot = createCursorSnapshot(message, now())
          if (snapshot) shapeCache = snapshot
          resolve(snapshot)
        }
      })
      try {
        child.stdin.write(`cursor ${id}\n`)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        resolve(null)
        markUnavailable(error.message)
      }
    })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    available = false
    const process2 = child
    child = null
    ready = false
    shapeCache = null
    settleReady(false)
    clearPending()
    if (process2) {
      try { process2.stdin.end('quit\n') } catch {}
      try { process2.kill() } catch {}
    }
  }

  return {
    dispose,
    isAvailable: () => available && !disposed,
    query
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  HELPER_RELATIVE_PATH,
  createCursorProvider,
  createCursorSnapshot,
  resolveCursorHelperPath
}
