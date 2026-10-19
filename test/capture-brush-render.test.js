// Brush plan §6.3 —— 渲染层像素回归（真实 Electron 隐藏窗，不占屏幕）。
//
// 为什么必须有一条"真窗口 + 真绘制"的断言：§5.6 那个 DPR/坐标 bug 只在真实画布上出现，
// 纯函数层看不见它。本文件按方案 §5.7 的纪律构造取样点：
//   ① 取样点由内容探测决定，不手写坐标（否则断言会在空白处恒真 —— 原型开发时踩过两次）；
//   ② 分区计数（笔刷带内 / 带外）而不是单点比较；
//   ③ 用"硬边是否对齐"验证采样坐标（这是 DPR 偏移的唯一可靠防线）；
//   ④ 所有跨坐标系比较统一换算回 CSS px（导出画布是设备像素，标注是 CSS px）。
//
// 窗口一律 show:false：AGENTS.md 要求可见测试窗放副屏，而本机只有主屏，所以绝不可见。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

// 舞台（CSS px）。截图位图故意比它大 SOURCE_SCALE 倍 —— 真实 HiDPI 屏就是这样：
// 截图位图是物理像素，窗口是 DIP，二者比值就是 dpr。
//
// 这一条是 §5.6 那个 DPR bug 的**唯一自动防线**：如果源图与显示区 1:1，源码里
// sourceScaleX 恒为 1，把采样换算整个删掉断言也不会红 —— 那就是 §5.7 反复警告的
// "看着通过、其实什么都没测到"。所以源图必须是 1.5×。
const STAGE_WIDTH = 900
const STAGE_HEIGHT = 700
const SOURCE_SCALE = 1.5
// 截图里硬边的 CSS 横坐标（DPR 检查要用一条真实的色块边界）。
const HARD_EDGE_X = 450

// 一条横穿文字行、略带起伏的马赛克笔迹（模拟"跟着字行涂抹"）。
const BLUR_POINTS = (() => {
  const points = []
  for (let index = 0; index < 46; index += 1) {
    points.push({ x: 70 + index * 11, y: 150 + Math.sin(index / 4) * 16 + index * 0.5 })
  }
  return points
})()

const PROBE_SOURCE = `
'use strict'
const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.BRUSH_PROBE_ROOT
const RESULT = process.env.BRUSH_PROBE_RESULT
const { createSecureWindow } = require(path.join(ROOT, 'main', 'services', 'window-security'))

const STAGE_WIDTH = ${STAGE_WIDTH}
const STAGE_HEIGHT = ${STAGE_HEIGHT}
const SOURCE_SCALE = ${SOURCE_SCALE}
const HARD_EDGE_X = ${HARD_EDGE_X}
const BLUR_POINTS = ${JSON.stringify(BLUR_POINTS)}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const records = { consoles: [] }

ipcMain.on('capture:ready', () => {})
ipcMain.on('capture:render-ready', () => {})
ipcMain.on('capture:render-error', (_event, message) => records.consoles.push('render-error: ' + message))
ipcMain.on('capture:close', () => {})
ipcMain.on('capture:save', () => {})
ipcMain.handle('capture:export-pdf', () => null)

let win = null

// The synthetic screenshot, drawn at device resolution (SOURCE_SCALE x the display area).
// It carries BOTH kinds of content the assertions need:
//   · dark text rows -> a stroke over text really changes pixels;
//   · one hard vertical colour edge at HARD_EDGE_X -> the sampling-coordinate probe (§5.7-3).
function screenshotDataUrl () {
  return win.webContents.executeJavaScript(\`(function(){
    var scale=\${SOURCE_SCALE};
    var W=\${STAGE_WIDTH}, H=\${STAGE_HEIGHT};
    var c=document.createElement('canvas');
    c.width=Math.round(W*scale); c.height=Math.round(H*scale);
    var g=c.getContext('2d');
    g.scale(scale,scale);
    g.fillStyle='#fbfaf6'; g.fillRect(0,0,W,H);
    // A vertical luminance ramp behind everything: pixelating a GRADIENT always changes
    // pixels, while pixelating flat colour changes nothing. This is what makes the
    // "the mosaic really drew something" assertions meaningful (a flat region would make
    // them pass vacuously - the sampling trap §5.7 warns about).
    var ramp=g.createLinearGradient(0,0,W,H);
    ramp.addColorStop(0,'#f0eee6'); ramp.addColorStop(0.5,'#9aa0b4'); ramp.addColorStop(1,'#38405a');
    g.fillStyle=ramp; g.fillRect(0,0,W,H);
    // A hard vertical black/white edge at HARD_EDGE_X spanning the full height: this is the
    // sampling-coordinate probe (§5.7-3). It sits ON TOP of the ramp so the edge is sharp.
    g.fillStyle='#ffffff'; g.fillRect(\${HARD_EDGE_X}-90,0,90,H);
    g.fillStyle='#000000'; g.fillRect(\${HARD_EDGE_X},0,90,H);
    return c.toDataURL('image/png');
  })()\`)
}

async function main () {
  const report = { ok: false }
  try {
    const pagePath = path.join(ROOT, 'capture', 'capture.html')
    win = createSecureWindow({
      BrowserWindow: BrowserWindow,
      pagePath: pagePath,
      options: {
        show: false,
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        frame: false,
        resizable: false,
        webPreferences: {
          preload: path.join(ROOT, 'preload-capture.js'),
          backgroundThrottling: false
        }
      }
    })
    win.webContents.on('console-message', function () {
      const args = Array.prototype.slice.call(arguments)
      const details = args[1]
      const text = details && typeof details === 'object' && details.message ? details.message : args[2]
      if (text) records.consoles.push(String(text))
    })
    await win.loadFile(pagePath)

    const dataUrl = await screenshotDataUrl()
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    win.webContents.send('capture:init', {
      imageBuffer: png,
      mode: 'region',
      autoAction: '',
      source: 'region',
      displayBounds: { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
      captureBounds: { x: 0, y: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT },
      imageBounds: null,
      scaleFactor: 1,
      editPin: false,
      smartSelect: false,
      cursorPosition: { x: 0, y: 0 },
      saveMode: '',
      cursor: null,
      serialNumber: 1,
      settings: { mainColor: '#e5a44c', screenshot: { shutterSound: false, fastSave: false, annotationWidth: 4, watermark: {} }, ocr: {} }
    })
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const loaded = await win.webContents.executeJavaScript('!!(image&&image.complete&&image.naturalWidth>0)')
      if (loaded) break
      await sleep(50)
    }
    await sleep(250)

    // Page-side helpers. Everything the assertions read is expressed in CSS px: the export
    // canvas is device pixels, so the helpers divide by exportScale (= device px per CSS px).
    await win.webContents.executeJavaScript(\`(function(){
      window.__brush = {
        frame: function(includeAnnotations){
          if(!selection||selection.w<2) selection={x:0,y:0,w:innerWidth,h:innerHeight};
          var out=exportSelectionCanvas(includeAnnotations!==false);
          var ctx=out.getContext('2d');
          var data=ctx.getImageData(0,0,out.width,out.height).data;
          return {width:out.width,height:out.height,data:Array.prototype.slice.call(data),
                  exportScale: out.width/selection.w};
        },
        set: function(list){ annotations=list; annotationSeq=list.length; renderOverlay(); },
        meta: function(){
          return {dpr:window.devicePixelRatio,w:innerWidth,h:innerHeight,
                  imageSize:{w:image.naturalWidth,h:image.naturalHeight},
                  cell:MOSAIC_CELL,brush:blurBrushWidth(4),
                  // source px per CSS px - the conversion the mosaic sampling must apply (§5.6)
                  sourceScale:image.naturalWidth/imageDisplayBounds().w};
        },
        hit: function(item,point){ return findAnnotationAt([item],point)===item; },
        bounds: function(item){ return annotationBounds(item); }
      };
      return true;
    })()\`)

    // A reusable page-side differ: counts changed pixels, optionally split by a classifier
    // that says whether an (x,y) - in CSS px - lies inside the stroke band. The classifier
    // is passed as plain point data and interpreted here (no eval: the page runs under a
    // strict CSP that forbids unsafe-eval).
    await win.webContents.executeJavaScript(\`(function(){
      window.__brush.diff = function(ann, bandPoints, bandRadius){
        var before=window.__brush.frame(false);
        // ann may be a single annotation or an ARRAY of them (multi-stroke probes).
        window.__brush.set(ann ? (Array.isArray(ann) ? ann : [ann]) : []);
        var after=window.__brush.frame(true);
        var scale=after.exportScale;
        function inBand(x,y){
          if(!bandPoints||!bandPoints.length) return false;
          for(var i=1;i<bandPoints.length;i++){
            var ax=bandPoints[i-1].x, ay=bandPoints[i-1].y, bx=bandPoints[i].x, by=bandPoints[i].y;
            var dx=bx-ax, dy=by-ay, l2=dx*dx+dy*dy;
            var t=l2?((x-ax)*dx+(y-ay)*dy)/l2:0;
            t=Math.max(0,Math.min(1,t));
            if(Math.hypot(x-(ax+t*dx),y-(ay+t*dy))<=bandRadius) return true;
          }
          return false;
        }
        var inside=0, outside=0, count=0;
        var minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
        for(var off=0;off+3<before.data.length;off+=4){
          if(before.data[off]===after.data[off]&&before.data[off+1]===after.data[off+1]&&
             before.data[off+2]===after.data[off+2]&&before.data[off+3]===after.data[off+3]) continue;
          var idx=off/4;
          var x=(idx%before.width)/scale, y=Math.floor(idx/before.width)/scale;
          count++;
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
          if(bandPoints){ if(inBand(x,y)) inside++; else outside++; }
        }
        return {count:count, inside:inside, outside:outside,
                minX:minX, maxX:maxX, minY:minY, maxY:maxY};
      };
      return true;
    })()\`)

    // ---- 1) 马赛克只改轨迹内：带外 == 0（本方案最核心的不变量，§6.3-1） ------------
    const mosaic = await win.webContents.executeJavaScript(\`(function(){
      var points=\${JSON.stringify(BLUR_POINTS)};
      // 带内 = 到折线的距离 <= 笔刷半宽 + 2（与绘制用的 pad 同量级）。
      var result=window.__brush.diff({id:1,type:'blur',color:'#ff3b30',width:4,points:points}, points, 14);
      // 像素化生效：取笔迹上一点所在的**同一个 mosaic 格**，格内颜色种类必须是 1。
      // 取样必须严格落在格内：格的设备像素边长是 MOSAIC_CELL*scale，网格相位锚定画布原点
      // （§3.2.2），所以先算出该点所在格的设备像素左上角，再往内缩 3px 取样，绝不跨格。
      var after=window.__brush.frame(true);
      var scale=after.exportScale;
      var center=points[20];
      var cellDev=Math.round(MOSAIC_CELL*scale);
      var cellX=Math.floor(center.x*scale/cellDev)*cellDev;
      var cellY=Math.floor(center.y*scale/cellDev)*cellDev;
      var colors={};
      for(var dy=3;dy<cellDev-3;dy++)for(var dx=3;dx<cellDev-3;dx++){
        var o=((cellY+dy)*after.width+(cellX+dx))*4;
        colors[after.data[o]+','+after.data[o+1]+','+after.data[o+2]]=1;
      }
      result.cellColors=Object.keys(colors).length;
      result.cellDev=cellDev;
      return result;
    })()\`)

    // ---- 1b) 网格相位锚定（§7.2 的"砖缝"反例）：两条重叠笔迹必须共用同一套格 ----
    // 单笔永远看不出相位错位 —— 只有**两条各自以自己的 bbox 为相位起点**时，重叠处才会
    // 出现两种相位拼接的"砖缝"。所以这条断言必须用两笔，否则它是恒真的（§5.7 的假通过）。
    const gridPhase = await win.webContents.executeJavaScript(\`(function(){
      var a=[]; for(var i=0;i<=30;i++) a.push({x:120+i*8, y:300});
      var b=[]; for(var j=0;j<=30;j++) b.push({x:120+j*8, y:308});
      var after=window.__brush.diff([
        {id:10,type:'blur',color:'#f00',width:4,points:a},
        {id:11,type:'blur',color:'#f00',width:4,points:b}
      ], null, 0);
      // 两笔重叠带（"砖缝"若存在，就出现在这里）：
      // 若相位一致，同一格内的颜色必须唯一；相位不一致时格子会半格错开，格内出现 2+ 种色。
      var frame=window.__brush.frame(true);
      var scale=frame.exportScale;
      var cellDev=Math.round(MOSAIC_CELL*scale);
      // 在重叠带里连续取样多格，统计"格内颜色种类 > 1"的格数。
      var badCells=0, checkedCells=0;
      for(var cx=150; cx<430; cx+=MOSAIC_CELL){
        for(var cy=295; cy<313; cy+=MOSAIC_CELL){
          var baseX=Math.floor(cx*scale/cellDev)*cellDev;
          var baseY=Math.floor(cy*scale/cellDev)*cellDev;
          var colors={};
          var ok=true;
          for(var dy=4;dy<cellDev-4;dy++)for(var dx=4;dx<cellDev-4;dx++){
            var px=baseX+dx, py=baseY+dy;
            if(px<0||py<0||px>=frame.width||py>=frame.height){ ok=false; break; }
            var o=(py*frame.width+px)*4;
            colors[frame.data[o]+','+frame.data[o+1]+','+frame.data[o+2]]=1;
          }
          if(!ok) continue;
          checkedCells++;
          if(Object.keys(colors).length>1) badCells++;
        }
      }
      return {count:after.count, badCells:badCells, checkedCells:checkedCells};
    })()\`)

    // ---- 2) 单击落墨（取样点由内容探测决定：扫出最暗的字形像素） -------------------
    const taps = await win.webContents.executeJavaScript(\`(function(){
      var bg=window.__brush.frame(false);
      var scale=bg.exportScale;
      // content probe in CSS px: scan the text block for the darkest pixel
      var best={x:0,y:0,v:999};
      for(var y=60;y<400;y++){
        for(var x=40;x<500;x++){
          var px=Math.round(x*scale), py=Math.round(y*scale);
          var off=(py*bg.width+px)*4;
          var v=bg.data[off]+bg.data[off+1]+bg.data[off+2];
          if(v<best.v){ best={x:x,y:y,v:v}; }
        }
      }
      // 单击落墨的强断言：**笔迹落点的中心像素本身**必须被改。
      // 只数"有多少像素变了"不够 —— 空路径与真实描边的差别就在落点上。另外中心像素用
      // 落点附近 3x3 的最大差值，避免抗锯齿让单个像素恰好不变（§5.7 的取样纪律）。
      function centerChanged(ann){
        var before=window.__brush.frame(false);
        window.__brush.set([ann]);
        var after=window.__brush.frame(true);
        var scale=after.exportScale;
        var px=Math.round(ann.points[0].x*scale);
        var py=Math.round(ann.points[0].y*scale);
        var bestDiff=0;
        for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){
          var o=((py+dy)*before.width+(px+dx))*4;
          var diff=Math.abs(before.data[o]-after.data[o])+
                   Math.abs(before.data[o+1]-after.data[o+1])+
                   Math.abs(before.data[o+2]-after.data[o+2]);
          if(diff>bestDiff) bestDiff=diff;
        }
        return {pixelDiff:bestDiff, count:window.__brush.diff(ann, null, 0).count};
      }
      return {
        probe: best,
        blurDot: centerChanged({id:2,type:'blur',color:'#f00',width:4,points:[{x:best.x,y:best.y}]}),
        highlightDot: centerChanged({id:3,type:'highlight',color:'#ffcc00',alpha:'medium',width:4,points:[{x:best.x,y:best.y}]})
      };
    })()\`)

    // ---- 3) 高亮笔迹的 y 范围 ≈ ±highlightWidth/2（§6.3-4） ---------------------
    const highlight = await win.webContents.executeJavaScript(\`(function(){
      var points=[{x:80,y:430},{x:200,y:410},{x:320,y:430},{x:440,y:415}];
      var result=window.__brush.diff({id:4,type:'highlight',color:'#ffcc00',alpha:'strong',width:4,points:points}, null, 0);
      result.half=highlightWidth(4)/2;
      result.strokeMinY=410; result.strokeMaxY=430;
      // 半透明验证：高亮必须让**下面的内容透出来**。取样原则：在笔迹核心带（笔迹中轴 ±2px）
      // 内连续取点，统计"上色后 = 笔色本身"的像素占比。alpha=1 时笔迹带会被笔色完全覆盖
      // （占比 ≈ 100%）；半透明时底色参与混合，绝大多数像素**不等于**笔色。
      var before=window.__brush.frame(false);
      var after=window.__brush.frame(true);
      var scale=after.exportScale;
      // 笔色（resolveAlpha 之外的颜色本身）
      var solid=0, total=0, spread={min:1e9,max:-1e9};
      for(var cx=100;cx<400;cx+=10){
        // 笔迹在 x∈[80,440] 内的 y 由端点插值近似；取样点取相邻两点的中轴
        var t=(cx-80)/(440-80);
        var cy=430 + (t<0.5 ? (410-430)*(t/0.5) : (415-410)*((t-0.5)/0.5));
        var px=Math.round(cx*scale), py=Math.round(cy*scale);
        var o=(py*before.width+px)*4;
        var r=after.data[o], g=after.data[o+1], b=after.data[o+2];
        total++;
        // 笔色 #ffcc00 = (255,204,0)：完全不透明时三通道会贴近这个值
        if(Math.abs(r-255)<=6 && Math.abs(g-204)<=6 && Math.abs(b-0)<=12) solid++;
        var v=r+g+b;
        if(v<spread.min)spread.min=v; if(v>spread.max)spread.max=v;
      }
      result.coreSamples=total;
      result.solidRatio=total?solid/total:0;
      result.coreSpread=spread.max-spread.min;
      return result;
    })()\`)

    // ---- 4) 旧标注（无 points）继续走旧分支（§6.3-6） ---------------------------
    const legacy = await win.webContents.executeJavaScript(\`(function(){
      var hl=window.__brush.diff({id:5,type:'highlight',x:80,y:560,x2:420,y2:560,color:'#ffcc00',alpha:'medium',width:4}, null, 0);
      // 旧马赛克矩形横跨硬边（黑/白交界处才有内容差异），否则"没变化"只是采样位置问题（§5.7）。
      var blur=window.__brush.diff({id:6,type:'blur',x:${HARD_EDGE_X - 120},y:560,x2:${HARD_EDGE_X + 120},y2:660,color:'#f00',width:4}, null, 0);
      return {highlight:hl, blur:blur};
    })()\`)

    // ---- 5) 采样坐标没有 DPR 偏移（硬边对齐；§5.7-3 唯一可靠的防线） --------------
    const edge = await win.webContents.executeJavaScript(\`(function(){
      // 在**CSS y=600**（硬边区）扫出第一条黑像素的 CSS x —— 原图与绘制后各扫一次。
      function edgeX(frame){
        var scale=frame.exportScale;
        var py=Math.round(600*scale);
        for(var px=0;px<frame.width;px++){
          var off=(py*frame.width+px)*4;
          if(frame.data[off]<128) return px/scale;
        }
        return -1;
      }
      var before=window.__brush.frame(false);
      var points=[];
      for(var i=0;i<=80;i++) points.push({x:200+i*4,y:600});
      window.__brush.set([{id:7,type:'blur',color:'#f00',width:4,points:points}]);
      var after=window.__brush.frame(true);
      return {
        before: edgeX(before),
        after: edgeX(after),
        cell: MOSAIC_CELL,
        hardEdgeX: ${HARD_EDGE_X},
        sourceScale: image.naturalWidth/imageDisplayBounds().w
      };
    })()\`)

    // ---- 6) 命中 / 包围盒（真实页面里的同一份纯函数） ---------------------------
    const geometry = await win.webContents.executeJavaScript(\`(function(){
      var stroke={id:8,type:'blur',color:'#f00',width:4,points:[{x:100,y:100},{x:300,y:200}]};
      var legacyBlur={id:9,type:'blur',x:0,y:0,x2:40,y2:40,color:'#f00',width:4};
      return {
        onStroke: window.__brush.hit(stroke,{x:200,y:150}),
        offStroke: window.__brush.hit(stroke,{x:100,y:200}),
        legacyCenter: window.__brush.hit(legacyBlur,{x:20,y:20}),
        bounds: window.__brush.bounds(stroke),
        brushHalf: blurBrushWidth(4)/2
      };
    })()\`)

    report.console = records.consoles.filter((text) => !/Content Security Policy|media-src|shutter|Autofill|DevTools/i.test(text))
    report.meta = await win.webContents.executeJavaScript('window.__brush.meta()')
    report.mosaic = mosaic
    report.gridPhase = gridPhase
    report.taps = taps
    report.highlight = highlight
    report.legacy = legacy
    report.edge = edge
    report.geometry = geometry
    report.ok = true
    win.destroy()
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
  }
  fs.writeFileSync(RESULT, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
}

app.whenReady().then(main, (error) => {
  fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: String(error && error.stack ? error.stack : error) }))
  app.exit(1)
})
`

test('brush plan §6.3: a real capture window inks the stroke, leaves the rest untouched and samples without a DPR offset', { timeout: 120000 }, () => {
  const probeDir = path.join(root, '.tmp', 'capture-brush-probe')
  const probePath = path.join(probeDir, 'probe.js')
  const resultPath = path.join(probeDir, 'result.json')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.rmSync(resultPath, { force: true })
  fs.writeFileSync(probePath, PROBE_SOURCE)

  // ELECTRON_RUN_AS_NODE would start Electron as plain node (see the sibling runtime test).
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '0',
    BRUSH_PROBE_ROOT: root,
    BRUSH_PROBE_RESULT: resultPath
  }
  delete env.ELECTRON_RUN_AS_NODE

  const result = spawnSync(require('electron'), [probePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    windowsHide: true,
    env
  })
  assert.equal(
    result.status,
    0,
    `brush render probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(fs.existsSync(resultPath), true, 'the probe did not write its result file')
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  assert.equal(report.ok, true, `probe error: ${report.error}`)
  assert.deepEqual(report.console, [], `the page must not log errors: ${JSON.stringify(report.console)}`)

  // 前提：截图位图是设备像素（source / CSS = SOURCE_SCALE）。若不是，下面的采样断言恒真。
  assert.ok(
    Math.abs(report.meta.sourceScale - SOURCE_SCALE) < 0.01,
    `the probe bitmap must really be ${SOURCE_SCALE}x the display area (got ${report.meta.sourceScale})`
  )
  assert.equal(report.meta.cell, 12, 'the mosaic cell is 12 CSS px')
  assert.equal(report.meta.brush, 24, 'the 4px preset maps to a 24px brush')

  // §6.3-1 本方案最核心的不变量：马赛克只改轨迹内，带外**一个像素都不动**。
  assert.ok(report.mosaic.inside > 0, `the stroke must change pixels inside its band (got ${report.mosaic.inside})`)
  assert.equal(report.mosaic.outside, 0, `the mosaic must not touch a single pixel outside the stroke (got ${report.mosaic.outside})`)
  // §6.3-2 像素化生效：一个 mosaic 格内的颜色种类必须是 1（严格按网格相位取样，绝不跨格）。
  assert.equal(report.mosaic.cellColors, 1, `a mosaic cell must be a flat colour (cell ${report.mosaic.cellDev} device px)`)

  // §7.2 网格相位锚定：两条重叠笔迹必须共用同一套格，重叠带里不能出现"砖缝"（格内多色）。
  // 这条必须用两笔 —— 单笔的相位永远自洽，只有相邻笔迹各自取相位才会错开。
  assert.ok(report.gridPhase.checkedCells > 0, `the grid-phase probe must sample real cells (got ${report.gridPhase.checkedCells})`)
  assert.equal(
    report.gridPhase.badCells,
    0,
    `overlapping strokes must share one cell grid: ${report.gridPhase.badCells}/${report.gridPhase.checkedCells} cells showed a seam`
  )

  // §6.3-5 单击落墨：两种笔刷都必须真的改变落点中心像素（只看 count 会被抗锯齿痕迹骗过）。
  assert.ok(report.taps.blurDot.pixelDiff > 0, `a mosaic tap must ink its centre pixel (got ${JSON.stringify(report.taps.blurDot)})`)
  assert.ok(report.taps.highlightDot.pixelDiff > 0, `a highlight tap must ink its centre pixel (got ${JSON.stringify(report.taps.highlightDot)})`)

  // §6.3-4 高亮只画在笔迹上：改变像素的 y 范围 ≈ ±highlightWidth/2（标称 ±8，容差 ±2）。
  assert.ok(report.highlight.count > 0, 'the highlight stroke must ink')
  const half = report.highlight.half
  assert.equal(half, 8)
  assert.ok(
    report.highlight.minY >= report.highlight.strokeMinY - half - 2 &&
      report.highlight.maxY <= report.highlight.strokeMaxY + half + 2,
    `the highlight band must stay within the brush (got ${report.highlight.minY}..${report.highlight.maxY})`
  )
  // 半透明：高亮必须让下面的底色透出来。alpha=1 时笔迹核心带会被笔色完全覆盖
  // （solidRatio ≈ 1）；半透明时底色参与混合，绝大多数核心像素**不等于**笔色。
  assert.ok(report.highlight.coreSamples > 0, 'the translucency probe must sample the stroke core')
  assert.ok(
    report.highlight.solidRatio < 0.5,
    `a translucent highlighter must let the content underneath show through (solidRatio ${report.highlight.solidRatio})`
  )

  // §6.3-6 旧标注兼容：无 points 的高亮仍是一条水平直线带，旧马赛克矩形仍然像素化。
  assert.ok(report.legacy.highlight.count > 0, 'a legacy highlight must still render')
  assert.ok(
    report.legacy.highlight.minY >= 560 - 8 - 2 && report.legacy.highlight.maxY <= 560 + 8 + 2,
    `a legacy highlight is still one straight band (got ${report.legacy.highlight.minY}..${report.legacy.highlight.maxY})`
  )
  assert.ok(report.legacy.blur.count > 0, 'a legacy mosaic block must still render')

  // §5.7-3 / §6.3-3 采样坐标没有 DPR 偏移：硬边位移必须在一个 cell 之内
  // （若真存在 dpr 级错位，这个差会是几十像素）。
  const shift = Math.abs(report.edge.after - report.edge.before)
  assert.ok(
    shift <= report.edge.cell,
    `the mosaic must sample where it paints: the hard edge moved ${shift}px, more than one ${report.edge.cell}px cell`
  )

  // 命中/包围盒：折线命中、bbox 空角落空、旧块整体可点、包围盒含笔刷半宽。
  assert.equal(report.geometry.onStroke, true)
  assert.equal(report.geometry.offStroke, false)
  assert.equal(report.geometry.legacyCenter, true)
  const bounds = report.geometry.bounds
  assert.equal(bounds.w, 200 + report.geometry.brushHalf * 2)
  assert.equal(bounds.h, 100 + report.geometry.brushHalf * 2)
})
