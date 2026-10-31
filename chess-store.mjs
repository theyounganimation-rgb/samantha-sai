import {DatabaseSync} from 'node:sqlite';
import {Chess} from 'chess.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const error=(message,status=409)=>Object.assign(Error(message),{status});
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(id);
export const isOpus55=model=>/(?:^|\/)claude-opus-5-5$/.test(model??'');
const opposite=c=>c==='w'?'b':'w';
export function boardFor(game){const board=new Chess();for(const m of game.moves)board.move({from:m.uci.slice(0,2),to:m.uci.slice(2,4),promotion:m.uci[4]});return board;}
function resultFor(board){
 if(board.isCheckmate())return {result:board.turn()==='w'?'0-1':'1-0',reason:'checkmate'};
 if(board.isStalemate())return {result:'1/2-1/2',reason:'stalemate'};
 if(board.isInsufficientMaterial())return {result:'1/2-1/2',reason:'insufficient material'};
 if(board.isThreefoldRepetition())return {result:'1/2-1/2',reason:'threefold repetition'};
 if(board.isDrawByFiftyMoves())return {result:'1/2-1/2',reason:'fifty-move rule'};
 return null;
}
export function gameView(game,{legal=true}={}){
 const board=!legal&&game.fen?new Chess(game.fen):boardFor(game),turn=board.turn()===game.humanColor?game.human.id:'samantha';
 if(legal){board.setHeader('White',game.humanColor==='w'?game.human.name:'Samantha');board.setHeader('Black',game.humanColor==='b'?game.human.name:'Samantha');board.setHeader('Result',game.result??'*');}
 return {id:game.id,revision:game.revision,human:game.human,humanColor:game.humanColor,samanthaColor:opposite(game.humanColor),
  status:game.status,paused:game.paused,pausedBy:game.pausedBy??(game.paused?game.human.id:null),result:game.result??null,reason:game.reason??null,drawOffer:game.drawOffer??null,
  createdAt:game.createdAt,updatedAt:game.updatedAt,turn,fen:board.fen(),check:board.isCheck(),
  moves:legal?game.moves:game.moves.slice(-8),...(legal?{pgn:board.pgn()}:{}),lastMove:game.moves.at(-1)??null,
  ...(legal?{legalMoves:game.status==='active'&&!game.paused?board.moves({verbose:true}).map(m=>({from:m.from,to:m.to,...(m.promotion?{promotion:m.promotion}:{}),san:m.san,after:m.after,uci:m.from+m.to+(m.promotion??'')})):[]}:{}),
  opponent:{name:'Samantha',model:'claude-opus-5-5'},clock:null};
}

// One server owns the board. Each accepted command, move card and next wake are
// committed together; a disconnected device can retry its SAME request ID.
export function createChessStore({file,now=Date.now,onChange=()=>{}}){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const db=new DatabaseSync(file);fs.chmodSync(file,0o600);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, human TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, game TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, game TEXT NOT NULL, revision INTEGER NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, error TEXT);
 CREATE INDEX IF NOT EXISTS games_recent ON games(updated DESC);
 CREATE INDEX IF NOT EXISTS cards_recent ON cards(at DESC);
 CREATE INDEX IF NOT EXISTS jobs_phase ON jobs(phase,at);`);
 const load=id=>{const row=db.prepare('SELECT data FROM games WHERE id=?').get(id);if(!row)throw error('This game could not be found.',404);return JSON.parse(row.data);};
 const jobFor=id=>db.prepare('SELECT id,revision,phase,at,error FROM jobs WHERE game=? ORDER BY at DESC,rowid DESC LIMIT 1').get(id);
 const view=(g,options)=>{const v=gameView(g,options),j=jobFor(g.id);return {...v,reply:j?{phase:j.phase,error:j.error??null}:null};};
 const save=g=>db.prepare('INSERT INTO games VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated=excluded.updated,data=excluded.data').run(g.id,g.human.id,g.status,g.updatedAt,JSON.stringify(g));
 const wake=g=>{if(g.status==='active'&&!g.paused&&boardFor(g).turn()!==g.humanColor)db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,NULL)').run('sai-chess-'+crypto.randomUUID(),g.id,g.revision,'queued',now());};
 const card=(g,actor,kind,comment='')=>{
  const snapshot=gameView(g,{legal:false});delete snapshot.moves;delete snapshot.pgn;
  const who=actor==='samantha'?{personId:'samantha',name:'Samantha'}:{personId:g.human.id,name:g.human.name};
  const row={id:`chess-${g.id}-${g.revision}`,role:actor==='samantha'?'assistant':'user',timestamp:g.updatedAt,
   speaker:who,recipient:actor==='samantha'?{personId:g.human.id,name:g.human.name}:{personId:'samantha',name:'Samantha'},
   text:comment,game:{...snapshot,event:kind}};
  db.prepare('INSERT INTO cards VALUES(?,?,?,?)').run(row.id,g.id,g.updatedAt,JSON.stringify(row));
 };
 function act(args,{actor,human,model,sessionKey}={}){
  if(!validId(args.requestId))throw error('A stable request ID is required.',400);
  const digest=crypto.createHash('sha256').update(JSON.stringify({args,actor,human:human?.id,model,sessionKey})).digest('hex');
  let changed=false,result;
  db.exec('BEGIN IMMEDIATE');
  try{
   const prior=db.prepare('SELECT digest,response FROM commands WHERE id=?').get(args.requestId);
   if(prior){if(prior.digest!==digest)throw error('This request ID belongs to a different action.');db.exec('COMMIT');return JSON.parse(prior.response);}
   if(actor==='samantha'&&!isOpus55(model))throw error('Chess moves belong to Samantha’s Opus 5.5 session. No substitute model was used.',403);
   let g;
   if(args.action==='create'){
    if(actor==='samantha'||!human?.id||actor!==human.id)throw error('Start the game from SAI.',403);
    if(!['w','b'].includes(args.color))throw error('Choose White or Black.',400);
    if(db.prepare("SELECT id FROM games WHERE human=? AND status='active'").get(actor))throw error('Finish or resume your existing game first.');
    g={id:crypto.randomUUID(),revision:1,human:{id:human.id,name:human.name},humanColor:args.color,status:'active',paused:false,fen:new Chess().fen(),moves:[],createdAt:now(),updatedAt:now()};
    save(g);card(g,actor,'started');wake(g);changed=true;
   }else{
    if(!validId(args.gameId))throw error('Invalid game ID.',400);g=load(args.gameId);
    if(actor!=='samantha'&&actor!==g.human.id)throw error(`This game is with ${g.human.name}. Switch the speaker to play.`,403);
    if(args.expectedRevision!==g.revision)throw error('The board changed on another device. Review the latest position.');
    if(g.status!=='active')throw error('This game has finished. Start a new one.');
    const board=boardFor(g),color=actor==='samantha'?opposite(g.humanColor):g.humanColor;
    let kind=args.action,comment='';
    if(args.action==='move'){
     if(g.paused)throw error('Resume this game before moving.');
     if(board.turn()!==color)throw error('It is the other player’s turn.');
     if(typeof args.move!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(args.move))throw error('Choose a legal move, including promotion when needed.',400);
     let move;try{move=board.move({from:args.move.slice(0,2),to:args.move.slice(2,4),promotion:args.move[4]});}catch{throw error('That move is not legal in the current position.',400);}
     if(actor==='samantha'&&args.comment!==undefined){if(typeof args.comment!=='string'||args.comment.length>280)throw error('Keep the game comment under 280 characters.',400);comment=args.comment.trim();}
     g.moves.push({uci:args.move,san:move.san,from:move.from,to:move.to,...(move.promotion?{promotion:move.promotion}:{}),...(move.captured?{captured:move.captured}:{}),color:move.color,at:now(),by:actor,...(actor==='samantha'?{model,sessionKey,comment}:{})});
     if(g.drawOffer&&g.drawOffer!==actor)g.drawOffer=null;
     g.fen=board.fen();const end=resultFor(board);if(end){g.status='finished';Object.assign(g,end);}
    }else if(args.action==='pause'||args.action==='resume'){
     if(actor==='samantha'&&args.action==='resume'&&g.paused&&(g.pausedBy??g.human.id)!=='samantha')throw error('Your opponent paused this game; wait for them to resume it.',403);
     if(g.paused===(args.action==='pause'))throw error(g.paused?'This game is already saved for later.':'This game is already active.');
     g.paused=args.action==='pause';
     g.pausedBy=g.paused?actor:null;
    }else if(args.action==='resign'){
     g.status='finished';g.reason='resignation';g.result=color==='w'?'0-1':'1-0';
    }else if(args.action==='offer_draw'){
     if(g.drawOffer)throw error('There is already a draw offer.');g.drawOffer=actor;
    }else if(args.action==='accept_draw'){
     if(!g.drawOffer||g.drawOffer===actor)throw error('There is no draw offer from the other player.');g.status='finished';g.reason='agreed draw';g.result='1/2-1/2';
    }else if(args.action==='decline_draw'){
     if(!g.drawOffer||g.drawOffer===actor)throw error('There is no draw offer from the other player.');g.drawOffer=null;
    }else if(args.action==='retry'){
     const j=jobFor(g.id);if(!j||!['failed','uncertain'].includes(j.phase))throw error('Her turn is already queued or completed.');
     if(g.paused||board.turn()===g.humanColor)throw error('It is not Samantha’s active turn.');
    }else throw error('Unknown chess action.',400);
    g.revision++;g.updatedAt=now();save(g);
    db.prepare("UPDATE jobs SET phase='superseded' WHERE game=? AND phase='queued'").run(g.id);
    if(args.action!=='retry')card(g,actor,kind,comment);
    wake(g);changed=true;
   }
   result={ok:true,game:view(g)};
   db.prepare('INSERT INTO commands VALUES(?,?,?)').run(args.requestId,digest,JSON.stringify(result));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  if(changed)onChange();return result;
 }
 return {act,
  get:id=>view(load(id)),
  list:()=>db.prepare("SELECT data FROM games ORDER BY (status='active') DESC,updated DESC LIMIT 30").all().map(r=>view(JSON.parse(r.data),{legal:false})),
  cards:()=>db.prepare('SELECT data FROM cards ORDER BY at DESC,rowid DESC LIMIT 60').all().map(r=>JSON.parse(r.data)).reverse(),
  jobs:()=>db.prepare("SELECT * FROM jobs WHERE phase IN ('queued','dispatching','accepted') ORDER BY at,rowid").all(),
  job:id=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id),
  mark(id,phase,message=null){db.prepare('UPDATE jobs SET phase=?,error=? WHERE id=?').run(phase,message,id);onChange();},
  close:()=>db.close()};
}

export function mergeGameCards(messages,cards){
 const map=new Map(messages.map(m=>[m.id,m]));for(const card of cards)map.set(card.id,card);
 return [...map.values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)||String(a.id).localeCompare(String(b.id))).slice(-80);
}
