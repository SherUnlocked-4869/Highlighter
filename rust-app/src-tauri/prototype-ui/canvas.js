/*
 * Highlighter R0-03 原型页面（受控目录 rust-app/src-tauri/prototype-ui/）。
 *
 * 职责（计划 §4.3 握手顺序）：
 *   1. 先注册 prototype:init 监听；
 *   2. 再 invoke('prototype_ready') 上报 ready；
 *   3. 宿主回 init（只回一次），页面按载荷画 Canvas 自检图案；
 *   4. 把 window.devicePixelRatio、Canvas 的 CSS/像素尺寸、inner/screen 尺寸
 *      通过 invoke('prototype_report_metrics') 回报给宿主日志。
 *
 * 刻意不依赖 npm 包：只使用 withGlobalTauri 暴露的 window.__TAURI__，保证原型
 * 不引入前端构建链，也不会把 main/preload/node_modules 带进资源包。
 * 事件名/命令名前缀（prototype:/host:）是原型约定，不是 R1 的正式合同。
 */
(function () {
  'use strict';

  var EVT_INIT = 'prototype:init';
  var CMD_READY = 'prototype_ready';
  var CMD_REPORT = 'prototype_report_metrics';
  var INIT_TIMEOUT_MS = 6000;
  var READY_ATTEMPTS = 3;

  var state = {
    tauri: null,
    initPayload: null,
    paintCount: 0,
    lastReport: null,
    error: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function log(message) {
    // 原型阶段没有 devtools 日志回传通道；页面日志只作为人工排查线索，
    // 宿主侧日志以 invoke 到达的 ready/init/metrics 为准。
    console.log('[prototype-ui] ' + message);
  }

  function setHud(text, stateName) {
    var hud = $('prototype-hud');
    if (!hud) {
      return;
    }
    hud.textContent = text;
    hud.dataset.state = stateName || 'ready';
  }

  function setError(message) {
    state.error = message;
    log('ERROR ' + message);
    setHud('R0-03 原型错误：' + message, 'error');
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function getTauri() {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) {
      return window.__TAURI__;
    }
    return null;
  }

  async function invokeWithRetry(command, args, attempts, delayMs) {
    var lastError = null;
    for (var attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await state.tauri.core.invoke(command, args);
      } catch (error) {
        lastError = error;
        log('invoke ' + command + ' attempt ' + attempt + ' failed: ' + String(error));
        if (attempt < attempts) {
          await sleep(delayMs);
        }
      }
    }
    throw lastError;
  }

  // ---- Canvas 自检图案 ------------------------------------------------

  function drawPattern() {
    var canvas = $('prototype-canvas');
    if (!canvas) {
      setError('缺少 #prototype-canvas');
      return false;
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('无法创建 2D context');
      return false;
    }

    var dpr = window.devicePixelRatio || 1;
    var cssWidth = Math.max(1, window.innerWidth);
    var cssHeight = Math.max(1, window.innerHeight);
    var pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    var pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== pixelWidth) {
      canvas.width = pixelWidth;
    }
    if (canvas.height !== pixelHeight) {
      canvas.height = pixelHeight;
    }
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';

    // 用 DPR 变换后按 CSS 像素作图：图案在 100/150/200% 下保持同样的物理比例。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    var pattern = (state.initPayload && state.initPayload.pattern) || {};
    var cell = pattern.cellCssPx || 64;
    var margin = pattern.marginCssPx || 24;
    var accent = pattern.accent || '#ff3b30';

    // 1) 半透明棋盘：验证 alpha 合成与透明窗口背景。
    var columns = Math.ceil(cssWidth / cell);
    var rows = Math.ceil(cssHeight / cell);
    for (var row = 0; row < rows; row += 1) {
      for (var column = 0; column < columns; column += 1) {
        ctx.fillStyle = (row + column) % 2 === 0 ? 'rgba(0, 122, 255, 0.16)' : 'rgba(255, 59, 48, 0.10)';
        ctx.fillRect(column * cell, row * cell, cell, cell);
      }
    }

    // 2) 边框 + 四角标记：验证浮层是否铺满目标显示器。
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.strokeRect(1, 1, cssWidth - 2, cssHeight - 2);
    var corner = Math.min(48, Math.max(16, margin));
    ctx.beginPath();
    ctx.moveTo(0, corner);
    ctx.lineTo(0, 0);
    ctx.lineTo(corner, 0);
    ctx.moveTo(cssWidth - corner, 0);
    ctx.lineTo(cssWidth, 0);
    ctx.lineTo(cssWidth, corner);
    ctx.moveTo(0, cssHeight - corner);
    ctx.lineTo(0, cssHeight);
    ctx.lineTo(corner, cssHeight);
    ctx.moveTo(cssWidth - corner, cssHeight);
    ctx.lineTo(cssWidth, cssHeight);
    ctx.lineTo(cssWidth, cssHeight - corner);
    ctx.stroke();

    // 3) 中心十字 + 圆 + 100 CSS px 刻度尺：验证定位与缩放。
    var centerX = cssWidth / 2;
    var centerY = cssHeight / 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, cssHeight);
    ctx.moveTo(0, centerY);
    ctx.lineTo(cssWidth, centerY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.min(80, cssWidth / 8), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (var x = 100; x < cssWidth; x += 100) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, x % 500 === 0 ? 18 : 8);
    }
    for (var y = 100; y < cssHeight; y += 100) {
      ctx.moveTo(0, y);
      ctx.lineTo(y % 500 === 0 ? 18 : 8, y);
    }
    ctx.stroke();

    // 4) 文本：把 DPR/CSS/像素尺寸直接画在窗口里，便于人工验收时肉眼核对。
    var lines = [
      'Highlighter R0-03 transparent overlay prototype',
      'devicePixelRatio = ' + dpr,
      'CSS size = ' + cssWidth + ' x ' + cssHeight,
      'canvas buffer = ' + pixelWidth + ' x ' + pixelHeight + ' px',
      'window.screen = (' + window.screenX + ', ' + window.screenY + ')',
      'protocol = ' + ((state.initPayload && state.initPayload.protocol) || '<none>'),
    ];
    ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
    var textX = margin;
    var textY = Math.max(72, margin + 32);
    ctx.textBaseline = 'top';
    for (var index = 0; index < lines.length; index += 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.fillText(lines[index], textX + 1, textY + index * 22 + 1);
      ctx.fillStyle = '#1c1c1e';
      ctx.fillText(lines[index], textX, textY + index * 22);
    }

    state.paintCount += 1;
    return true;
  }

  // ---- 指标回报 -------------------------------------------------------

  function collectMetrics() {
    var canvas = $('prototype-canvas');
    var rect = canvas.getBoundingClientRect();
    return {
      devicePixelRatio: window.devicePixelRatio || 0,
      canvasCssWidth: rect.width,
      canvasCssHeight: rect.height,
      canvasPixelWidth: canvas.width,
      canvasPixelHeight: canvas.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      paintCount: state.paintCount,
      userAgent: navigator.userAgent,
    };
  }

  async function reportMetrics() {
    var report = collectMetrics();
    state.lastReport = report;
    var ack = await invokeWithRetry(CMD_REPORT, { report: report }, 2, 300);
    log('metrics reported: ' + JSON.stringify(ack));
    if (ack && ack.accepted) {
      setHud(
        'R0-03 原型 ready\n' +
          'devicePixelRatio = ' + report.devicePixelRatio + '\n' +
          'canvas CSS = ' + report.canvasCssWidth + ' x ' + report.canvasCssHeight + '\n' +
          'canvas 像素 = ' + report.canvasPixelWidth + ' x ' + report.canvasPixelHeight + '\n' +
          'window.screen = (' + report.screenX + ', ' + report.screenY + ')\n' +
          '握手 = ready -> init（单次）',
        'ready'
      );
    } else {
      setError('宿主拒绝了指标回报');
    }
  }

  // ---- 握手 -----------------------------------------------------------

  async function onInit(event) {
    var payload = event && event.payload ? event.payload : null;
    state.initPayload = payload;
    log('init received: ' + JSON.stringify(payload));
    // 等两帧，确保窗口已经真正合成/可见后再画，避免首帧黑/白闪的误判。
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!drawPattern()) {
          return;
        }
        reportMetrics().catch(function (error) {
          setError('指标回报失败: ' + String(error));
        });
      });
    });
  }

  async function boot() {
    state.tauri = getTauri();
    if (!state.tauri) {
      setError('window.__TAURI__ 不可用：本页面必须由 Tauri 原型宿主加载');
      return;
    }

    // 1) 先注册监听。
    await state.tauri.event.listen(EVT_INIT, onInit);
    log('listener registered: ' + EVT_INIT);
    setHud('R0-03 原型：已注册 init 监听，等待宿主应答 ready…', 'booting');

    // 2) 再 ready。
    var ack = await invokeWithRetry(CMD_READY, undefined, READY_ATTEMPTS, 250);
    log('ready ack: ' + JSON.stringify(ack));

    // 3) init 超时诊断（宿主侧自检会打印 ready/init 计数，这里只做页面侧提示）。
    setTimeout(function () {
      if (!state.initPayload) {
        setError('等待 prototype:init 超时（ready 已上报，可能 init 事件转发失败）');
      }
    }, INIT_TIMEOUT_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      boot().catch(function (error) {
        setError('初始化失败: ' + String(error));
      });
    });
  } else {
    boot().catch(function (error) {
      setError('初始化失败: ' + String(error));
    });
  }
})();
