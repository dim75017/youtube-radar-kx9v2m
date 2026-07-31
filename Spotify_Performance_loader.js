(()=>{
  const performance=window.SPOTIFY_PERFORMANCE;
  const manifest=performance&&performance.track_shards;
  if(!manifest){
    window.SPOTIFY_PERFORMANCE_STORE_READY=true;
    return;
  }
  const fail=message=>{
    window.SPOTIFY_PERFORMANCE_STORE_READY=false;
    window.SPOTIFY_PERFORMANCE_STORE_ERROR=message;
    if(performance&&performance.freshness) performance.freshness.tracks_catalogue_at=null;
  };
  if(!Array.isArray(manifest.shards)||manifest.shards.length!==manifest.shard_count){
    fail('Performance track manifest is incomplete');
    return;
  }
  window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED={};
  const buckets=new Set();
  for(const shard of manifest.shards){
    if(!shard||!Number.isInteger(shard.bucket)||shard.bucket<0||shard.bucket>=manifest.shard_count||buckets.has(shard.bucket)||!Number.isInteger(shard.tracks)||shard.tracks<0||typeof shard.sha256!=='string'||!/^[a-f0-9]{64}$/.test(shard.sha256)||typeof shard.path!=='string'||!/^[A-Za-z0-9_./-]+$/.test(shard.path)||shard.path.includes('..')){
      fail('Performance track manifest contains an invalid shard descriptor');
      return;
    }
    buckets.add(shard.bucket);
    const version=String(shard.sha256||'').slice(0,16);
    document.write('<script src="../'+shard.path+'?v='+version+'"><\/script>');
  }
  document.write('<script>(()=>{const p=window.SPOTIFY_PERFORMANCE||{};const m=p.track_shards||{};const n=Object.keys(p.tracks||{}).length;const loaded=window.SPOTIFY_PERFORMANCE_TRACK_SHARDS_LOADED||{};const complete=Array.isArray(m.shards)&&m.shards.every(s=>loaded[s.bucket]===s.tracks);window.SPOTIFY_PERFORMANCE_STORE_READY=n===m.tracks_total&&complete;if(!window.SPOTIFY_PERFORMANCE_STORE_READY){window.SPOTIFY_PERFORMANCE_STORE_ERROR="Performance track shards are incomplete";if(p.freshness)p.freshness.tracks_catalogue_at=null;}})();<\/script>');
})();
