// Only transport/provider availability failures merit an automatic read retry.
// Bad credentials, unknown balances and exhausted credit remain hard failures.
export function transientVoiceFailure(error){
 const status=Number(error?.status);
 if(status)return status===408||status===429||status>=500;
 const code=String(error?.cause?.code||error?.code||error?.name||'');
 return /ECONN|ENET|EHOST|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|TimeoutError/.test(code)||
  /fetch failed|network|socket|connection|timed? ?out|unavailable \((?:408|429|5\d\d)\)/i.test(String(error?.message||''));
}

export class CallCreditMonitor{
 constructor({check,onFailure,onRetry=()=>{},onRecovered=()=>{},intervalMs=60000,retryMs=5000,graceMs=60000}){
  Object.assign(this,{check,onFailure,onRetry,onRecovered,intervalMs,retryMs,graceMs});
  this.stopped=false;this.recovering=false;
 }
 start(){this.schedule(this.intervalMs);}
 schedule(ms){clearTimeout(this.timer);if(!this.stopped)this.timer=setTimeout(()=>void this.run(),ms);}
 stop(){this.stopped=true;clearTimeout(this.timer);clearTimeout(this.deadline);}
 fail(error){if(this.stopped)return;this.stop();this.onFailure(error);}
 async run(){
  if(this.stopped||this.running)return;this.running=true;
  try{
   const credits=await this.check();if(this.stopped)return;
   if(credits.remaining<1000){this.fail(new Error('Call stopped before included credits ran out.'));return;}
   clearTimeout(this.deadline);if(this.recovering)this.onRecovered();this.recovering=false;
   this.schedule(this.intervalMs);
  }catch(error){
   if(this.stopped)return;
   if(!transientVoiceFailure(error)){this.fail(error);return;}
   if(!this.recovering){this.recovering=true;this.deadline=setTimeout(()=>this.fail(new Error('Voice credit verification could not reconnect. Please start a new call when the connection returns.')),this.graceMs);}
   this.onRetry(error);this.schedule(this.retryMs);
  }finally{this.running=false;}
 }
}
