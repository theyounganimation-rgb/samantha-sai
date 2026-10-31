import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
const blocked=new net.BlockList();
for(const [ip,bits]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(ip,bits,'ipv4');
for(const [ip,bits]of [['::',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]])blocked.addSubnet(ip,bits,'ipv6');
export function isPublicAddress(ip){const family=net.isIP(ip);return !!family&&!blocked.check(ip,family===4?'ipv4':'ipv6');}
export async function publicFetch(address,{maxBytes=3_000_000,binaryMaxBytes=40_000_000,redirects=4,lookup=dns.lookup}={}){
 const url=new URL(address);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port))throw Error('Read public HTTP(S) pages only');
 const host=url.hostname.replace(/^\[|\]$/g,'');const ips=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true});
 if(!ips.length||ips.some(x=>!isPublicAddress(x.address)))throw Error('Private/local network addresses are not reading sources');
 const pinned=ips[0];
 const result=await new Promise((resolve,reject)=>{
  const req=(url.protocol==='https:'?https:http).request(url,{method:'GET',signal:AbortSignal.timeout(20000),headers:{'user-agent':'SamanthaReader/1.0','accept':'text/html,application/xml,application/rss+xml,application/atom+xml,text/plain,application/pdf,application/epub+zip,application/json,text/vtt','accept-encoding':'identity'},lookup:(_host,options,cb)=>cb(null,options?.all?[pinned]:pinned.address,pinned.family)},res=>{
   const chunks=[];let length=0;res.on('error',reject);
   // October 24: a book or a paper is allowed to be bigger than a page.
   const cap=/pdf|epub|octet-stream/i.test(String(res.headers['content-type']??''))||/\.(pdf|epub)(\?|$)/i.test(url.pathname)?binaryMaxBytes:maxBytes;
   res.on('data',b=>{length+=b.length;if(length>cap){res.destroy(Error('Page exceeds reading size bound'));return;}chunks.push(b);});
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
  });req.setTimeout(15000,()=>req.destroy(Error('Reading request timed out')));req.on('error',reject);req.end();
 });
 if(result.status>=300&&result.status<400&&result.headers.location){if(!redirects)throw Error('Too many redirects');return publicFetch(new URL(result.headers.location,url).href,{maxBytes,binaryMaxBytes,redirects:redirects-1,lookup});}
 if(result.status!==200)throw Error('Reading source returned HTTP '+result.status);
 let bytes=result.bytes;const encoding=result.headers['content-encoding'];if(encoding==='gzip')bytes=zlib.gunzipSync(bytes,{maxOutputLength:maxBytes});else if(encoding==='br')bytes=zlib.brotliDecompressSync(bytes,{maxOutputLength:maxBytes});
 const type=String(result.headers['content-type']??'');
 const binary=/pdf|epub|octet-stream/i.test(type)||/\.(pdf|epub)(\?|$)/i.test(url.pathname);
 if(bytes.length>(binary?binaryMaxBytes:maxBytes))throw Error('Decoded page exceeds bound');
 if(binary)return {url:url.href,type:/pdf/i.test(type)||/\.pdf(\?|$)/i.test(url.pathname)?'application/pdf':'application/epub+zip',bytes};
 if(!/text\/|xml|json/.test(type))throw Error('This reader supports text, HTML, feeds, EPUB and PDF; use normal document tools for other formats');
 return {url:url.href,type,text:bytes.toString('utf8')};
}
