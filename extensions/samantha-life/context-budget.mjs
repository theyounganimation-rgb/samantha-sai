// Allocate representation before detail. This is a context budget, not a
// behavioral quota or a rotation of interests. Inputs and their order survive.
export function packContext(base, groups, maxBytes) {
 const data=structuredClone(base), bytes=()=>Buffer.byteLength(JSON.stringify(data));
 data.coverage={};
 for(const g of groups){data[g.key]=[];data.coverage[g.key]={available:g.total??g.rows.length,represented:0,detailsDeferred:0};}
 const included=[];
 for(let i=0;i<Math.max(0,...groups.map(g=>g.rows.length));i++)for(const g of groups){
  const row=g.rows[i];if(!row)continue;
  const ref={...g.reference(row),detailDeferred:true};
  const a=data[g.key],c=data.coverage[g.key];
  a.push(ref);c.represented++;c.detailsDeferred++;
  if(bytes()>maxBytes){a.pop();c.represented--;c.detailsDeferred--;continue;}
  included.push({g,row,index:a.length-1});
 }
 // Whole semantic bundles only, e.g. a view with its applicability and
 // countercondition. Never preserve a confident half and cut its qualification.
 for(const {g,row,index} of included){
  const old=data[g.key][index],next={...old,...g.detail(row),detailDeferred:false};
  data[g.key][index]=next;data.coverage[g.key].detailsDeferred--;
  if(bytes()>maxBytes){data[g.key][index]=old;data.coverage[g.key].detailsDeferred++;}
 }
 if(bytes()<=maxBytes)return data;
 return {contextDeferred:true,fullRecord:base.fullRecord??'samantha_studio overview / samantha_processing read',meaning:'Context exceeds this surface; no absence, completion or permission is inferred.'};
}
