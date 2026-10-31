import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export const COOKIE_SECONDS=400*24*60*60;
const DAY=86400000,LOCAL_TTL=30*DAY;

// Paired devices remain paired until explicitly revoked. Local health checks
// must never create or evict device credentials. Serialize writes so concurrent
// requests cannot replace a newer registry with an older snapshot.
export async function sessionStore(file,{now=Date.now}={}){
 let rows=[];try{rows=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const entries=new Map(rows.map(v=>typeof v==='string'?[v,{token:v,expires:now()+LOCAL_TTL,kind:'legacy'}]:[v.token,{...v,kind:v.kind||'legacy'}]));
 let queue=Promise.resolve();
 const valid=token=>{const v=entries.get(token);return !!v&&(v.expires===null&&v.kind==='paired'||v.expires>now());};
 const persist=async()=>{
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify([...entries.values()],null,2),{mode:0o600});await fs.rename(temp,file);
 };
 const change=fn=>{const job=queue.catch(()=>{}).then(fn);queue=job;return job;};
 return {
  valid,
  validOwner(owner){return [...entries.keys()].some(token=>valid(token)&&crypto.createHash("sha256").update(token).digest("hex")===owner);},
  async create(){return change(async()=>{
   const token=crypto.randomBytes(32).toString('hex');
   entries.set(token,{token,kind:'paired',expires:null,createdAt:now(),renewedAt:now()});
   // Expiration applies only to old browser sessions, never another device.
   for(const [t,v] of entries)if(v.expires!==null&&v.expires<=now())entries.delete(t);
   await persist();return token;
  });},
  async refresh(token){return change(async()=>{
   if(!valid(token))return false;
   const v=entries.get(token);
   if(v.kind==='paired'&&now()-(v.renewedAt||0)<DAY)return false;
   entries.set(token,{...v,kind:'paired',expires:null,renewedAt:now()});
   await persist();return true;
  });},
  async revoke(token){return change(async()=>{entries.delete(token);await persist();});}
 };
}

export function sessionCookie(token,secure=true){
 return `sai_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_SECONDS}${secure?'; Secure':''}`;
}
