import fs from 'node:fs/promises';import http2 from 'node:http2';import {sign} from 'node:crypto';
const b64=b=>Buffer.from(b).toString('base64url');
export function pushJWT({teamId,keyId,key,now=Date.now()}){if(!/^[A-Z0-9]{10}$/.test(teamId)||!/^[A-Z0-9]{10}$/.test(keyId))throw Error('Invalid Apple push signing identity');const payload=b64(JSON.stringify({alg:'ES256',kid:keyId}))+'.'+b64(JSON.stringify({iss:teamId,iat:Math.floor(now/1000)}));return payload+'.'+sign('sha256',Buffer.from(payload),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');}
export function createIncomingPush({readConfig,connect=http2.connect,now=Date.now,kind='voip'}){
 async function config(){const c=await readConfig();if(!c?.keyPath||!c.keyId||!c.teamId)return null;return c;}
 return {async status(){try{const c=await config();if(!c)return {ready:false,reason:'apple-push-not-configured'};await fs.access(c.keyPath);return {ready:true};}catch{return {ready:false,reason:'apple-push-key-unavailable'};}},
 async send(device,invitation){
  const c=await config();if(!c)throw Object.assign(Error('Apple push is not configured'),{definite:true});const key=await fs.readFile(c.keyPath);const jwt=pushJWT({...c,key,now:now()});
  const token=device.pushToken;if(!/^[a-f0-9]{64,200}$/i.test(token))throw Object.assign(Error('Invalid push token'),{definite:true});
  const endpoint=device.environment==='production'?'https://api.push.apple.com':'https://api.sandbox.push.apple.com';
  return new Promise(resolve=>{
   let settled=false,session,request,responseStatus=0,body='';const finish=r=>{if(settled)return;settled=true;clearTimeout(timer);request?.close();session?.close();resolve(r);};
   const timer=setTimeout(()=>finish({status:'uncertain',reason:'push-connection-timeout'}),10000);
   try{session=connect(endpoint);session.on('error',()=>finish({status:'uncertain',reason:'push-connection-error'}));request=session.request({':method':'POST',':path':'/3/device/'+token,authorization:'bearer '+jwt,'apns-topic':(c.bundleId??'dev.example.sai.mobile')+(kind==='alert'?'':'.voip'),'apns-push-type':kind,'apns-priority':'10','apns-expiration':kind==='alert'?String(Math.floor(now()/1000)+3600):'0','apns-id':invitation.id});request.on('response',h=>responseStatus=Number(h[':status']));request.on('data',b=>body+=b);request.on('error',()=>finish({status:'uncertain',reason:'push-request-error'}));request.on('end',()=>{let reason;try{reason=JSON.parse(body).reason;}catch{}finish(responseStatus===200?{status:'accepted'}:{status:'rejected',code:responseStatus,reason:reason??'push-rejected',invalidToken:responseStatus===410||reason==='BadDeviceToken'});});request.end(JSON.stringify(kind==='alert'?{aps:{alert:{title:invitation.title??'Samantha',body:String(invitation.body??'').slice(0,500)},sound:'default','thread-id':'samantha-messages'},saiMessageId:invitation.messageId??null}:{aps:{},callId:invitation.id,callerName:'Samantha',expiresAt:invitation.expiresAt,mode:'eleven'}));}catch{finish({status:'uncertain',reason:'push-transport-error'});}
  });
 }};
}
