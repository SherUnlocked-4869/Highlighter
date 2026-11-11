#!/usr/bin/env node
/**
 * ADR-0006 最小桌面 WebDriver 探针（tauri-driver -> msedgedriver -> R0-03 Tauri 原型）。
 *
 * 目的：用原始 WebDriver HTTP 协议证明"真实 Tauri 进程可被官方 WebDriver 路径驱动"，
 * 并记录能力边界与失败分支。不依赖 npm 包（Node 24 内置 fetch）。
 *
 * 前置（由调用方负责，见 r0-test-driver.md）：
 *   1. tauri-driver 已在 127.0.0.1:4444 监听，且 --native-driver 指向与
 *      本机 WebView2 Runtime 完全一致的 msedgedriver.exe；
 *   2. 单屏主机需 HIGHLIGHTER_R0_ALLOW_PRIMARY=1（测试专用开关）；
 *   3. TMP/TEMP 指向仓库内 .tmp-r07/... 目录（受限宿主下子进程写不了用户 Temp）。
 *
 * 用法：
 *   node scripts/rust/probe-tauri-webdriver.js [--app <exe>] [--out <dir>] [--skip-negative]
 *
 * 退出码：0 全流程通过；2 能力/协议断言失败；3 new session 失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DRIVER_URL = process.env.WEBDRIVER_URL || 'http://127.0.0.1:4444';

function parseArgs(argv) {
  const options = {
    app: path.join(REPO_ROOT, 'rust-app', 'target', 'debug', 'highlighter-r0-window.exe'),
    out: path.join(REPO_ROOT, '.tmp-r07', 'driver', 'webdriver'),
    skipNegative: false,
    mode: 'full',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') options.app = path.resolve(argv[(index += 1)]);
    else if (arg === '--out') options.out = path.resolve(argv[(index += 1)]);
    else if (arg === '--skip-negative') options.skipNegative = true;
    else if (arg === '--mode') options.mode = argv[(index += 1)];
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/rust/probe-tauri-webdriver.js [--app <exe>] [--out <dir>] [--mode full|close|crash] [--skip-negative]');
      process.exit(0);
    } else throw new Error('未知参数: ' + arg);
  }
  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(method, pathname, body) {
  const url = DRIVER_URL + pathname;
  const started = Date.now();
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { url, method, requestBody: body, status: response.status, json, text, elapsedMs: Date.now() - started };
}

function makeRecorder(outDir) {
  const logPath = path.join(outDir, 'probe-log.jsonl');
  fs.writeFileSync(logPath, '');
  return function record(name, result) {
    const line = JSON.stringify({
      name,
      method: result.method,
      url: result.url,
      status: result.status,
      elapsedMs: result.elapsedMs,
      requestBody: result.requestBody === undefined ? null : result.requestBody,
      response: result.json === null ? result.text : result.json,
    });
    fs.appendFileSync(logPath, line + '\n');
    console.log('[' + result.status + '] ' + name + ' (' + result.elapsedMs + 'ms)');
    return result;
  };
}

function summarize(name, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log('  ' + name + ': ' + (text.length > 600 ? text.slice(0, 600) + '…' : text));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.out);
  const record = makeRecorder(options.out);
  const results = { startedAt: new Date().toISOString(), app: options.app, driverUrl: DRIVER_URL, steps: [] };
  let sessionId = null;
  let exitCode = 0;

  // 1) 驱动中间层存活检查（tauri-driver 转发层自身没有 /status 语义保证，失败不中断）。
  const status = record('GET /status', await request('GET', '/status'));
  results.steps.push({ step: 'status', status: status.status });

  // 2) new session：tauri:options.application 指向真实原型可执行文件。
  //    Windows 上 tauri-driver 会把它翻译成 ms:edgeOptions.binary + browserName=webview2。
  const capabilities = {
    capabilities: {
      alwaysMatch: {
        'tauri:options': {
          application: options.app,
          args: [],
        },
      },
    },
  };
  const newSession = record('POST /session', await request('POST', '/session', capabilities));
  results.newSession = newSession.json;
  if (newSession.status !== 200 || !newSession.json || !newSession.json.value || !newSession.json.value.sessionId) {
    console.error('FAIL: new session 失败，见 probe-log.jsonl');
    fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(results, null, 2));
    process.exit(3);
  }
  sessionId = newSession.json.value.sessionId;
  const sessionPath = '/session/' + sessionId;
  results.sessionId = sessionId;
  results.capabilities = newSession.json.value.capabilities;
  summarize('sessionId', sessionId);
  summarize('browserVersion', newSession.json.value.capabilities.browserVersion);
  summarize('debuggerAddress', (newSession.json.value.capabilities['ms:edgeOptions'] || {}).debuggerAddress);

  // 3) 窗口句柄：Tauri 单窗口原型应恰好 1 个。
  const handles = record('GET /window/handles', await request('GET', sessionPath + '/window/handles'));
  results.windowHandles = handles.json && handles.json.value;
  const handleCount = Array.isArray(results.windowHandles) ? results.windowHandles.length : -1;
  results.windowHandleCount = handleCount;
  summarize('windowHandles', results.windowHandles);

  // 4) execute/sync：标题（证明注入脚本/页面上下文可达）。
  const title = record('POST /execute/sync (document.title)', await request('POST', sessionPath + '/execute/sync', {
    script: 'return document.title;',
    args: [],
  }));
  results.title = title.json && title.json.value;
  summarize('title', results.title);

  // 5) 页面侧状态：URL/readyState/DPR/HUD 状态（HUD 由原型页在 init+metrics 后置为 ready）。
  const stateScript = [
    'return JSON.stringify({',
    '  title: document.title,',
    '  url: location.href,',
    '  readyState: document.readyState,',
    '  dpr: window.devicePixelRatio,',
    '  inner: [window.innerWidth, window.innerHeight],',
    '  screen: [window.screenX, window.screenY],',
    '  hudState: document.getElementById("prototype-hud") ? document.getElementById("prototype-hud").dataset.state : null,',
    '  hudText: document.getElementById("prototype-hud") ? document.getElementById("prototype-hud").textContent : null,',
    '  hasTauri: !!(window.__TAURI__ && window.__TAURI__.core),',
    '});',
  ].join('\n');
  const state = record('POST /execute/sync (page state)', await request('POST', sessionPath + '/execute/sync', { script: stateScript, args: [] }));
  results.pageState = state.json && JSON.parse(state.json.value);
  summarize('pageState', results.pageState);

  // 6) 窗口矩形。
  const rect = record('GET /window/rect', await request('GET', sessionPath + '/window/rect'));
  results.windowRect = rect.json && rect.json.value;
  summarize('windowRect', results.windowRect);

  // 7) 从页面经 Tauri IPC 调用 Rust 命令（证明 WebDriver 注入的脚本可以驱动宿主命令面）。
  const ipcScript = [
    'const done = arguments[arguments.length - 1];',
    'window.__TAURI__.core.invoke("host_list_monitors")',
    '  .then((value) => done(JSON.stringify({ ok: true, value })))',
    '  .catch((error) => done(JSON.stringify({ ok: false, error: String(error) })));',
  ].join('\n');
  const ipc = record('POST /execute/async (host_list_monitors)', await request('POST', sessionPath + '/execute/async', { script: ipcScript, args: [] }));
  results.hostListMonitors = ipc.json && JSON.parse(ipc.json.value);
  summarize('hostListMonitors', results.hostListMonitors);

  results.appProcessId = newSession.json.value.capabilities['goog:processID'] || null;

  // 7a) 输入注入：页面装 pointerdown 计数器 -> W3C actions 点击 -> 读回计数。
  //     证明 WebDriver 输入事件经 EdgeDriver/CDP 到达 WebView2 页面。
  await request('POST', sessionPath + '/execute/sync', {
    script: 'window.__probeClicks = 0; document.addEventListener("pointerdown", function () { window.__probeClicks += 1; }); return true;',
    args: [],
  });
  const actions = record('POST /actions (pointer click)', await request('POST', sessionPath + '/actions', {
    actions: [
      {
        type: 'pointer',
        id: 'probe-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: 200, y: 200, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  }));
  const clicks = record('POST /execute/sync (pointerdown count)', await request('POST', sessionPath + '/execute/sync', {
    script: 'return window.__probeClicks === undefined ? -1 : window.__probeClicks;',
    args: [],
  }));
  results.inputInjection = { actionsStatus: actions.status, clickCount: clicks.json ? clicks.json.value : null };
  summarize('inputInjection', results.inputInjection);
  if (actions.status < 200 || actions.status >= 300 || results.inputInjection.clickCount !== 1) {
    console.error('FAIL: 输入注入未按预期到达页面（actions=' + actions.status + ', clickCount=' + results.inputInjection.clickCount + '）');
    exitCode = 2;
  }

  // 7b) 附加模式：窗口关闭 / 进程崩溃恢复边界（ADR-0006 要求评估关闭与崩溃行为）。
  if (options.mode === 'close') {
    let closeCode = 0;
    // W3C Close Window = DELETE /session/{id}/window（POST /window 是 Switch To Window，需 handle）。
    const closed = record('DELETE /window (W3C close current window)', await request('DELETE', sessionPath + '/window'));
    results.closeWindow = { status: closed.status, body: closed.json };
    await sleep(1500);
    const handlesAfter = record('GET /window/handles (after close)', await request('GET', sessionPath + '/window/handles'));
    results.afterCloseHandles = { status: handlesAfter.status, body: handlesAfter.json };
    const execAfter = record('POST /execute/sync (after close)', await request('POST', sessionPath + '/execute/sync', { script: 'return document.title;', args: [] }));
    results.afterCloseExecute = { status: execAfter.status, body: execAfter.json };
    const deleted = record('DELETE /session/{id} (after close)', await request('DELETE', sessionPath));
    results.deleteSession = { status: deleted.status, body: deleted.json };
    results.mode = 'close';
    results.finishedAt = new Date().toISOString();
    results.exitCode = closeCode;
    fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(results, null, 2));
    console.log('--- summary (close mode) ---');
    console.log('exitCode=' + closeCode);
    process.exit(closeCode);
  }

  if (options.mode === 'crash') {
    let crashCode = 0;
    const appProcessId = results.appProcessId;
    if (!appProcessId) {
      console.error('FAIL: capabilities 缺少 goog:processID，无法定位应用进程');
      crashCode = 2;
    } else {
      console.log('  killing application process pid=' + appProcessId);
      try {
        process.kill(appProcessId);
        results.appKilled = true;
      } catch (error) {
        results.appKilled = String(error);
        crashCode = 2;
      }
      await sleep(2000);
      const handlesAfter = record('GET /window/handles (after app crash)', await request('GET', sessionPath + '/window/handles'));
      results.afterCrashHandles = { status: handlesAfter.status, body: handlesAfter.json };
      const execAfter = record('POST /execute/sync (after app crash)', await request('POST', sessionPath + '/execute/sync', { script: 'return document.title;', args: [] }));
      results.afterCrashExecute = { status: execAfter.status, body: execAfter.json };
      const deleted = record('DELETE /session/{id} (after crash)', await request('DELETE', sessionPath));
      results.deleteSession = { status: deleted.status, body: deleted.json };
    }
    results.mode = 'crash';
    results.finishedAt = new Date().toISOString();
    results.exitCode = crashCode;
    fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(results, null, 2));
    console.log('--- summary (crash mode) ---');
    console.log('exitCode=' + crashCode);
    process.exit(crashCode);
  }

  // 8) 等待页面握手完成：HUD 由原型页在收到 host init + metrics 回报成功后置为 ready。
  //    证明 WebDriver 可以观察"ready -> init -> 页面就绪"的顺序与完成时点。
  const readyPollScript = [
    'var hud = document.getElementById("prototype-hud");',
    'return JSON.stringify({ state: hud ? hud.dataset.state : null, text: hud ? hud.textContent : null, dpr: window.devicePixelRatio });',
  ].join('\n');
  const pollStarted = Date.now();
  let readyState = null;
  let readyAttempts = 0;
  while (Date.now() - pollStarted < 15000) {
    readyAttempts += 1;
    const poll = await request('POST', sessionPath + '/execute/sync', { script: readyPollScript, args: [] });
    if (poll.status === 200 && poll.json && typeof poll.json.value === 'string') {
      readyState = JSON.parse(poll.json.value);
      if (readyState.state === 'ready' || readyState.state === 'error') break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const readyElapsedMs = Date.now() - pollStarted;
  results.readyPoll = { attempts: readyAttempts, elapsedMs: readyElapsedMs, state: readyState };
  record('READY poll (HUD state)', { method: 'POST', url: DRIVER_URL + sessionPath + '/execute/sync', status: readyState ? 200 : 0, elapsedMs: readyElapsedMs, requestBody: null, json: readyState, text: '' });
  summarize('readyPoll', results.readyPoll);
  if (!readyState || readyState.state !== 'ready') {
    console.error('FAIL: 页面握手未在 15s 内到达 ready（state=' + (readyState && readyState.state) + '）');
    exitCode = 2;
  }

  // 9) 截图（透明浮层；PNG 字节数与 sha256 写入摘要，图片留在 out/screenshot.png）。
  const shot = record('GET /screenshot', await request('GET', sessionPath + '/screenshot'));
  const base64 = shot.json && shot.json.value;
  if (typeof base64 === 'string') {
    const bytes = Buffer.from(base64, 'base64');
    const shotPath = path.join(options.out, 'screenshot.png');
    fs.writeFileSync(shotPath, bytes);
    results.screenshot = {
      path: shotPath,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      base64Length: base64.length,
    };
    summarize('screenshot', results.screenshot);
  } else {
    results.screenshot = { error: 'screenshot 返回非 base64 字符串' };
    console.error('FAIL: screenshot 未返回 base64');
    exitCode = 2;
  }

  // 10) delete session（观察应用是否随 session 关闭）。
  const deleted = record('DELETE /session/{id}', await request('DELETE', sessionPath));
  results.deleteSession = { status: deleted.status, body: deleted.json };
  sessionId = null;

  // 11) 失败分支：application 指向不存在的可执行文件，记录真实错误 JSON（不启动任何进程）。
  if (!options.skipNegative) {
    const missing = record('POST /session (missing application, negative)', await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': {
            application: path.join(options.out, 'definitely-missing-highlighter-r0-window.exe'),
            args: [],
          },
        },
      },
    }));
    results.negativeMissingApplication = { status: missing.status, response: missing.json };
    if (missing.status < 400) {
      console.error('FAIL: 缺失可执行文件时 new session 竟然成功');
      exitCode = 2;
    }
  }

  results.finishedAt = new Date().toISOString();
  results.exitCode = exitCode;
  fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('--- summary ---');
  console.log('exitCode=' + exitCode + ' out=' + options.out);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('probe crashed: ' + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
