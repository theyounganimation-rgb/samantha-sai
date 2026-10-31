// Native iOS audio players use byte ranges for metadata, playback and seeking.
export function serveMedia(req,res,media){
  const {bytes,mimeType,etag}=media;
  res.setHeader('Cache-Control','private, max-age=86400');
  res.setHeader('ETag',etag);res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type',mimeType);res.setHeader('Content-Disposition','inline');
  if(req.headers['if-none-match']===etag){res.writeHead(304);return res.end();}
  let start=0,end=bytes.length-1,status=200;
  const range=req.headers.range;
  if(range&&(!req.headers['if-range']||req.headers['if-range']===etag)){
    const match=typeof range==='string'&&/^bytes=(\d*)-(\d*)$/.exec(range);
    let valid=!!match&&(match[1]!==''||match[2]!=='');
    if(valid){
      if(match[1]===''){
        const count=Number(match[2]);valid=Number.isSafeInteger(count)&&count>0;
        start=Math.max(0,bytes.length-count);
      }else{
        start=Number(match[1]);end=match[2]===''?end:Math.min(Number(match[2]),end);
        valid=Number.isSafeInteger(start)&&Number.isSafeInteger(Number(match[2]||end))&&start<=end;
      }
      valid=valid&&start>=0&&start<bytes.length;
    }
    if(!valid){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length,'Content-Length':0});return res.end();}
    status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`);
  }
  const body=bytes.subarray(start,end+1);
  res.writeHead(status,{'Content-Length':body.length});
  return res.end(req.method==='HEAD'?undefined:body);
}
