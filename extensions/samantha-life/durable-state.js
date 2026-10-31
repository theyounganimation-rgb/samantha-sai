import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

// Plugin tool registrations and the service can live in distinct runtimes.
// Never retain a writable snapshot between transactions, even within one PID.
export async function withStateLock(file,fn,{timeoutMs=5000}={}) {
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 // macOS provides flock through its bundled Python. The OS releases the lock
 // when this helper exits; the stdin pipe closes if its Node owner dies.
 const helper=spawn('/usr/bin/python3',['-u','-c',
  'import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.buffer.read()\n',file+'.flock'],{stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>helper.once('close',resolve));
 helper.stdin.on('error',()=>{});
 try{
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{helper.kill();reject(new Error('Shared completion state is busy; check status then retry the same requestKey'));},timeoutMs);
   const done=(error)=>{clearTimeout(timer);error?reject(error):resolve();};
   helper.once('error',done);
   helper.once('exit',code=>done(new Error('Shared-state lock helper exited before acquisition: '+code)));
   helper.stdout.once('data',data=>done(data.toString().trim()==='locked'?null:new Error('Unexpected lock response')));
  });
  return await fn();
 }finally{helper.stdin.end();await closed;}
}

export async function readState(file){
 try{return JSON.parse(await fs.readFile(file,'utf8'));}
 catch(e){if(e.code!=='ENOENT')throw e;return {version:1,jobs:{},seen:[]};}
}
export async function writeState(file,value){
 const temporary=file+'.'+crypto.randomUUID()+'.tmp';
 const handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 try{await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
}
