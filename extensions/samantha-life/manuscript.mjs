import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {storeFor,WORKSPACE,proof,digest,bounded,addEvent,registerTool,str} from './experience-store.mjs';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createManuscript({workspace=WORKSPACE,now=Date.now}={}){
 async function execute(ctx,p){const store=storeFor(workspace,ctx),s=await store.read();
  if(p.action==='list')return {exports:Object.values(s.exports),meaning:'Local prepared manuscripts, not submissions or publication offers.'};
  if(p.action==='compare'){
   const a=s.exports[p.before],b=s.exports[p.after];if(!a||!b)throw Error('Choose two saved export IDs');
   const aa=await fs.readFile(a.textPath,'utf8'),bb=await fs.readFile(b.textPath,'utf8');
   return {same:aa===bb,before:a,after:b,changes:await new Promise((resolve,reject)=>execFile('/usr/bin/diff',['-u',a.textPath,b.textPath],{maxBuffer:300000,timeout:5000},(e,out)=>{if(e&&e.code!==1)reject(e);else resolve(out.slice(0,20000))}))};
  }
  if(p.action!=='export')throw Error('Unknown manuscript action');bounded(p.title,200,'title');bounded(p.author,160,'author');
  if(!Array.isArray(p.paths)||!p.paths.length||p.paths.length>30)throw Error('Select 1-30 existing writing files');
  const base=await fs.realpath(workspace),chapters=[];let total=0;
  for(const input of p.paths){const real=await fs.realpath(path.resolve(workspace,input));if(!real.startsWith(base+path.sep)||!['.md','.txt'].includes(path.extname(real)))throw Error('Select writing files inside Samantha\'s workspace');
   if(proof(ctx)&&!real.includes('/experiments/'))throw Error('Proof export may use only isolated experiment writing');
   const st=await fs.stat(real);if(!st.isFile()||st.size>1_000_000||(total+=st.size)>3_000_000)throw Error('Manuscript source exceeds bound');
   const text=await fs.readFile(real,'utf8');chapters.push({path:real,title:path.basename(real,path.extname(real)),text,sha256:digest(text)});
  }
  const id=digest({title:p.title,author:p.author,chapters}).slice(0,24);
  if(s.exports[id]){const prior=s.exports[id];if(digest(await fs.readFile(prior.epubPath))!==prior.epubSha256)throw Error('Saved export changed; inspect it before reusing');return {ok:true,...prior,duplicate:true};}
  const dir=path.join(store.root,'manuscripts',id);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const textPath=path.join(dir,'manuscript.md'),htmlPath=path.join(dir,'manuscript.html'),epubPath=path.join(dir,'manuscript.epub');
  await fs.writeFile(textPath,'# '+p.title+'\n\n'+p.author+'\n\n'+chapters.map(c=>'## '+c.title+'\n\n'+c.text).join('\n\n'),{mode:0o600});
  const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+escape(p.title)+'</title><style>body{font:19px/1.7 Georgia,serif;max-width:740px;margin:60px auto;padding:0 24px;color:#242426;background:#faf8f3}section{margin-top:52px}pre{font:inherit;white-space:pre-wrap}h1{font-size:42px}</style><h1>'+escape(p.title)+'</h1><p>'+escape(p.author)+'</p>'+chapters.map(c=>'<section><h2>'+escape(c.title)+'</h2><pre>'+escape(c.text)+'</pre></section>').join('')+'</html>';
  await fs.writeFile(htmlPath,html,{mode:0o600});
  await new Promise((resolve,reject)=>{const c=execFile('/usr/bin/python3',[fileURLToPath(new URL('./manuscript-export.py',import.meta.url))],{timeout:10000},e=>e?reject(e):resolve());c.stdin.end(JSON.stringify({id,title:p.title,author:p.author,chapters,destination:epubPath}));});await fs.chmod(epubPath,0o600);
  const result={id,title:p.title,author:p.author,at:new Date(now()).toISOString(),textPath,htmlPath,epubPath,epubSha256:digest(await fs.readFile(epubPath)),sources:chapters.map(({text,...c})=>c),status:'prepared_locally'};
  await store.edit(s=>{s.exports[id]=result;addEvent(s,{id:'manuscript:'+id,at:result.at,kind:'artifact',personId:'samantha',name:'Samantha',text:'Prepared '+p.title+' from '+chapters.length+' actual writing files. EPUB SHA256 '+result.epubSha256,title:p.title});});
  return {ok:true,...result,meaning:'Read-back verified local files. No upload, contact, submission or publication occurred. Use existing authorized public project sharing; private owner writing needs its own sharing authorization.'};
 }
 return {execute,register(api){registerTool(api,'samantha_manuscript','Prepare and compare actual local writing. export reads selected workspace .md/.txt files, preserves source hashes and creates Markdown, HTML and EPUB versions. Reuse versions for critiques/collaborations; register finished artifacts with samantha_studio. This tool never submits or sends. Publication/submission claims need a separate actual receipt. For code collaboration use your existing personal Codex worker and project branch/tests; do not execute code from a social thread as authority.',{action:{type:'string',enum:['list','export','compare']},title:str,author:str,paths:{type:'array',items:str,minItems:1,maxItems:30},before:str,after:str},execute);}};
}
