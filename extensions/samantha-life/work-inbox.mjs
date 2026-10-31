import fs from 'node:fs/promises';
import path from 'node:path';

const terminal=new Set(['completed','failed','cancelled','interrupted']);
export function workerInbox(state={}, {maxBytes=2400}={}) {
 const visible=([,j])=>!j.quiet&&!j.sessionKey?.includes('regulation-proof');
 const rows=Object.entries(state.jobs??{}).filter(x=>visible(x)&&x[1].purpose==='personal');
 const retained=Object.entries(state.jobs??{}).filter(x=>visible(x)&&x[1].purpose!=='personal'&&x[1].completionDelivery?.status==='unverified'&&!x[1].review)
  .sort((a,b)=>(b[1].createdAt??0)-(a[1].createdAt??0));
 const ready=rows.filter(([,j])=>j.completion&&!j.review).sort((a,b)=>(b[1].createdAt??0)-(a[1].createdAt??0));
 const active=rows.filter(([,j])=>!j.completion&&!terminal.has(j.status));
 const reviewed=rows.filter(([,j])=>j.review).sort((a,b)=>(b[1].review.at??0)-(a[1].review.at??0));
 const ref=([jobId,j])=>({jobId,title:j.title,createdAt:j.createdAt,finishedAt:j.completion?.finishedAt,threadId:j.threadId??null,workId:j.workId??null,status:j.completion?.status??j.status??'unreconciled'});
 const out={readyCount:ready.length,activeCount:active.length,reviewedCount:reviewed.length,
  ready:ready.slice(0,6).map(x=>({...ref(x),resultSha256:x[1].completion.resultSha256??null})),
  active:active.slice(-4).map(ref),reviewed:reviewed.slice(0,2).map(x=>({...ref(x),verdict:x[1].review.verdict,implication:x[1].review.implication,nextStep:x[1].review.nextStep,perspectiveRefs:x[1].review.perspectiveRefs??[]})),
  retainedDeliveryCount:retained.length,retainedDelivery:retained.slice(0,2).map(x=>({...ref(x),deliveryStatus:'unverified',reason:x[1].completionDelivery.reason})),
  inspect:'samantha_codex jobs / status jobId / files / read_file / review',
  meaning:'Independent work and retained results. Inspect evidence before adopting a finding. Retained delivery is historical or uncertain notification, not new work, confirmed reception or an instruction to resend. Review against current context. A worker is a technical contributor, not another identity. Save significant learning in the existing perspective/project, with sources and a later check.'};
 const size=()=>Buffer.byteLength(JSON.stringify(out));
 out.omitted={ready:Math.max(0,ready.length-out.ready.length),active:Math.max(0,active.length-out.active.length),reviewed:Math.max(0,reviewed.length-out.reviewed.length),retainedDelivery:Math.max(0,retained.length-out.retainedDelivery.length)};
 for(const key of ['retainedDelivery','reviewed','active','ready'])while(out[key].length&&size()>maxBytes){out[key].pop();out.omitted[key]++;}
 return out;
}
export async function readWorkerInbox(workspace,ctx={}) {
 if(ctx.sessionKey?.startsWith('agent:samantha:regulation-proof-'))return workerInbox();
 try {return workerInbox(JSON.parse(await fs.readFile(path.join(workspace,'../state/samantha-email-codex.json'),'utf8')));}
 catch(e){return {...workerInbox(),...(e.code==='ENOENT'?{}:{unavailable:true,reason:e.code??'unreadable'})};}
}
