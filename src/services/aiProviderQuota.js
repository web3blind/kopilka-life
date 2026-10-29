const ZONE = 'America/Los_Angeles';
const dateFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const localDay = timestamp => dateFormatter.format(new Date(timestamp));
const MINUTE = 60000;
const LIMITS = Object.freeze({ rpm:15, inputTpm:250000, rpd:500 });
// Find the UTC instant at the Pacific date boundary, not a fixed 24h day.
function dayWindow(now) {
  const date = localDay(now);
  let lo=now-27*3600000, hi=now;
  while(hi-lo>1) {const mid=Math.floor((lo+hi)/2);if(localDay(mid)===date)hi=mid;else lo=mid;}
  const start=hi;lo=now;hi=now+27*3600000;
  while(hi-lo>1) {const mid=Math.floor((lo+hi)/2);if(localDay(mid)===date)lo=mid;else hi=mid;}
  return {start,end:hi};
}
function inspect(db,now=Date.now(),inputBound=1) {
  const latest=db.prepare('SELECT MAX(reserved_at) stamp FROM ai_provider_quota').get().stamp;
  // On clock rollback, nothing can be admitted before the newest durable stamp.
  const effectiveNow=Math.max(now,latest || now), day=dayWindow(effectiveNow);
  const recent=db.prepare('SELECT reserved_at,input_bound FROM ai_provider_quota WHERE reserved_at>? ORDER BY reserved_at,id').all(effectiveNow-MINUTE);
  const daily=db.prepare('SELECT COUNT(*) n FROM ai_provider_quota WHERE reserved_at>=? AND reserved_at<?').get(day.start,day.end).n;
  let next=effectiveNow, count=recent.length, tokens=recent.reduce((sum,row)=>sum+row.input_bound,0);
  for(const row of recent) {
    if(count<LIMITS.rpm && tokens+inputBound<=LIMITS.inputTpm)break;
    count--;tokens-=row.input_bound;next=Math.max(next,row.reserved_at+MINUTE);
  }
  if(daily>=LIMITS.rpd)next=Math.max(next,day.end);
  if(inputBound>LIMITS.inputTpm)next=Math.max(next,now+MINUTE);
  const allowed=next===now;
  return {allowed,nextAvailableAt:allowed?null:new Date(next).toISOString(),retryAfter:allowed?0:Math.max(1,Math.ceil((next-now)/1000))};
}
// Caller owns BEGIN IMMEDIATE and inserts the user claim in that same transaction.
function reserve(db,now,inputBound) {
  if(!db.inTransaction)throw new Error('Gemini admission requires a transaction');
  if(!Number.isSafeInteger(inputBound)||inputBound<=0)throw new Error('Invalid input bound');
  const result=inspect(db,now,inputBound);
  if(!result.allowed) {
    const error=new Error('AI_PROJECT_QUOTA_EXCEEDED');
    Object.assign(error,{safeCode:'AI_PROJECT_QUOTA_EXCEEDED',status:429,...result});throw error;
  }
  db.prepare('INSERT INTO ai_provider_quota(reserved_at,input_bound) VALUES(?,?)').run(now,inputBound);
}
module.exports={inspect,reserve,dayWindow,LIMITS};
