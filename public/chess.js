const NS='http://www.w3.org/2000/svg';
const paths={
 p:'M21 19a7 7 0 1 1 14 0c0 4-2 6-4 7l2 12h5v5H18v-5h5l2-12c-2-1-4-3-4-7Z',
 r:'M16 12h7v6h5v-6h5v6h5v-6h6v14l-6 4v10h5v5H17v-5h5V30l-6-4Z',
 n:'M17 42h25v5H15v-5l2-9 14-11-7 1-5 7-7-4 8-15 9-4 2-5 5 7c11 10 6 22 4 28H22l3-5',
 b:'M18 42h23v5H15v-5h3l7-15c-8-7-7-12 3-23 11 10 13 16 5 23l5 15M28 12l5 7M24 31h10',
 q:'M14 18l7 6 8-13 8 13 7-6-6 20H20l-6-20ZM18 42h22v5H16v-5M20 38h18M12 14a2 2 0 1 0 4 0 2 2 0 1 0-4 0M27 7a2 2 0 1 0 4 0 2 2 0 1 0-4 0M42 14a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
 k:'M26 4h5v5h6v5h-6v6c9-5 15 2 9 10l-6 9H23l-7-9c-5-8 2-15 10-10v-6h-6V9h6ZM19 43h21v5H17v-5M23 39h11'
};
const names={p:'pawn',r:'rook',n:'knight',b:'bishop',q:'queen',k:'king'};
function piece(type,color){const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 56 56');svg.setAttribute('aria-hidden','true');svg.classList.add('chess-piece',color==='w'?'white':'black');const p=document.createElementNS(NS,'path');p.setAttribute('d',paths[type]);svg.append(p);return svg;}
export function pieces(fen){const out={};const rows=fen.split(' ')[0].split('/');for(let r=0;r<8;r++){let f=0;for(const x of rows[r]){if(/\d/.test(x))f+=Number(x);else{out['abcdefgh'[f]+(8-r)]={type:x.toLowerCase(),color:x===x.toUpperCase()?'w':'b'};f++;}}}return out;}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function button(text,cls,click){const b=el('button',cls,text);b.type='button';b.onclick=click;return b;}
// line icons in the app's own stroke style
const ICONS={
 close:'M6 6l12 12M18 6 6 18',more:'M5 12h.01M12 12h.01M19 12h.01',chevron:'M9 6l6 6-6 6',
 photo:'M3 8h4l2-3h6l2 3h4v12H3Z M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',pause:'M9 5v14M15 5v14',
 draw:'M12 3a9 9 0 1 0 0 18V3Z M12 3a9 9 0 0 1 0 18',flag:'M5 21V4m0 0h12l-2 4 2 4H5',
 sound:'M4 10v4h4l5 4V6L8 10H4Z M16 9a4 4 0 0 1 0 6',mute:'M4 10v4h4l5 4V6L8 10H4Z M17 9l4 6M21 9l-4 6'
};
function icon(name,cls){const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');if(cls)svg.setAttribute('class',cls);const p=document.createElementNS(NS,'path');p.setAttribute('d',ICONS[name]);svg.append(p);return svg;}
// a sheet: handle on the phone, a header with a close button, a body
function sheet(id,label){const d=el('dialog','chess-sheet');if(id)d.id=id;if(label)d.setAttribute('aria-label',label);return d;}
function sheetHead(titleText,{onClose,onMore}={}){
 const head=el('div','chess-sheet-head'),title=el('h2','',titleText);
 const more=button('','chess-icon-button'+(onMore?'':' quiet'),onMore);more.append(icon('more'));more.setAttribute('aria-label','More');if(!onMore)more.tabIndex=-1;
 const close=button('','chess-icon-button',onClose);close.append(icon('close'));close.setAttribute('aria-label','Close');
 head.append(more,title,close);return {head,title,more};
}
// a row in a sheet: an icon, a label, a hint, a chevron
function row({label,hint,iconNode,accent=false,danger=false,chevron=true,click}){
 const b=button('','chess-row'+(danger?' danger':''),click);b.setAttribute('aria-label',label);
 const ic=el('span','chess-row-icon'+(accent?' accent':''));ic.append(iconNode);
 const text=el('span','chess-row-text');text.append(el('strong','',label));if(hint)text.append(el('span','',hint));
 b.append(ic,text);if(chevron)b.append(icon('chevron','chess-row-chevron'));return b;
}
function when(ts){if(!ts)return '';const d=new Date(ts),now=new Date(),day=86400000;const diff=(now.setHours(0,0,0,0)-new Date(d).setHours(0,0,0,0))/day;if(diff<1)return 'Today';if(diff<2)return 'Yesterday';if(diff<7)return d.toLocaleDateString([],{weekday:'long'});return d.toLocaleDateString([],{month:'short',day:'numeric'});}
export function boardElement(game,{interactive=false,selected=null,preview=null,onSquare=()=>{}}={}){
 const board=el('div','chess-board'+(interactive?' interactive':''));board.setAttribute('role','group');board.setAttribute('aria-label','Chess board');
 const map=pieces(preview?.after??game.fen),files=game.humanColor==='b'?'hgfedcba':'abcdefgh',ranks=game.humanColor==='b'?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];
 if(preview&&!preview.after){const p=map[preview.from];delete map[preview.from];if(p)map[preview.to]={...p,type:preview.promotion||p.type};}
 for(const rank of ranks)for(const file of files){
  const sq=file+rank,p=map[sq],dark=('abcdefgh'.indexOf(file)+rank)%2===1;
  const cell=el(interactive?'button':'span','chess-square '+(dark?'dark':'light'));cell.dataset.square=sq;
  if(interactive){cell.type='button';cell.setAttribute('aria-label',`${sq}${p?' '+(p.color==='w'?'white':'black')+' '+names[p.type]:''}`);cell.onclick=()=>onSquare(sq);}
  if(p)cell.append(piece(p.type,p.color));
  if(game.lastMove&&[game.lastMove.from,game.lastMove.to].includes(sq))cell.classList.add('last-move');
  if(selected===sq){cell.classList.add('selected');cell.setAttribute('aria-pressed','true');}
  if(preview&&[preview.from,preview.to].includes(sq))cell.classList.add('preview');
  if(!preview&&selected&&(game.legalMoves??[]).some(m=>m.from===selected&&m.to===sq))cell.classList.add(p?'legal-capture':'legal');
  if(!preview&&game.check&&p?.type==='k'&&p.color===(game.turn==='samantha'?game.samanthaColor:game.humanColor))cell.classList.add('in-check');
  if(interactive&&rank===ranks[7])cell.append(el('small','chess-file',file));
  if(interactive&&file===files[0])cell.append(el('small','chess-rank',String(rank)));
  board.append(cell);
 }
 return board;
}
export function statusText(g){
 if(g.status==='finished')return g.result==='1/2-1/2'?'Draw · '+g.reason:(g.result===(g.humanColor==='w'?'1-0':'0-1')?g.human.name:'Samantha')+' won · '+g.reason;
 if(g.paused)return 'Saved for later';
 if(g.turn==='samantha')return ['failed','uncertain'].includes(g.reply?.phase)?'Her turn needs another try':'Samantha’s turn';
 return (g.check?'Check · ':'')+g.human.name+'’s turn';
}
export function pendingChessReply(games,speakerId){
 return games.find(g=>g.human.id===speakerId&&g.status==='active'&&!g.paused&&g.turn==='samantha'&&['queued','dispatching','accepted'].includes(g.reply?.phase))??null;
}
export function setChessCard(wrap,game,{open=()=>{}}={}){
 const signature=JSON.stringify(game??null);if(wrap.dataset.chessSignature===signature)return;wrap.dataset.chessSignature=signature;
 wrap.querySelector('.chess-card')?.remove();wrap.classList.toggle('has-chess',!!game);if(!game)return;
 const b=button('','chess-card',()=>open(game.id));b.setAttribute('aria-label','Open chess game with Samantha');
 const heading=el('div','chess-card-heading'),move=game.event==='move'?game.lastMove.san:null;
 heading.append(el('strong','','Chess'),el('span','chess-card-move'+(move?'':' quiet'),move??(game.event==='started'?'Let’s play':game.event.replaceAll('_',' '))));
 const foot=el('span','chess-card-foot',statusText(game));foot.append(icon('chevron','chess-row-chevron'));
 b.append(heading,boardElement(game),foot);wrap.append(b);
}

export function createChessUI({api,getSpeaker,onHistory=()=>{},onGames=()=>{},notify=()=>{}}){
 let games=[],gamesVersion=0,current=null,selected=null,preview=null,requesting=false,source=null,openId=null,sound=localStorage.getItem('sai.chess.sound')!=='off';
 const pendingKey='sai.chess.command.v1';let audio;
 function clickSound(){if(!sound)return;try{audio??=new (window.AudioContext||window.webkitAudioContext)();void audio.resume();const o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.setValueAtTime(460,audio.currentTime);o.frequency.exponentialRampToValueAtTime(160,audio.currentTime+.065);g.gain.setValueAtTime(.07,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.09);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+.1);}catch{}}
 // the board sheet
 const dialog=sheet('chess-dialog');dialog.classList.add('chess-dialog');dialog.setAttribute('aria-labelledby','chess-title');
 const {head,title,more}=sheetHead('Chess',{onClose:()=>dialog.close(),onMore:()=>openMore()});title.id='chess-title';
 const content=el('div','chess-content'),feedback=el('p','chess-feedback');feedback.setAttribute('role','status');
 dialog.append(head,content,feedback);document.body.append(dialog);
 // the "more" sheet: the game's quieter actions
 const moreSheet=sheet('chess-more','Game options'),moreRows=el('div','chess-rows');moreSheet.append(el('div','sheet-eyebrow','This game'),moreRows,button('Cancel','chess-cancel',()=>moreSheet.close()));document.body.append(moreSheet);
 // An in-page yes/no sheet: resolves true on the confirming button, false on Cancel, Escape or backdrop.
 const askSheet=sheet('chess-confirm','Confirm');document.body.append(askSheet);
 function ask(text,yesLabel='Yes'){return new Promise(resolve=>{askSheet.replaceChildren();let done=false;const finish=v=>{if(done)return;done=true;if(askSheet.open)askSheet.close();resolve(v);};
  const yes=button(yesLabel,'chess-confirm-yes',()=>finish(true));yes.classList.add('danger');
  askSheet.append(el('div','sheet-eyebrow','Are you sure?'),el('p','chess-note',text),yes,button('Cancel','chess-cancel',()=>finish(false)));
  askSheet.addEventListener('close',()=>finish(false),{once:true});askSheet.showModal();});}
 function openMore(){
  moreRows.replaceChildren();const g=current,mine=g&&g.status==='active'&&g.human.id===getSpeaker()?.personId;
  // October 28 (Owner): window.confirm() is silently false inside the iPhone app's web view, so Resign never fired. Ask in-page instead.
  const go=(action,confirmText)=>async()=>{moreSheet.close();if(confirmText&&!(await ask(confirmText,action==='resign'?'Resign':'Yes')))return;void act(action);};
  if(mine){
   if(g.paused)moreRows.append(row({label:'Continue our game',hint:'Pick the board back up',iconNode:icon('pause'),accent:true,click:go('resume')}));
   else moreRows.append(row({label:'Play later',hint:'Pause here. The board waits for you.',iconNode:icon('pause'),click:go('pause')}));
   moreRows.append(row({label:'Offer draw',hint:'She can accept or keep playing',iconNode:icon('draw'),click:go('offer_draw')}));
   moreRows.append(row({label:'Resign',hint:'Ends the game. The result is saved.',iconNode:icon('flag'),danger:true,click:go('resign','Resign this game? The result will be saved.')}));
  }
  moreRows.append(row({label:sound?'Sound on':'Sound off',hint:'A small click when a piece lands',iconNode:icon(sound?'sound':'mute'),chevron:false,click:()=>{sound=!sound;localStorage.setItem('sai.chess.sound',sound?'on':'off');moreSheet.close();render();}}));
  moreSheet.showModal();
 }
 // the add sheet behind "+"
 const extras=sheet('chess-extras','Add to the conversation'),extraRows=el('div','chess-rows');
 extras.append(el('div','sheet-eyebrow','Add to the conversation'),extraRows,button('Cancel','chess-cancel',()=>extras.close()));document.body.append(extras);
 function openExtras(){
  const g=games.find(g=>g.status==='active'&&g.human.id===getSpeaker()?.personId);
  extraRows.replaceChildren(
   row({label:'Photo',hint:'From your library or the camera',iconNode:icon('photo'),click:()=>{extras.close();document.querySelector('#photo-input').click();}}),
   row({label:'Chess with Samantha',hint:g?statusText(g)+' · continue':'A game, one move at a time',iconNode:piece('n','b'),accent:true,click:()=>{extras.close();void open();}}));
  extras.showModal();
 }
 const plus=document.querySelector('#attach-photo');plus.setAttribute('aria-label','Add photo or game');plus.title='Add photo or game';plus.onclick=openExtras;
 // the game bar above the composer while a game is on
 const shelf=button('','chess-resume',()=>void open());shelf.hidden=true;document.querySelector('.composer-area').prepend(shelf);
 function updateShelf(){const g=games.find(g=>g.status==='active'&&g.human.id===getSpeaker()?.personId);shelf.hidden=!g;shelf.classList.toggle('her',!!g&&g.turn==='samantha'&&!g.paused);
  shelf.replaceChildren(piece('n','b'),el('b','','Chess'),el('i','',g?statusText(g):''),icon('chevron','chess-row-chevron'));shelf.setAttribute('aria-label','Chess · '+(g?statusText(g):''));onGames(games);}
 function receiveGames(next){games=next;gamesVersion++;updateShelf();}
 function pending(){try{return JSON.parse(localStorage.getItem(pendingKey));}catch{return null;}}
 async function refresh(){const version=gamesVersion,d=await api('games/chess');if(version===gamesVersion)receiveGames(d.games??[]);return games;}
 async function load(id){const d=await api('games/chess/'+encodeURIComponent(id));if(openId!==id)return;const known=games.find(g=>g.id===id);if(d.game.revision<Math.max(known?.revision??0,current?.id===id?current.revision:0))return;const before=current?.revision;current={...d.game,...(known?.revision===d.game.revision?{reply:known.reply}:{})};if(before!==current.revision){selected=null;preview=null;}render();}
 async function open(id){document.activeElement?.blur();openId=id??null;current=null;selected=null;preview=null;feedback.textContent='';content.replaceChildren(el('p','chess-note','Picking up the board…'));if(!dialog.open)dialog.showModal();try{await refresh();openId=id??games.find(g=>g.status==='active'&&g.human.id===getSpeaker()?.personId)?.id??null;if(openId)await load(openId);else render();}catch(e){feedback.textContent=e.message;}}
 async function act(action,extra={}){
  if(requesting)return;const old=pending();
  if(old&&action!=='recover'){feedback.textContent='Check the last saved action before making another move.';render();return;}
  const command=action==='recover'?old:{action,requestId:crypto.randomUUID(),speakerId:getSpeaker()?.personId,...(current?{gameId:current.id,expectedRevision:current.revision}:{}),...extra};
  if(!command)return;requesting=true;localStorage.setItem(pendingKey,JSON.stringify(command));render();feedback.textContent='';
  try{
   const r=await api('games/chess',{method:'POST',body:JSON.stringify(command)});
   localStorage.removeItem(pendingKey);current=r.game;openId=current.id;selected=null;preview=null;
   // Acknowledgment commits the move. Close immediately, including recovery of
   // a lost acknowledgment; a slower follow-up read must not keep the board open
   // or turn an already-saved move into an apparent send failure.
   const known=games.find(g=>g.id===current.id);
   if(!known||known.revision<current.revision){games=[current,...games.filter(g=>g.id!==current.id)];gamesVersion++;}
   updateShelf();clickSound();if(command.action==='move')dialog.close();onHistory();
   void refresh().then(()=>dialog.open&&openId?load(openId):undefined).catch(()=>{});
  }
  catch(e){if(e.status>=400&&e.status<500){localStorage.removeItem(pendingKey);if(openId)await load(openId).catch(()=>{});}feedback.textContent=e.message;}
  finally{requesting=false;render();}
 }
 function choose(square){
  if(!current||current.paused||current.status!=='active'||current.turn!==getSpeaker()?.personId||requesting)return;
  if(preview){preview=null;selected=null;}
  const choices=current.legalMoves.filter(m=>m.from===selected&&m.to===square);
  if(choices.length>1){render();const promotion=el('div','chess-promotion'),picks=el('div','chess-promotion-choices');promotion.append(el('p','','Promote the pawn to…'));for(const m of choices){const b=button(names[m.promotion],'',()=>{preview=m;render();});b.prepend(piece(m.promotion,current.humanColor));picks.append(b);}promotion.append(picks);content.append(promotion);return;}
  if(choices.length){preview=choices[0];clickSound();render();return;}
  const p=pieces(current.fen)[square];selected=p?.color===current.humanColor?square:null;render();
 }
 function render(){
  content.replaceChildren();title.textContent=current?'Chess':'Chess with Samantha';more.classList.toggle('quiet',!current);more.tabIndex=current?0:-1;
  if(!current){
   const splash=el('div','chess-intro');splash.append(piece('n','b'),el('h3','','Your move. Whenever.'),el('p','','One move at a time, between everything else. Come back tonight, or next week. The board will be here.'));
   const colors=el('div','chess-colors');
   const side=(color,label,hint,primary)=>{const b=button('','chess-side'+(primary?' primary':''),()=>act('create',{color}));b.setAttribute('aria-label',label);b.append(piece('k',color),el('strong','',label),el('span','',hint));return b;};
   colors.append(side('w','Play as White','You open',true),side('b','Play as Black','She opens',false));splash.append(colors);content.append(splash);
   if(games.length){
    const earlier=el('div','chess-earlier'),rows=el('div','chess-rows');earlier.append(el('h4','','Earlier games'),rows);
    for(const g of games.slice(0,8)){
     const won=g.status==='finished'&&g.result!=='1/2-1/2'&&g.result===(g.humanColor==='w'?'1-0':'0-1'),lost=g.status==='finished'&&g.result!=='1/2-1/2'&&!won;
     const badge=el('span','chess-result '+(g.status!=='finished'?'live':won?'won':lost?'lost':''),g.status!=='finished'?'…':won?'W':lost?'L':'½');
     const b=row({label:statusText(g),hint:g.human.name+' as '+(g.humanColor==='w'?'White':'Black')+' · '+when(g.updatedAt),iconNode:badge,click:()=>void open(g.id)});b.querySelector('.chess-row-icon').replaceWith(badge);rows.append(b);
    }
    content.append(earlier);
   }
  }else{
   const g=current,mine=g.human.id===getSpeaker()?.personId,herMove=g.status==='active'&&!g.paused&&g.turn==='samantha',yourMove=g.status==='active'&&!g.paused&&g.turn!=='samantha';
   const plate=(name,initial,color,active,right)=>{const p=el('div','chess-plate'+(active?' active':'')+(right?' right':''));const text=el('span','chess-plate-text');const meta=el('span');meta.append(el('i','chess-swatch '+color),document.createTextNode(color==='w'?'White':'Black'));text.append(el('strong','',name),meta);p.append(el('span','chess-avatar',initial),text);return p;};
   const players=el('div','chess-players');players.append(plate('Samantha','S',g.samanthaColor,herMove,false),el('span','chess-vs','vs'),plate(g.human.name,(g.human.name||'?')[0].toUpperCase(),g.humanColor,yourMove,true));content.append(players);
   const status=el('p','chess-turn'+(herMove?' her':g.paused?' saved':g.status==='finished'?' over':''),statusText(g));status.setAttribute('aria-live','polite');content.append(status,boardElement(g,{interactive:true,selected,preview,onSquare:choose}));
   const actions=el('div','chess-actions');
   if(preview){actions.append(button('Send '+preview.san,'chess-primary',()=>act('move',{move:preview.uci})),button('Undo preview','chess-secondary',()=>{preview=null;selected=null;render();}));}
   else if(g.status==='finished'){actions.append(button('Play again','chess-primary',()=>{current=null;openId=null;render();}));}
   else if(!mine){actions.append(el('p','chess-note','Switch to '+g.human.name+' to play this game.'));}
   else if(g.paused){actions.append(button('Continue our game','chess-primary',()=>act('resume')));}
   else if(['failed','uncertain'].includes(g.reply?.phase)&&g.turn==='samantha'){actions.append(button('Ask her to try this turn again','chess-primary',()=>act('retry')));}
   else actions.append(el('p','chess-note',g.turn==='samantha'?'You can leave the app. Her move will be saved here.':'Tap a piece, choose a square, then send your move.'));
   content.append(actions);
   if(g.reply?.error&&g.turn==='samantha')content.append(el('p','chess-error',g.reply.error));
   if(g.drawOffer){const offer=el('div','chess-draw');offer.append(el('span','',g.drawOffer==='samantha'?'Samantha offered a draw.':'Draw offered.'));if(g.drawOffer!==getSpeaker()?.personId&&mine)offer.append(button('Accept','',()=>act('accept_draw')),button('Keep playing','',()=>act('decline_draw')));content.append(offer);}
   if(g.lastMove?.comment){const quote=el('div','chess-comment');quote.append(el('i','chess-comment-dot'),el('span','','Samantha'),el('q','',g.lastMove.comment));content.append(quote);}
   const strip=el('div','chess-moves');strip.setAttribute('aria-label','Moves');
   for(let i=0;i<g.moves.length;i+=2){const chip=el('span','chess-move'+(i+2>=g.moves.length?' latest':''));chip.append(el('b','',String(i/2+1)+'.'),el('em','',g.moves[i].san));if(g.moves[i+1])chip.append(el('em','',g.moves[i+1].san));strip.append(chip);}
   content.append(strip);requestAnimationFrame(()=>{strip.scrollLeft=strip.scrollWidth;});
  }
  if(pending())content.append(button('Check saved action','chess-secondary',()=>act('recover')));
  if(requesting)for(const b of content.querySelectorAll('button'))b.disabled=true;
 }
 function connect(){source?.close();source=new EventSource('/api/games/chess/events');source.onmessage=e=>{try{const d=JSON.parse(e.data);const changed=JSON.stringify(games.map(g=>[g.id,g.revision]))!==JSON.stringify((d.games??[]).map(g=>[g.id,g.revision]));receiveGames(d.games??[]);if(changed)onHistory();if(dialog.open&&openId){const g=games.find(g=>g.id===openId);if(g&&(g.revision!==current?.revision||JSON.stringify(g.reply)!==JSON.stringify(current?.reply)))void load(openId).catch(e=>feedback.textContent=e.message);}}catch{}};}
 function resume(){void refresh().catch(()=>{});if(dialog.open&&openId)void load(openId).catch(e=>feedback.textContent=e.message);}
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)resume();});
 connect();void refresh().catch(()=>{});
 return {open,resume,speakerChanged:()=>{updateShelf();if(dialog.open)render();},setCard:(wrap,g)=>setChessCard(wrap,g,{open}),close:()=>{source?.close();dialog.remove();extras.remove();moreSheet.remove();shelf.remove();}};
}
