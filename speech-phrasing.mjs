// Preserve every authored character while giving synthesis complete phrases.
// The caller supplies a short time limit; finish always drains the final tail.
export class SpeechPhraser {
 constructor({limit=160}={}){this.buffer='';this.limit=limit;}
 push(text){this.buffer+=text;return this.drain();}
 drain({timed=false,final=false}={}){
  if(final){const text=this.buffer;this.buffer='';return text?[text]:[];}
  const parts=[];
  while(this.buffer){
   let bracket=false,lastSpace=0,sentence=0,words=0,inWord=false;
   for(let i=0;i<this.buffer.length;i++){
    const c=this.buffer[i];
    if(c==='[')bracket=true;
    if(c===']'){bracket=false;continue;}
    if(bracket)continue;
    if(/\s/u.test(c)){if(inWord){words++;inWord=false;}if(i<=this.limit)lastSpace=i+1;}
    else inWord=true;
    if(i>=39&&(words+(inWord?1:0))>=8&&/[.!?\n]/u.test(c)&&(!this.buffer[i+1]||/\s/u.test(this.buffer[i+1]))){sentence=i+1;break;}
    if(i>=this.limit)break;
   }
   const cut=sentence||((this.buffer.length>=this.limit||timed)?lastSpace:0);
   if(!cut)break;
   parts.push(this.buffer.slice(0,cut));this.buffer=this.buffer.slice(cut);
  }
  return parts;
 }
}
