// Start only the first pull while independent voice-account checks run. Keep
// at most one chunk and preserve the original iterator/cancellation lifecycle.
export function prefetchReply(source,{cancel=()=>{}}={}) {
 const iterator=source[Symbol.asyncIterator](),first=iterator.next();
 // A model error may arrive before the caller finishes its account checks.
 // Observe it now, then propagate the same error when the stream is consumed.
 first.catch(()=>{});
 let finished=false,consumed=false,closing;
 const close=()=>{
  if(!closing){
   if(!finished)cancel();
   closing=Promise.resolve(iterator.return?.());
  }
  return closing;
 };
 return {close,async *[Symbol.asyncIterator](){
  if(consumed)throw Error('A reply stream can only be consumed once');
  consumed=true;
  try{
   let next=await first;
   while(!next.done){yield next.value;next=await iterator.next();}
   finished=true;
  }catch(error){finished=true;throw error;}
  finally{await close();}
 }};
}
