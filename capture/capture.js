const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const toolbar = document.getElementById('toolbar')
const sizeBadge = document.getElementById('sizeBadge')
const tip = document.getElementById('tip')
const loading = document.getElementById('loading')
const colorInput = document.getElementById('color')
const colorPreview = document.querySelector('.color-wrap span')
const lineWidthInput = document.getElementById('lineWidth')
const resultPanel = document.getElementById('resultPanel')
const resultTitle = document.getElementById('resultTitle')
const resultSource = document.getElementById('resultSource')
const resultText = document.getElementById('resultText')

let initData = null
let image = null
let selection = null
let selecting = false
let dragging = false
let startPoint = null
let currentTool = 'select'
let activeAnnotation = null
let annotations = []
let redoStack = []
let serialNumber = 1
let dpr = window.devicePixelRatio || 1
let autoActionStarted = false
let renderReadySent = false
let renderReadyPending = false
let selectState = 'manual'
let pointerDownPoint = null
let smartCandidates = []
let smartCandidateLevel = 0
let smartQueryRunning = false
let smartQueryPending = null

function pointFromEvent(event) { return { x: event.clientX, y: event.clientY } }
function normalizeRect(a, b) { return { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), w: Math.abs(b.x-a.x), h: Math.abs(b.y-a.y) } }
function insideSelection(point) { return selection && point.x >= selection.x && point.x <= selection.x + selection.w && point.y >= selection.y && point.y <= selection.y + selection.h }
function annotationStyle() { return { color: colorInput.value, width: Number(lineWidthInput.value) || 4 } }

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(innerWidth * dpr)
  canvas.height = Math.round(innerHeight * dpr)
  canvas.style.width = `${innerWidth}px`
  canvas.style.height = `${innerHeight}px`
  if (image && initData && ['fullscreen', 'image', 'canvas'].includes(initData.mode)) {
    selection = { x: 0, y: 0, w: innerWidth, h: innerHeight }
  }
  render()
  maybeRunAutoAction()
  reportRenderReady()
}

function reportRenderReady() {
  if (renderReadySent || renderReadyPending || !image?.complete || !image.naturalWidth || !initData) return
  const expected = initData.captureBounds || initData.displayBounds
  if (expected && (Math.abs(innerWidth - expected.width) > 2 || Math.abs(innerHeight - expected.height) > 2)) return
  renderReadyPending = true
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (renderReadySent || !image?.complete || !image.naturalWidth) {
      renderReadyPending = false
      return
    }
    renderReadySent = true
    renderReadyPending = false
    window.captureAPI.renderReady()
  }))
}

function maybeRunAutoAction() {
  if (!image || !selection || !initData?.autoAction || autoActionStarted) return
  if (['fullscreen', 'image', 'canvas'].includes(initData.mode)) {
    const expected = initData.captureBounds || initData.displayBounds
    if (expected && (Math.abs(innerWidth - expected.width) > 2 || Math.abs(innerHeight - expected.height) > 2)) return
    autoActionStarted = true
    setTimeout(() => performAction(initData.autoAction), 120)
  }
}

function drawArrow(context, x1, y1, x2, y2, width) {
  const angle = Math.atan2(y2-y1,x2-x1)
  const head = Math.max(10,width*3)
  context.beginPath(); context.moveTo(x1,y1); context.lineTo(x2,y2); context.stroke()
  context.beginPath(); context.moveTo(x2,y2); context.lineTo(x2-head*Math.cos(angle-Math.PI/6),y2-head*Math.sin(angle-Math.PI/6)); context.lineTo(x2-head*Math.cos(angle+Math.PI/6),y2-head*Math.sin(angle+Math.PI/6)); context.closePath(); context.fill()
}

function drawAnnotation(context, item, scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0, sourceImage = image) {
  const x = (item.x-offsetX)*scaleX, y = (item.y-offsetY)*scaleY
  const x2 = ((item.x2 ?? item.x)-offsetX)*scaleX, y2 = ((item.y2 ?? item.y)-offsetY)*scaleY
  const width = item.width * Math.max(scaleX,scaleY)
  context.save(); context.strokeStyle = item.color; context.fillStyle = item.color; context.lineWidth = width; context.lineCap = 'round'; context.lineJoin = 'round'
  if (item.type === 'rect') context.strokeRect(x,y,(item.x2-item.x)*scaleX,(item.y2-item.y)*scaleY)
  if (item.type === 'ellipse') { context.beginPath(); context.ellipse((x+x2)/2,(y+y2)/2,Math.abs(x2-x)/2,Math.abs(y2-y)/2,0,0,Math.PI*2); context.stroke() }
  if (item.type === 'line') { context.beginPath(); context.moveTo(x,y); context.lineTo(x2,y2); context.stroke() }
  if (item.type === 'arrow') drawArrow(context,x,y,x2,y2,width)
  if (item.type === 'pen') { context.beginPath(); item.points.forEach((point,index) => { const px=(point.x-offsetX)*scaleX, py=(point.y-offsetY)*scaleY; index?context.lineTo(px,py):context.moveTo(px,py) }); context.stroke() }
  if (item.type === 'highlight') { context.globalAlpha=.28; context.lineWidth=Math.max(14,width*4); context.beginPath(); context.moveTo(x,y); context.lineTo(x2,y2); context.stroke() }
  if (item.type === 'text') { context.font = `${Math.max(14,width*5)}px -apple-system,"Microsoft YaHei",sans-serif`; context.textBaseline='top'; context.fillText(item.text,x,y) }
  if (item.type === 'serial') { const radius=Math.max(12,width*3); context.beginPath(); context.arc(x,y,radius,0,Math.PI*2); context.fill(); context.fillStyle='#fff'; context.font=`bold ${radius}px sans-serif`; context.textAlign='center'; context.textBaseline='middle'; context.fillText(String(item.number),x,y+1) }
  if (item.type === 'blur' && sourceImage) {
    const left=Math.min(x,x2), top=Math.min(y,y2), w=Math.abs(x2-x), h=Math.abs(y2-y)
    if (w>2&&h>2) { const tiny=document.createElement('canvas'); tiny.width=Math.max(1,Math.round(w/12)); tiny.height=Math.max(1,Math.round(h/12)); const t=tiny.getContext('2d'); const sourceScaleX=sourceImage.naturalWidth/innerWidth, sourceScaleY=sourceImage.naturalHeight/innerHeight; t.drawImage(sourceImage,Math.min(item.x,item.x2)*sourceScaleX,Math.min(item.y,item.y2)*sourceScaleY,Math.abs(item.x2-item.x)*sourceScaleX,Math.abs(item.y2-item.y)*sourceScaleY,0,0,tiny.width,tiny.height); context.imageSmoothingEnabled=false; context.drawImage(tiny,left,top,w,h); context.imageSmoothingEnabled=true }
  }
  context.restore()
}

function render() {
  if (!image) return
  ctx.setTransform(dpr,0,0,dpr,0,0)
  ctx.clearRect(0,0,innerWidth,innerHeight)
  ctx.drawImage(image,0,0,innerWidth,innerHeight)
  if (!selection) {
    ctx.fillStyle = initData?.settings?.screenshot?.selectionMask || 'rgba(0,0,0,.46)'
    ctx.fillRect(0,0,innerWidth,innerHeight)
    return
  }
  ctx.save(); ctx.fillStyle=initData?.settings?.screenshot?.selectionMask||'rgba(0,0,0,.46)'; ctx.beginPath(); ctx.rect(0,0,innerWidth,innerHeight); ctx.rect(selection.x,selection.y,selection.w,selection.h); ctx.fill('evenodd'); ctx.restore()
  ctx.save(); ctx.strokeStyle='#36a3ff'; ctx.lineWidth=1; ctx.setLineDash([4,3]); ctx.strokeRect(selection.x+.5,selection.y+.5,selection.w,selection.h); ctx.restore()
  annotations.forEach((item) => drawAnnotation(ctx,item))
  if (activeAnnotation) drawAnnotation(ctx,activeAnnotation)
  drawHandles()
  updateFloatingUi()
}

function drawHandles() {
  if (!selection || currentTool !== 'select') return
  const points=[[selection.x,selection.y],[selection.x+selection.w/2,selection.y],[selection.x+selection.w,selection.y],[selection.x,selection.y+selection.h/2],[selection.x+selection.w,selection.y+selection.h/2],[selection.x,selection.y+selection.h],[selection.x+selection.w/2,selection.y+selection.h],[selection.x+selection.w,selection.y+selection.h]]
  ctx.save(); ctx.fillStyle='#fff'; ctx.strokeStyle='#1677ff'; ctx.lineWidth=1; points.forEach(([x,y])=>{ctx.fillRect(x-3,y-3,6,6);ctx.strokeRect(x-3,y-3,6,6)}); ctx.restore()
}

function updateFloatingUi() {
  if (!selection || selection.w<2 || selection.h<2) { toolbar.classList.add('hidden'); sizeBadge.style.display='none'; return }
  sizeBadge.style.display='block'; sizeBadge.textContent=`${Math.round(selection.w)} × ${Math.round(selection.h)}`; sizeBadge.style.left=`${Math.max(4,selection.x)}px`; sizeBadge.style.top=`${Math.max(4,selection.y-27)}px`
  if (selectState==='auto') { toolbar.classList.add('hidden'); return }
  toolbar.classList.remove('hidden')
  const rect=toolbar.getBoundingClientRect(); let left=selection.x+selection.w-rect.width; let top=selection.y+selection.h+10
  if (top+rect.height>innerHeight-6) top=selection.y-rect.height-10
  left=Math.max(6,Math.min(left,innerWidth-rect.width-6)); top=Math.max(6,top)
  toolbar.style.left=`${left}px`; toolbar.style.top=`${top}px`
}

function setTool(tool) {
  currentTool=tool
  document.querySelectorAll('[data-tool]').forEach((button)=>button.classList.toggle('active',button.dataset.tool===tool))
  canvas.style.cursor=tool==='select'?'default':'crosshair'
}

function commitAnnotation(item) {
  if (!item) return
  annotations.push(item); redoStack=[]; activeAnnotation=null; render()
}

function finishSelection() {
  render()
  if(selection&&initData?.autoAction&&!autoActionStarted){autoActionStarted=true;setTimeout(()=>performAction(initData.autoAction),80)}
}

function applySmartCandidates(candidates) {
  smartCandidates=(Array.isArray(candidates)?candidates:[]).filter((item)=>item&&item.w>=3&&item.h>=3)
  smartCandidateLevel=0
  selection=smartCandidates.length?{...smartCandidates[0]}:null
  render()
}

async function requestSmartSelection(point) {
  if(selectState!=='auto'||!initData?.smartSelect)return
  smartQueryPending={x:point.x,y:point.y}
  if(smartQueryRunning)return
  smartQueryRunning=true
  try{
    while(smartQueryPending){
      const current=smartQueryPending;smartQueryPending=null
      try{
        const candidates=await window.captureAPI.smartSelectAt(current)
        if(selectState==='auto'&&!smartQueryPending)applySmartCandidates(candidates)
      }catch{}
    }
  }finally{smartQueryRunning=false}
}

canvas.addEventListener('pointerdown',(event)=>{
  if (!resultPanel.classList.contains('hidden')) return
  const point=pointFromEvent(event); startPoint=point
  if(selectState==='auto'){pointerDownPoint=point;return}
  if (!selection || (currentTool==='select'&&!insideSelection(point))) { selectState='manual';selecting=true; selection={x:point.x,y:point.y,w:0,h:0}; annotations=[]; redoStack=[]; tip.style.display='none'; render(); return }
  if (currentTool==='select') { dragging=true; return }
  if (!insideSelection(point)) return
  const style=annotationStyle()
  if (currentTool==='text') { const text=prompt('输入文字'); if(text)commitAnnotation({type:'text',x:point.x,y:point.y,text,...style}); return }
  if (currentTool==='serial') { commitAnnotation({type:'serial',x:point.x,y:point.y,number:serialNumber++,...style}); return }
  activeAnnotation={type:currentTool,x:point.x,y:point.y,x2:point.x,y2:point.y,...style}
  if (currentTool==='pen') activeAnnotation.points=[point]
})

canvas.addEventListener('pointermove',(event)=>{
  const point=pointFromEvent(event)
  if(selectState==='auto'){
    if(pointerDownPoint){
      if(Math.hypot(point.x-pointerDownPoint.x,point.y-pointerDownPoint.y)>6){selectState='manual';selecting=true;startPoint=pointerDownPoint;pointerDownPoint=null;selection=normalizeRect(startPoint,point);annotations=[];redoStack=[];smartCandidates=[];tip.style.display='none';render()}
    }else requestSmartSelection(point)
    return
  }
  if (selecting) { selection=normalizeRect(startPoint,point); render(); return }
  if (dragging&&selection) { const dx=point.x-startPoint.x,dy=point.y-startPoint.y; selection.x=Math.max(0,Math.min(innerWidth-selection.w,selection.x+dx)); selection.y=Math.max(0,Math.min(innerHeight-selection.h,selection.y+dy)); startPoint=point; render(); return }
  if (activeAnnotation) { activeAnnotation.x2=point.x; activeAnnotation.y2=point.y; if(activeAnnotation.type==='pen')activeAnnotation.points.push(point); render() }
})

canvas.addEventListener('pointerup',(event)=>{
  if(selectState==='auto'&&pointerDownPoint){const point=pointFromEvent(event);const moved=Math.hypot(point.x-pointerDownPoint.x,point.y-pointerDownPoint.y)>6;pointerDownPoint=null;if(moved){selectState='selected';selection=normalizeRect(startPoint,point);if(selection.w<3||selection.h<3)selection=null}else if(selection){selectState='selected'}tip.style.display='none';finishSelection();return}
  if(selecting){selecting=false;if(selection.w<3||selection.h<3)selection=null;selectState=selection?'selected':'manual';finishSelection();return}
  if(dragging){dragging=false;render();return}
  if(activeAnnotation)commitAnnotation(activeAnnotation)
})

canvas.addEventListener('wheel',(event)=>{
  if(selectState!=='auto'||smartCandidates.length<2)return
  event.preventDefault()
  const delta=event.deltaY<0?1:-1
  smartCandidateLevel=Math.max(0,Math.min(smartCandidates.length-1,smartCandidateLevel+delta))
  selection={...smartCandidates[smartCandidateLevel]}
  render()
},{passive:false})

canvas.addEventListener('dblclick',()=>{ if(selection&&initData?.settings?.screenshot?.doubleClickCopy) performAction('copy') })

function exportSelectionCanvas() {
  if (!selection) return null
  const scaleX=image.naturalWidth/innerWidth, scaleY=image.naturalHeight/innerHeight
  const output=document.createElement('canvas'); output.width=Math.max(1,Math.round(selection.w*scaleX)); output.height=Math.max(1,Math.round(selection.h*scaleY))
  const out=output.getContext('2d'); out.drawImage(image,selection.x*scaleX,selection.y*scaleY,selection.w*scaleX,selection.h*scaleY,0,0,output.width,output.height)
  annotations.forEach((item)=>drawAnnotation(out,item,scaleX,scaleY,selection.x,selection.y,image))
  return output
}

async function performAction(action) {
  const output=exportSelectionCanvas(); if(!output)return
  const dataUrl=output.toDataURL('image/png'); const captureBounds=initData.captureBounds||initData.displayBounds||{x:0,y:0}; const meta={source:initData.source,width:output.width,height:output.height,scaleFactor:initData.scaleFactor,selectionBounds:{x:Math.round(captureBounds.x+selection.x),y:Math.round(captureBounds.y+selection.y),width:Math.max(1,Math.round(selection.w)),height:Math.max(1,Math.round(selection.h))}}
  try {
    if(action==='copy'){if(initData.editPin)await window.captureAPI.pin(dataUrl,meta);else await window.captureAPI.copy(dataUrl,meta);window.captureAPI.close()}
    if(action==='save'){const saved=await window.captureAPI.save(dataUrl,meta,!!initData.settings.screenshot.fastSave);if(saved)window.captureAPI.close()}
    if(action==='pin'){await window.captureAPI.pin(dataUrl,meta);window.captureAPI.close()}
    if(action==='ocr'||action==='translate'){loading.classList.remove('hidden'); const result=action==='ocr'?await window.captureAPI.ocr(dataUrl):await window.captureAPI.translate(dataUrl); loading.classList.add('hidden'); showResult(action,result); if(initData.autoAction===action)initData.autoAction=''}
  } catch(error){loading.classList.add('hidden');alert(error.message||String(error))}
}

function showResult(type,result) {
  resultPanel.classList.remove('hidden'); resultSource.classList.toggle('hidden',type!=='translate'); resultTitle.textContent=type==='translate'?'截图翻译':'文本识别';
  if(type==='translate'){resultSource.textContent=result.text||'';resultText.value=result.translation||''}else{resultSource.textContent='';resultText.value=result||''}
}

async function scanQr() {
  const output=exportSelectionCanvas(); if(!output)return
  const data=output.getContext('2d').getImageData(0,0,output.width,output.height); const result=window.jsQR?window.jsQR(data.data,data.width,data.height):null
  if(!result)return alert('未识别到二维码')
  showResult('ocr',result.data); resultTitle.textContent='二维码识别'
}

document.querySelectorAll('[data-tool]').forEach((button)=>button.addEventListener('click',()=>setTool(button.dataset.tool)))
colorInput.addEventListener('input',()=>{colorPreview.style.background=colorInput.value})
document.getElementById('undo').onclick=()=>{const item=annotations.pop();if(item)redoStack.push(item);render()}
document.getElementById('redo').onclick=()=>{const item=redoStack.pop();if(item)annotations.push(item);render()}
document.getElementById('copy').onclick=()=>performAction('copy')
document.getElementById('save').onclick=()=>performAction('save')
document.getElementById('pin').onclick=()=>performAction('pin')
document.getElementById('ocr').onclick=()=>performAction('ocr')
document.getElementById('translate').onclick=()=>performAction('translate')
document.getElementById('qr').onclick=scanQr
document.getElementById('close').onclick=()=>window.captureAPI.close()
document.getElementById('resultClose').onclick=document.getElementById('resultDone').onclick=()=>resultPanel.classList.add('hidden')
document.getElementById('resultCopy').onclick=async()=>{await navigator.clipboard.writeText(resultText.value);document.getElementById('resultCopy').textContent='已复制';setTimeout(()=>document.getElementById('resultCopy').textContent='复制文本',1000)}

addEventListener('keydown',(event)=>{
  if(event.key==='Escape'){if(!resultPanel.classList.contains('hidden'))resultPanel.classList.add('hidden');else window.captureAPI.close()}
  if(event.key==='Enter'&&!event.ctrlKey)performAction('copy')
  if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();performAction('save')}
  if(event.ctrlKey&&event.key.toLowerCase()==='z'){event.preventDefault();document.getElementById('undo').click()}
  if(event.ctrlKey&&event.key.toLowerCase()==='y'){event.preventDefault();document.getElementById('redo').click()}
  if(event.key==='Delete'&&annotations.length){annotations.pop();render()}
})

window.captureAPI.onInit((data)=>{
  initData=data; renderReadySent=false; renderReadyPending=false; selectState=data.smartSelect&&data.mode==='region'?'auto':'manual'; pointerDownPoint=null; smartCandidates=[]; smartCandidateLevel=0; document.documentElement.style.setProperty('--primary',data.settings.mainColor||'#1677ff')
  image=new Image(); image.onload=()=>{if(data.mode==='fullscreen'||data.mode==='image'||data.mode==='canvas')tip.style.display='none';resizeCanvas();if(selectState==='auto'&&data.cursorPosition)requestSmartSelection(data.cursorPosition);maybeRunAutoAction()}; image.onerror=()=>window.captureAPI.renderError('截图图片解码失败'); image.src=data.mode==='canvas'?makeBlankCanvas():data.imageDataUrl
})

function makeBlankCanvas(){const blank=document.createElement('canvas');blank.width=Math.max(1,innerWidth*dpr);blank.height=Math.max(1,innerHeight*dpr);const c=blank.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,blank.width,blank.height);return blank.toDataURL()}
addEventListener('resize',resizeCanvas)
window.captureAPI.ready()
