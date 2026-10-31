// The controller ranks IDs using only these fields. Full current views and
// revision histories remain in the continuity store and the caller's context.
export function threadRankingMetadata(threads,terms){
 return threads.map(t=>({id:t.id,relevance:t.relevance,updatedAt:t.updatedAt,terms:terms(`${t.title} ${t.nextStep}`)}));
}
