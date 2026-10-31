export function describeSpeechFailure(value,key=''){
 const raw=value?.message||value?.error||String(value||'Speech connection failed');
 const detail=(key?String(raw).split(key).join('[redacted]'):String(raw)).slice(0,500);
 const code=String(value?.error||value?.code||'speech_connection_failed').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
 let notice='Her voice connection failed. Her full reply will still appear here.';
 if(/quota|credit.?limit|credits? remaining/i.test(code+' '+detail))notice='The voice credit limit was reached. Her full reply will still appear here.';
 else if(/authentication|permission|unauthorized|api.?key/i.test(code+' '+detail))notice='The voice account needs attention. Her full reply will still appear here.';
 return {code,detail,notice};
}
