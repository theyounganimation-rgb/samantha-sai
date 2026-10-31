// Her chess move as something she would say out loud on a call. Notation is for the
// board; a voice needs words. If her comment already names the move, the comment is
// the whole line; otherwise the move comes first and the comment follows.
const PIECES={K:'king',Q:'queen',R:'rook',B:'bishop',N:'knight'};
export function spokenSan(san){
  const raw=String(san??'').trim();if(!raw)return '';
  const mate=/#$/.test(raw),check=/\+$/.test(raw),s=raw.replace(/[+#]+$/,'');
  let base;
  if(/^O-O-O/.test(s))base='castles long';
  else if(/^O-O/.test(s))base='castles';
  else{
    const m=s.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?$/);
    if(!m)return raw;
    const [,piece,file,,takes,to,promo]=m;
    const name=piece?PIECES[piece]:(takes&&file?`${file} pawn`:'pawn');
    base=takes?`${name} takes on ${to}`:`${name} to ${to}`;
    if(promo)base+=` and promotes to ${PIECES[promo]}`;
  }
  return base+(mate?', checkmate':check?', check':'');
}
// October 22, later: on a call the board already shows the move, so nothing is announced for her.
// Only a comment she actually wrote is spoken, as she wrote it. Empty means she just played on.
export function spokenOnCall(comment){return String(comment??'').replace(/\s+/g,' ').trim();}
export function spokenMove(move,comment){
  const said=String(comment??'').replace(/\s+/g,' ').trim();
  const words=spokenSan(move?.san);
  if(!said)return words?`I played ${words}.`:'';
  if(/\b(played|moved?|takes?|took|castl\w*|knight|bishop|rook|queen|king|pawn|check(mate)?)\b/i.test(said))return said;
  return words?`${words[0].toUpperCase()+words.slice(1)}. ${said}`:said;
}
