// Keep speech which was interrupted while waiting for the previous native reply
// to stop. Remove it at submission, not acknowledgement: an uncertain network
// result must never cause the same words to be sent a second time.
export class VoicePendingInput {
  constructor(){this.parts=[];}
  append(text){if(text?.trim())this.parts.push(text.trim());}
  take(){const message=this.parts.join(' ');this.parts=[];return message;}
}
