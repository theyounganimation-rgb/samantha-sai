// OpenClaw stores delivered media as managed artifacts. Keep their references
// separate from spoken words, and never expose a local MEDIA: path in the UI.
export function stripMediaDirectives(text,{final=true}={}) {
  const lines=String(text??'').split(/(?<=\n)/),out=[];
  for(const line of lines){
    const value=line.replace(/\r?\n$/,'');
    if(/^MEDIA:\s*\S/.test(value))continue;
    if(!final&&!line.endsWith('\n')&&('MEDIA:'.startsWith(value)||/^MEDIA:\s*$/.test(value)))continue;
    out.push(line);
  }
  return out.join('').replace(/\n(?:[ \t]*\n){2,}/g,'\n\n');
}

// The gateway's converted record may carry its attachment blocks in content or, since October 2026, only in openclawDisplayContent.
export function mediaBlocks(message){
  const own=Array.isArray(message?.content)?message.content:[],display=Array.isArray(message?.openclawDisplayContent)?message.openclawDisplayContent:[];
  const blocks=[...own,...display].filter(b=>b&&['image','audio','video','file'].includes(b.type)&&typeof b.url==='string');
  const seen=new Set();return blocks.filter(b=>{if(seen.has(b.url))return false;seen.add(b.url);return true;});
}
export function messageMedia(message) {
  const blocks=mediaBlocks(message);if(!blocks.length)return [];
  return blocks.filter(b=>['image','audio'].includes(b.type)).map(b=>({
    type:b.type,url:b.url,artifactId:b.artifactId,
    alt:typeof b.alt==='string'?b.alt.slice(0,200):b.type==='audio'?'Audio from Samantha':'Photo from Samantha',
    mimeType:b.mimeType,...(b.type==='image'?{width:b.width,height:b.height}:{fileName:typeof b.fileName==='string'?b.fileName.split(/[\\/]/).at(-1).slice(0,120):'Audio from Samantha'}),sizeBytes:b.sizeBytes
  }));
}

export function cliTransportPlaceholder(message) {
  const meta=message?.__openclaw;
  if(message?.role!=='user'||meta?.importedFrom!=='claude-cli'||!meta.externalId||meta.transcriptPosition)return false;
  const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'):'';
  return text==='[Claude CLI history record omitted from context because it exceeded 1 MiB.]';
}
