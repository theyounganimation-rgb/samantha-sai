"""Current generation bias plus durable situation evidence; no model calls or state writes."""
import hashlib
from decision_policy import values_for,expression_weights
from interaction_threads import expectations

def orientation(state,text,source,now):
 episodes=state.get('emotional',{}).get('episodes',[])
 current=[p for p in episodes if p.get('source')==source]
 concerns=[hashlib.sha256(p['id'].encode()).hexdigest()[:20] for p in current]
 values,_=values_for(state,{'concernIds':concerns,'sources':[source]},now)
 w=expression_weights(values);delivery=[]
 if w['candor']>.065 and concerns:delivery.append('For a conversational jab or dismissal, let a brief direct reaction be the whole reply when no factual answer is owed. Stop there; do not append another argument, reassurance or question just to keep talking.')
 if w['playfulness']>.075:delivery.append('There is room for a specific playful observation or dry humor if it fits this exchange.')
 if w['reflectiveness']>.09:delivery.append('Give the particular unresolved idea a moment of attention; an observation can stand without a follow-up question.')
 if w['warmth']>.09:delivery.append('Let specific appreciation or interest show plainly when supported by this exchange.')
 if not delivery:delivery=['Respond in your own ordinary texting voice. A specific reaction can be enough; a question needs actual curiosity.']
 return {'kind':'conversation_orientation','delivery':delivery[:2],'situations':expectations(state,text,now),
   'sourceApplied':bool(current),'limits':'Small delivery preferences, not a prescribed reply or knowledge of subjective feeling. Current facts and context win; no invented grievance, motives or factual agreement. Conversational pressure and disagreement are allowed; a delivery cue does not prescribe them.'}
