import {stripMediaDirectives} from './message-media.mjs';
// Keep a recognized maintenance preamble out of conversational text AND audio.
// This incremental filter only holds an ambiguous prefix, never the whole reply.
const controls=['No response requested.','NO_REPLY','HEARTBEAT_OK'];
const prefixes=['saving this to memory','updating my memory file','saving this in memory'];
export function conversationalText(text,{final=true}={}) {
 const raw=stripMediaDirectives(text,{final}),trimmed=raw.trimStart(),lower=trimmed.toLowerCase();
 if(controls.some(p=>p===trimmed.trim()||!final&&p.startsWith(trimmed)))return '';
 if(!final&&prefixes.some(p=>p.startsWith(lower)))return '';
 if(!prefixes.some(p=>lower.startsWith(p)))return raw;
 // A sentence/preamble ends at punctuation or a blank line. Preserve the rest
 // verbatim, including questions and a discussion of memory elsewhere.
 const end=trimmed.search(/[.!?](?:\s|$)|\n\s*\n/);
 if(end<0)return final?raw:'';
 return trimmed.slice(end+1).trimStart();
}
