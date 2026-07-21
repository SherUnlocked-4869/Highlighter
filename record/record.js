const bar=document.getElementById('bar'),timeEl=document.getElementById('time'),label=document.getElementById('label'),pauseButton=document.getElementById('pause')
let recorder=null,stream=null,chunks=[],startedAt=0,timer=null,cancelled=false,pausedAt=0,pausedTotal=0
function renderTime(){const elapsed=Math.max(0,Date.now()-startedAt-pausedTotal-(pausedAt?Date.now()-pausedAt:0));const seconds=Math.floor(elapsed/1000);timeEl.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`}
async function start(data){
  try{
    const video=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:data.sourceId,minFrameRate:data.settings.frameRate||24,maxFrameRate:data.settings.frameRate||24}}})
    stream=video
    if(data.settings.includeMicrophone){try{const mic=await navigator.mediaDevices.getUserMedia({audio:true,video:false});mic.getAudioTracks().forEach(track=>stream.addTrack(track))}catch(error){label.textContent='麦克风不可用，继续录制画面'}}
    const types=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];const mimeType=types.find(type=>MediaRecorder.isTypeSupported(type))||''
    recorder=new MediaRecorder(stream,mimeType?{mimeType,videoBitsPerSecond:8_000_000}:undefined)
    recorder.ondataavailable=event=>{if(event.data&&event.data.size)chunks.push(event.data)}
    recorder.onstop=async()=>{clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());if(cancelled){window.recordAPI.close();return}label.textContent='正在保存…';const blob=new Blob(chunks,{type:recorder.mimeType||'video/webm'});const file=await window.recordAPI.save(await blob.arrayBuffer(),blob.type);label.textContent=file?'已保存':'已取消保存';setTimeout(()=>window.recordAPI.close(),file?700:100)}
    recorder.start(1000);startedAt=Date.now();timer=setInterval(renderTime,250);label.textContent='屏幕录制中';renderTime()
  }catch(error){label.textContent=`录制失败：${error.message}`;setTimeout(()=>window.recordAPI.close(),2200)}
}
pauseButton.onclick=()=>{if(!recorder)return;if(recorder.state==='recording'){recorder.pause();pausedAt=Date.now();bar.classList.add('paused');pauseButton.textContent='继续';label.textContent='录制已暂停'}else if(recorder.state==='paused'){recorder.resume();pausedTotal+=Date.now()-pausedAt;pausedAt=0;bar.classList.remove('paused');pauseButton.textContent='暂停';label.textContent='屏幕录制中'}}
document.getElementById('stop').onclick=()=>{if(recorder&&recorder.state!=='inactive')recorder.stop()}
document.getElementById('cancel').onclick=()=>{cancelled=true;if(recorder&&recorder.state!=='inactive')recorder.stop();else window.recordAPI.close()}
window.recordAPI.onInit(start);window.recordAPI.ready()
