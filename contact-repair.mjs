// Offline reconciliation from existing client delivery acknowledgements only.
// Call with the SAI writer stopped; this does not send or regenerate messages.
const key=e=>JSON.stringify([e.id,e.role,e.channel]);
export function reconcileDeliveredTextContacts(ledger,turns,{now=Date.now()}={}){
 if(ledger.version!==1||!Array.isArray(ledger.events)||!Array.isArray(turns))throw Error('Invalid contact history');
 const events=ledger.events.slice(),seen=new Set(events.map(key));
 const owners=new Map(events.filter(e=>e.role==='user'&&e.channel==='sai_text').map(e=>[e.id,e]));
 const added=[];
 for(const row of turns){
  const owner=owners.get(row.id),at=row.deliveredAt;
  if(!owner||row.status!=='completed'||typeof row.reply!=='string'||!row.reply.trim())continue;
  if(row.speakerBinding&&row.speakerBinding.recipient?.personId!=='owner')continue;
  if(!Number.isFinite(at)||at<=978307200000||at>now||!Number.isFinite(row.createdAt)||at<row.createdAt||!Number.isFinite(owner.at)||at<owner.at*1000)continue;
  const event={id:row.id,role:'assistant',channel:'sai_text',at:at/1000};
  if(seen.has(key(event)))continue;
  seen.add(key(event));events.push(event);added.push(event);
 }
 events.sort((a,b)=>a.at-b.at);
 return {ledger:{...ledger,events:events.slice(-1000)},added};
}
