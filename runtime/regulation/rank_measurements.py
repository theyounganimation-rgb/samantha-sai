"""Read-only measurements of a committed choice, with no action authority."""
import copy

def winner(rows,key):return sorted(rows,key=lambda r:(-r[key],r['id']))[0]['id']

def compare(options,scores,weight_fn=None,wellbeing=None,expression_fn=None):
    # Same authored menu/ratings; no second model call and no alternative action.
    scores=[{**r,'noAffect':r.get('bandedUtility',r['baseUtility'])+r.get('goalAdjustment',0.),'affect':r.get('affectAdjustment',r['adjustment'])} for r in scores]
    live=winner(scores,'score');base=winner(scores,'noAffect')
    ranked=sorted(scores,key=lambda r:(-r['noAffect'],r['id']))
    top=ranked[0];rival=ranked[1]
    adjustment=[r['affect'] for r in scores]
    measurements={
      'version':3,'counterfactual':'same menu, utility band and configured goal values; all affect adjustment removed'
      ,'ratingWinner':winner(scores,'baseUtility'),'goalChangedWinner':base!=winner(scores,'baseUtility')
      ,'goalAdjustments':{r['id']:r.get('goalAdjustment',0.) for r in scores},
      'selected':live,'baseWinner':base,'winnerChanged':live!=base,
      'baseMargin':top['noAffect']-rival['noAffect'],
      'liveMarginForBasePair':top['score']-rival['score'],
      'marginChangeForBasePair':top['affect']-rival['affect'],
      'adjustmentSpread':max(adjustment)-min(adjustment),
      'largestAdjustmentOption':winner(scores,'affect'),
      'featureRanges':{k:max(o['features'][k] for o in options)-min(o['features'][k] for o in options) for k in options[0]['features']},
      'maxConnectionFeature':max(o['features']['connection'] for o in options),
      'maxRestFeature':max(o['features']['rest'] for o in options),
      'concernLinksDiffer':len({tuple(sorted(o['concernIds'])) for o in options})>1,
      'emotionKnockouts':None,'wellbeingNeutral':None,
      'limit':'This isolates direct ranking effects conditional on the recorded menu. State may also affect recall, option generation, and ratings; those effects are not isolated here.'}
    if weight_fn is not None and wellbeing is not None:
        lookup={o['id']:o for o in options}
        def rerank(name=None,well=None):
            rows=[]
            for s in scores:
                x=copy.deepcopy(s['scopedValues'])
                if name is not None:x[name]=0
                w=weight_fn(x,wellbeing if well is None else well)
                o=lookup[s['id']]
                rows.append({'id':s['id'],'score':s.get('bandedUtility',o['baseUtility'])+s.get('goalAdjustment',0.)+sum(w[k]*o['features'][k] for k in w)+(expression_fn(x,o) if expression_fn else 0.)})
            return {'winner':winner(rows,'score'),'scores':{r['id']:r['score'] for r in rows}}
        measurements['emotionKnockouts']={name:rerank(name) for name in scores[0]['scopedValues']}
        measurements['wellbeingNeutral']=rerank(well=.65)
    return measurements
