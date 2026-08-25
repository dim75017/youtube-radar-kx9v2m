'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const evaluate=(relative,name)=>{
  const context={window:{}};
  vm.createContext(context);
  vm.runInContext(read(relative),context,{timeout:10_000});
  return context.window[name];
};

const index=read('spotify/index.html');
const instantRuntime=read('spotify/instant.js');
const analyticsRuntime=read('spotify/track-analytics.js');
const analyticsCss=read('spotify/track-analytics.css');
const instant=evaluate('Spotify_Instant_data.js','SPOTIFY_INSTANT');
const catalogue=evaluate('Spotify_Catalogue_data.js','SPOTIFY_CATALOGUE');

assert.doesNotMatch(index,/track-analytics\.js|player\.js|Spotify_Performance_tracks/,
  'analytics, player, and histories must stay outside the first-paint document');
assert.match(instantRuntime,/Promise\.all\(\[loadFullCatalogue\(\),loadTrackAnalytics\(\)\]\)/,
  'opening a real lightweight track card must hydrate its catalogue details and analytical renderer');
assert.match(instantRuntime,/analyticsModule\.open\(/,
  'the reachable lightweight modal must delegate to the analytical renderer');
assert.doesNotMatch(instantRuntime,/fast-open-spotify[\s\S]*openSpotify/,
  'the reachable modal must not replace the custom player with an external Spotify action');

for(const token of [
  'SpotifyRadarPlayer.html','data-track-performance','data-track-chart','data-track-offer',
  "data-track-metric=\"streams\"","data-track-metric=\"revenue\"",
  'data-track-period','editorial_placements','editorial_min_followers',
  'Spotify_Performance_tracks','counterWindow','dailyFlowSeries','spark-tooltip',
])assert.ok(analyticsRuntime.includes(token),`missing analytical runtime contract: ${token}`);
assert.match(analyticsCss,/\.tmbox\.track-analytics-box/);
assert.match(analyticsCss,/\.track-analytics-player/);
assert.ok(fs.statSync(path.join(root,'spotify','track-analytics.js')).size<=55_000,
  'the user-triggered analytical renderer must remain compact');

assert.equal(catalogue.version,3);
assert.equal(instant.version,3);
assert.equal(JSON.stringify(instant.schemas.tracks),JSON.stringify(catalogue.schemas.tracks));
assert.ok(catalogue.analytics&&catalogue.analytics.performance);
assert.equal(catalogue.analytics.editorial_min_followers,10_000);
const manifest=catalogue.analytics.performance;
assert.equal(manifest.algorithm,'sha256_mod');
assert.equal(manifest.shard_count,16);
assert.equal(manifest.shards.length,16);
assert.equal(JSON.stringify(manifest.shard_schema),JSON.stringify(['bucket','path','sha256','tracks']));
for(const descriptor of manifest.shards){
  assert.equal(descriptor.length,4);
  assert.ok(fs.existsSync(path.join(root,descriptor[1])),`missing public performance shard ${descriptor[1]}`);
}

const fields=Object.fromEntries(catalogue.schemas.tracks.map((field,index)=>[field,index]));
for(const required of [
  'preview_hash','performance_bucket','performance_available','editorial_placements',
  'instrumental_status','instrumental_confidence','ai_risk','ai_risk_score',
  'genre_confidence','subgenres',
])assert.ok(Number.isInteger(fields[required]),`missing compact track detail field ${required}`);

const detailed=catalogue.tracks.find(row=>row[fields.performance_available]===true&&
  /^[a-f0-9]{40}$/.test(row[fields.preview_hash])&&row[fields.editorial_placements].length>0);
assert.ok(detailed,'the complete catalogue must expose at least one fully analytical track');
const spotifyId=detailed[fields.spotify_id];
const expectedBucket=crypto.createHash('sha256').update(spotifyId,'utf8').digest().readUInt32BE(0)%manifest.shard_count;
assert.equal(detailed[fields.performance_bucket],expectedBucket,
  'the catalogue bucket must match the immutable sha256_mod shard contract');
const descriptorSchema=Object.fromEntries(manifest.shard_schema.map((field,index)=>[field,index]));
const detailedDescriptor=manifest.shards.find(row=>row[descriptorSchema.bucket]===expectedBucket);
const shardContext={window:{}};
vm.createContext(shardContext);
vm.runInContext(read(detailedDescriptor[descriptorSchema.path]),shardContext,{timeout:10_000});
assert.ok(shardContext.window.SPOTIFY_PERFORMANCE_TRACK_SHARD.tracks[spotifyId],
  'a detailed catalogue row must resolve to its real lazily loaded history entry');
for(const placement of detailed[fields.editorial_placements]){
  assert.ok(Number(placement[3])>=10_000,
    'every playlist exposed in track detail must individually clear 10k followers');
}
for(const row of instant.tracks.concat(instant.radar)){
  assert.equal(row[fields.preview_hash],'','first paint must not duplicate preview hashes');
  assert.equal(row[fields.editorial_placements].length,0,'first paint must not include detail playlist arrays');
}

const subject=require('../spotify/track-analytics.js').__test;
const history=[
  ['2026-07-01',100],['2026-07-02',112],['2026-07-03',130],
  ['2026-07-09',190],['2026-07-10',220],['2026-07-16',280],['2026-07-17',310],
];
const oneDay=subject.counterWindow(history,1);
assert.equal(oneDay.current,30);
assert.equal(oneDay.currentReady,true);
assert.equal(oneDay.comparisonReady,false,
  'comparison must remain unavailable without the exact D-2 baseline');
const sevenDays=subject.counterWindow(history,7);
assert.equal(sevenDays.current,90);
assert.equal(sevenDays.previous,90);
assert.equal(sevenDays.comparisonReady,true);
assert.deepEqual(subject.dailyFlowSeries(history),[
  ['2026-07-02',12],['2026-07-03',18],['2026-07-10',30],['2026-07-17',30],
], 'daily flow must never spread a multi-day counter gap over invented days');

console.log(`Spotify track analytics runtime: ${catalogue.counts.tracks} detailed tracks, ${manifest.shard_count} lazy shards`);
