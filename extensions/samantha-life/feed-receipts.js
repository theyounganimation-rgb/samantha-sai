import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';

const valid=id=>/^samantha-life-[a-f0-9]{24}$/.test(id);
export function createReceipts({directory=path.join(os.homedir(),'.openclaw/state/samantha-feed-receipts'),database=path.join(os.homedir(),'.openclaw/agents/samantha/agent/openclaw-agent.sqlite')}={}) {
  const write=async(runId,value)=>{
    if(!valid(runId))return;
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,runId+'.json'),temp=file+'.'+process.pid+'.tmp';
    const handle=await fs.open(temp,'w',0o600);
    try{await handle.writeFile(JSON.stringify({...value,runId,at:Date.now(),pid:process.pid}));await handle.sync();}finally{await handle.close();}
    await fs.rename(temp,file);
  };
  const read=async pending=>{
    const runId=pending.runId??'samantha-life-'+pending.id;
    if(!valid(runId))throw new Error('Invalid feed run identity');
    let receipt;
    try{receipt=JSON.parse(await fs.readFile(path.join(directory,runId+'.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const db=new DatabaseSync(database,{readOnly:true});
    try{
      db.exec('PRAGMA busy_timeout=2000');
      const sessionId=db.prepare("SELECT current_session_id FROM session_nodes WHERE session_key='agent:samantha:main'").get()?.current_session_id;
      if(!sessionId)throw new Error('Main session identity unavailable');
      if(receipt)return {...receipt,sessionId};
      const completed=db.prepare('SELECT run_id,succeeded FROM session_input_completions WHERE idempotency_key=? OR run_id=? ORDER BY completed_at DESC LIMIT 1').get(runId,runId);
      if(completed)return {status:completed.succeeded?'completed':'failed',runId:completed.run_id,sessionId};
      const queued=db.prepare('SELECT run_id,state FROM session_pending_inputs WHERE idempotency_key=? OR run_id=? LIMIT 1').get(runId,runId);
      if(queued)return {status:'observed',runId:queued.run_id,sessionId};
      // Existing legacy input prohibits replay but does not prove successful action.
      const match=db.prepare("SELECT session_id FROM session_transcript_fts WHERE role='user' AND text LIKE ? LIMIT 1").get('%Batch '+pending.id+'.%');
      return {status:match?'observed':'absent',sessionId};
    }finally{db.close();}
  };
  const register=api=>{
    api.on('before_prompt_build',async(event,ctx)=>{
      if(ctx.agentId==='samantha')await write(ctx.runId??event.runId,{status:'started'});
    },{priority:300,timeoutMs:4000});
    api.on('agent_end',async(event,ctx)=>{
      if(ctx.agentId==='samantha')await write(ctx.runId??event.runId,{status:event.success?'completed':'failed',error:event.success?undefined:String(event.error??'Agent failed').slice(0,300)});
    },{priority:300,timeoutMs:4000});
  };
  return {read,write,register};
}
