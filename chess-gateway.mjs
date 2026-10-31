// A single lazy gateway connection for durable chess turn admission/readback.
export function chessGateway({getToken}){
 let client,opening;
 async function connect(){
  if(!opening)opening=(async()=>{
   const {GatewayClient}=await import('/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js');
   const ready=Promise.withResolvers();let timer;
   client=new GatewayClient({url:'ws://127.0.0.1:18789',token:await getToken(),clientName:'gateway-client',clientDisplayName:'SAI chess',clientVersion:'1.0',platform:'darwin',mode:'backend',deviceIdentity:null,scopes:['operator.admin'],onHelloOk:()=>ready.resolve(),onConnectError:e=>ready.reject(e)});
   client.start();try{await Promise.race([ready.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Chess connection unavailable')),10000);})]);return client;}catch(e){client.stop();opening=null;throw e;}finally{clearTimeout(timer);}
  })();return opening;
 }
 return {async request(method,args){return (await connect()).request(method,args,{timeoutMs:method==='agent.wait'?5000:20000});},close(){client?.stop();opening=null;}};
}
