import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const LIMIT=16*1024*1024;
const formats=new Set(['image/jpeg','image/png','image/webp','image/gif']);
const audioFormats=new Set(['audio/wav','audio/mpeg','audio/mp4']);
const normalizedMime=value=>['audio/x-wav','audio/wave','audio/vnd.wave'].includes(value)?'audio/wav':value;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function imageType(bytes){
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))return 'image/gif';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  throw Error('The photo could not be loaded.');
}
function audioType(bytes){
  if(bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'&&bytes.readUInt32LE(4)+8<=bytes.length)return 'audio/wav';
  if(bytes.length>=16&&bytes.toString('ascii',4,8)==='ftyp'&&bytes.readUInt32BE(0)>=16&&bytes.readUInt32BE(0)<=bytes.length)return 'audio/mp4';
  let offset=0;
  if(bytes.length>=10&&bytes.toString('ascii',0,3)==='ID3'){
    if([...bytes.subarray(6,10)].some(n=>n>127))throw Error('The audio format could not be read.');
    offset=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9]);
    if(bytes[5]&16)offset+=10;
  }
  if(bytes.length>=offset+4&&bytes[offset]===255&&(bytes[offset+1]&224)===224&&(bytes[offset+1]&24)!==8&&(bytes[offset+1]&6)!==0&&(bytes[offset+2]>>4)!==0&&(bytes[offset+2]>>4)!==15&&(bytes[offset+2]&12)!==12)return 'audio/mpeg';
  throw Error('The audio format could not be read.');
}
const mediaType=(bytes,type)=>type==='audio'?audioType(bytes):imageType(bytes);
const cacheSuffix=row=>row.type==='audio'?'.audio':'.image';

// The client receives only opaque, authenticated SAI URLs. The bearer token is
// used against the fixed loopback gateway, never sent to a phone or another host.
export async function createMessageMediaStore({directory,getToken,sessionKey='agent:samantha:main',fetchImpl=fetch}) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const manifest=path.join(directory,'index.json');let saved=[];
  try{saved=JSON.parse(await fs.readFile(manifest,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const records=new Map(saved.map(row=>[row.id,row])),downloads=new Map();let writes=Promise.resolve();
  const validReference=url=>{
    if(typeof url!=='string')return false;
    const match=url.match(/^\/api\/chat\/media\/outgoing\/([^/]+)\/([a-f0-9-]{36})\/full$/);
    try{return !!match&&decodeURIComponent(match[1])===sessionKey&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(match[2]);}catch{return false;}
  };
  // Photos sent from the phone live only in this store; their reference names
  // the upload rather than a gateway artifact.
  const uploadReference=url=>typeof url==='string'&&/^upload:[a-f0-9]{64}$/.test(url);
  const persist=()=>{const next=writes.catch(()=>{}).then(async()=>{
    const temp=manifest+'.'+crypto.randomUUID()+'.tmp';
    try{await fs.writeFile(temp,JSON.stringify([...records.values()]),{mode:0o600});await fs.rename(temp,manifest);}finally{await fs.rm(temp,{force:true});}
  });writes=next;return next;};
  const publicMedia=r=>({type:r.type??'image',id:r.id,url:'/api/media/'+r.id,alt:r.alt,mimeType:r.mimeType,...(r.type==='audio'?{fileName:r.fileName}:{width:r.width,height:r.height})});
  const UPLOAD_LIMIT=1500000;
  // A photo chosen on the phone: validated bytes, written once, owned by the
  // paired device that sent it. Returns the same public shape as received media.
  async function addUpload({bytes,owner,width,height,alt='Photo from Owner',fileName}){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>UPLOAD_LIMIT)throw Error('The photo is too large. Try a smaller one.');
    const mimeType=imageType(bytes);
    if(!formats.has(mimeType)||mimeType==='image/gif')throw Error('Use a JPEG, PNG or WebP photo.');
    if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=8192))throw Error('The photo size could not be read.');
    const id=digest(bytes);
    const file=path.join(directory,id+'.image');
    const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes,{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
    const row={id,reference:'upload:'+id,alt:String(alt).slice(0,200),mimeType,width,height,owner:String(owner),sizeBytes:bytes.length,fileName:typeof fileName==='string'?fileName.slice(0,120):'photo.jpg',uploadedAt:Date.now()};
    records.set(id,row);await persist();
    return publicMedia(row);
  }
  function uploaded(id,owner){
    const row=records.get(id);
    return row&&uploadReference(row.reference)&&row.owner===String(owner)?publicMedia(row):null;
  }
  // The gateway attachment for a sent photo: pixels inline, the same shape the
  // personal-message stream uses for iMessage pictures.
  async function attachment(id){
    const row=records.get(id);if(!row||!uploadReference(row.reference))return null;
    const bytes=await fs.readFile(path.join(directory,id+'.image'));
    return {type:'image',mimeType:row.mimeType,fileName:row.fileName,content:bytes.toString('base64'),sizeBytes:bytes.length};
  }
  async function register(items=[]){
    const result=[];let changed=false;
    for(const item of items.slice(0,12)){
      const mimeType=normalizedMime(item.mimeType),isAudio=item.type==='audio';
      if(!['image','audio'].includes(item.type)||!validReference(item.url)||!(isAudio?audioFormats:formats).has(mimeType))continue;
      if(!isAudio){const dimensions=[item.width,item.height];if(!dimensions.every(n=>Number.isInteger(n)&&n>0&&n<=32768)||item.width*item.height>96000000)continue;}
      if(Number.isFinite(item.sizeBytes)&&(item.sizeBytes<=0||item.sizeBytes>LIMIT))continue;
      const id=digest(item.url),row={id,reference:item.url,alt:typeof item.alt==='string'?item.alt.slice(0,200):isAudio?'Audio from Samantha':'Photo from Samantha',mimeType,...(isAudio?{type:'audio',fileName:typeof item.fileName==='string'?item.fileName.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f]/g,'').slice(0,120):'Audio from Samantha'}:{width:item.width,height:item.height})};
      if(JSON.stringify(records.get(id))!==JSON.stringify(row)){records.set(id,row);changed=true;}
      result.push(publicMedia(row));
    }
    if(changed)await persist();return result;
  }
  async function prepare(messages){
    return Promise.all(messages.map(async m=>{
      if(!m.media?.length)return m;
      const media=await register(m.media);const copy={...m};delete copy.media;
      return media.length?{...copy,media}:copy;
    }));
  }
  async function load(id){
    const row=records.get(id);if(!/^[a-f0-9]{64}$/.test(id)||!row||!(validReference(row.reference)||uploadReference(row.reference)))return null;
    const file=path.join(directory,id+cacheSuffix(row));let bytes;
    try{bytes=await fs.readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!bytes&&uploadReference(row.reference))return null;
    if(!bytes){
      const response=await fetchImpl('http://127.0.0.1:18789'+row.reference,{headers:{Authorization:'Bearer '+await getToken()},redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error('The media is temporarily unavailable.');
      if(Number(response.headers.get('content-length'))>LIMIT){await response.body?.cancel();throw Error('The media is too large to display.');}
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>LIMIT)throw Error('The media is too large to display.');chunks.push(Buffer.from(chunk));}
      bytes=Buffer.concat(chunks);
      if(mediaType(bytes,row.type)!==row.mimeType)throw Error('The media format could not be read.');
      const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes,{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
    }
    const mimeType=mediaType(bytes,row.type);if(mimeType!==row.mimeType)throw Error('The media format could not be read.');
    return {bytes,mimeType,etag:'"'+digest(bytes)+'"'};
  }
  return {register,prepare,addUpload,uploaded,attachment,async get(id){if(!downloads.has(id))downloads.set(id,load(id).finally(()=>downloads.delete(id)));return downloads.get(id);}};
}
