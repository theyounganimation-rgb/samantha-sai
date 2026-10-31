// Per-request voice effort only. Shared model, history, tools and saved defaults
// stay authoritative. Explicit complex/action requests retain full effort.
const DEEP = /(?:\b(?:research|investigate|analy[sz]e|diagnos\w*|debug\w*|implement|calculate|prove|verify|fact.?check|look\s*up|search|check|remember|recall|schedule|calendar|send|email|message|buy|purchase|book|delete|install|deploy|run|execute|code|program|algorithm|medical|medicine|medication|dose|symptom|legal|lawyer|invest|stock|tax|mortgage|suicid\w*|hurt|danger|emergency)\b|\b(?:think|reason)\s+(?:hard|carefully|deeply|through)|\b(?:step.by.step|double.check|pros and cons|compare|trade.?offs)\b|\/(?:think|model|reasoning)\b)/i;
export function voiceResponsePolicy({voice=false,text='',attachments=[],continued=false}={}) {
 if(!voice)return {mode:'default'};
 const value=String(text).trim();
 if(/\/(?:think|model|reasoning)\b/i.test(value))return {mode:'explicit'};
 if(!value||attachments.length||continued||value.length>240||DEEP.test(value))return {mode:'deliberate',thinking:'high'};
 return {mode:'conversation',thinking:'low'};
}
