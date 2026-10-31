function run(argv) {
  const p=JSON.parse(argv[0]), mail=Application('Mail');
  if(p.operation==='accounts')return JSON.stringify({ok:true,accounts:mail.accounts().map(a=>({id:a.id(),name:a.name(),emails:a.emailAddresses(),enabled:a.enabled()}))});
  if(!['draft','send','selftest'].includes(p.operation))throw new Error('Unsupported operation');
  const a=mail.accounts().find(a=>a.enabled() && a.emailAddresses().some(e=>e.toLowerCase()===p.account.toLowerCase()));
  if(!a)throw new Error('Selected sending account is unavailable');
  const m=mail.OutgoingMessage({subject:p.subject,content:p.body+'\n',sender:p.account,visible:p.operation==='draft'});
  mail.outgoingMessages.push(m);
  p.to.forEach(address=>m.toRecipients.push(mail.ToRecipient({address})));
  if(p.operation==='selftest') {
    m.save();
    const ok=m.subject()===p.subject && m.sender().toLowerCase().includes(p.account.toLowerCase()) && m.content().trim()===p.body.trim() && m.toRecipients()[0].address()===p.to[0];
    m.delete();
    return JSON.stringify({ok,action:'temporary_draft_created_verified_removed',sent:false});
  }
  if(p.operation==='draft') {m.save(); return JSON.stringify({ok:true,action:'draft_created',mailId:m.id()});}
  const sent=m.send();
  return JSON.stringify({ok:!!sent,action:sent?'accepted_by_mail':'not_accepted',deliveryConfirmed:false});
}
