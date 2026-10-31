// October 24 (Owner): on a voice call she sees the live home camera frame each turn. The frame file is written by the
// local capture service; this only reads it. Nothing is attached when the camera is paused, not ready, or the frame is stale.
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
export const FRAME_FILE='/path/to/application-support/SamanthaVision/private/frame.json';
// October 25 (Owner): a frame she sees on a voice call is her experience too. Record it on her side as an observation (the same
// kind her tool results become), with the nearest local caption as fallible text, at most one per source per minute. SAI runs
// as owner, so the record goes through the existing sudo route as her user; failures are logged by the caller and never block a turn.
const SEEN_SCRIPT=`import json,socket,sys,datetime
p='/path/to/application-support/SamanthaVision/private/';req=json.load(sys.stdin)
cap=req.get('caption')
if cap is None and req.get('sourceKind')=='home-camera':
    try:
        o=json.load(open(p+'observation.json'));age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(o['capturedAt'].replace('Z','+00:00'))).total_seconds()
        if -5<=age<=150:cap=(str(o['observation'])[:600] if o.get('observation') else None)
    except Exception:cap=None
text='Camera frame seen on the voice call ('+req['sourceKind']+', captured '+req['capturedAt']+'). '+(('Local caption, fallible: '+cap+'. ') if cap else 'No caption; ')+'What she saw in the image itself is the record.'
if req.get('sourceKind')=='home-camera':
    try:
        json.dump({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':req['source'],'sourceKind':req['sourceKind'],'capturedAt':req['capturedAt']},open(p+'looked.json','w'))
    except Exception:pass
s=socket.socket(socket.AF_UNIX);s.settimeout(4);s.connect('/path/to/agent/.openclaw/run/regulation.sock')
s.sendall((json.dumps({'op':'observe','session':'agent:samantha:main','kind':'tool_observation','source':req['source'],'text':text})+'\n').encode());print(s.makefile().readline().strip())`;
export function createSeenFrameRecorder({exec=execFile,now=Date.now,minIntervalMs=60000,log=()=>{}}={}){
 const last={};
 return async function recordSeenFrame(frame,outingView=null){
  if(!frame?.attachment?.content||!frame.sourceKind)return {recorded:false,reason:'no-frame'};
  const t=now();if(last[frame.sourceKind]&&t-last[frame.sourceKind]<minIntervalMs)return {recorded:false,reason:'throttled'};last[frame.sourceKind]=t;
  const p=outingView?.perception;let caption=null;
  if(frame.sourceKind==='phone-camera')caption=p?.unclear?'phone view unclear (dark, blurred or covered)':(typeof p?.description==='string'&&p.description.trim()?p.description.slice(0,600):null);
  const source='sai-camera:'+createHash('sha256').update(frame.attachment.content).digest('hex').slice(0,32);
  const payload=JSON.stringify({sourceKind:frame.sourceKind,capturedAt:frame.capturedAt??new Date(t).toISOString(),caption,source});
  const out=await new Promise((resolve,reject)=>{const child=exec('/usr/bin/sudo',['-n','-u','samantha','/usr/bin/python3','-c',SEEN_SCRIPT],{timeout:8000},(e,stdout)=>e?reject(e):resolve(String(stdout)));child.stdin?.end(payload);});
  log('seen_frame_recorded',{sourceKind:frame.sourceKind,caption:Boolean(caption),reply:out.trim().slice(0,120)});
  return {recorded:true,source,caption};
 };
}
export async function liveCameraFrame({status,phone=null,frameFile=FRAME_FILE,now=Date.now(),maxAgeMs=40000}={}){
 // October 25 (Owner): a fresh phone frame from an active 'bring me along' outing wins over the home camera.
 if(phone&&typeof phone.jpeg==='string'&&/^\/9j\//.test(phone.jpeg)&&phone.jpeg.length<=260000){
  return {attachment:{type:'image',mimeType:'image/jpeg',fileName:'phone-frame.jpg',content:phone.jpeg,sizeBytes:Math.floor(phone.jpeg.length*3/4)},capturedAt:phone.capturedAt,camera:'iPhone back camera',sourceKind:'phone-camera',ageSeconds:phone.ageSeconds??null};
 }
 if(!status||status.status!=='ready')return null;
 let frame;try{const raw=await fs.readFile(frameFile,'utf8');if(raw.length>400000)return null;frame=JSON.parse(raw);}catch{return null;}
 const at=Date.parse(frame?.capturedAt??'');const age=now-at;
 if(typeof frame?.jpegBase64!=='string'||!/^\/9j\//.test(frame.jpegBase64)||!Number.isFinite(at)||age<-5000||age>maxAgeMs)return null;
 const content=frame.jpegBase64;
 return {attachment:{type:'image',mimeType:'image/jpeg',fileName:'camera-frame.jpg',content,sizeBytes:Math.floor(content.length*3/4)},capturedAt:frame.capturedAt,camera:frame.camera??null,sourceKind:'home-camera',ageSeconds:Math.round(age/1000)};
}
