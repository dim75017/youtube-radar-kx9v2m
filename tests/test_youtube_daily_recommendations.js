'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const start = source.indexOf('const RECO_DAILY_LIMIT=50;');
const end = source.indexOf('function recoCardHTML(r,i){', start);
assert.ok(start >= 0 && end > start, 'daily recommendation helpers must remain available');

const DEFAULT_V4_POOL = {
  schema: 3, version: 4, buildId: 'test-v4', ledgerRevision: 'test-ledger', modelRevision: 'test-model',
  sourceT: 0, feedbackT: 0,
};

function makeContext(recos, stored, ownedRows, pool) {
  let rerenders = 0;
  const usesDefaultV4Pool = pool === undefined;
  if (usesDefaultV4Pool) {
    recos.forEach(row => {
      if (!row.valid && row._generatorVersion == null) row._generatorVersion = 4;
    });
    pool = Object.assign({}, DEFAULT_V4_POOL);
  }
  const context = {
    DATA: {recos},
    LANG: 'fr',
    Date,
    Intl,
    Set,
    Map,
    Object,
    Number,
    String,
    Math,
    JSON,
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, value); },
    },
    normalizedRecommendationTitle(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    },
    persoCategory: value => value || 'Sans personnage',
    isValidated: value => /^X/.test(value || ''),
    isRefused: value => /^-/.test(value || ''),
    recommendationRoadmapEntry: () => null,
    setActiveContinuousRecommendationVariants: () => {},
    rerenderRecos: () => { rerenders += 1; },
    anaRows: () => ownedRows,
    window: pool ? {LOFI_RECOMMENDATION_POOL: pool} : {},
  };
  vm.runInNewContext(`${source.slice(start, end)};
    this.dailyRecommendationSet = dailyRecommendationSet;
    this.activeDailyRecommendationCount = activeDailyRecommendationCount;
    this.recoProfile = recoProfile;
    this.recoDailyScore = recoDailyScore;
    this.recoPotentialForScore = recoPotentialForScore;
    this.refreshDailyRecommendations = refreshDailyRecommendations;
    this.finalizeDailyRecommendationHistoryProfile = finalizeDailyRecommendationHistoryProfile;
    this.recoPerformanceSignal = recoPerformanceSignal;
    this.recoHorizonWeight = recoHorizonWeight;
    this.recoSourceRecencyBoost = recoSourceRecencyBoost;
    this.recoVideoFields = recoVideoFields;`, context);
  context.recoGenreKey = context.recoGenreKey || vm.runInNewContext('recoGenreKey', context);
  context.recoPurposeKey = context.recoPurposeKey || vm.runInNewContext('recoPurposeKey', context);
  context.recoNormalizedTopicKey = context.recoNormalizedTopicKey || vm.runInNewContext('recoNormalizedTopicKey', context);
  context.rerenderRecos = () => { rerenders += 1; };
  context.rerenderCount = () => rerenders;
  return context;
}

// More than 100 pending candidates clear the quality floor, so this fixture
// still verifies the normal full 50-card review batch.
const recos = Array.from({length: 126}, (_, index) => ({
  n: index + 1,
  title: `Concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: index % 3 ? 'Girl' : 'Boy',
  concept: index % 2 ? 'rainy room focus' : 'quiet forest focus',
  score: 88 + (index % 5),
  valid: index === 124 ? 'X' : index === 125 ? '-' : '',
  _conceptFamily: `concept-family-${index + 1}`,
  _titleFamily: index < 60 ? 'dominant-title-family' : `title-family-${index + 1}`,
}));
const stored = new Map([
  ['lofi_radar_reco_rotation_v4', JSON.stringify({'2026-07-22': [1,2,3,4,5,6,7,8,9,10]})],
  ['lofi_radar_roadmap_archive_v3', '[]'],
]);
const ownedRows = [
  {ageM: 1, pctCh: 92, title: 'Published recent lofi focus', genre: 'Lofi', reco: recos[29], st: {ctr: 6.5, awp: 48}},
  {ageM: 7, pctCh: 85, genre: 'Ambient', perso: 'Girl', title: 'Forest focus', st: {ctr: 5.5, awp: 44}},
];
const context = makeContext(recos, stored, ownedRows);

const daily = context.dailyRecommendationSet();
assert.equal(daily.length, 50, '100+ qualified candidates still produce the normal 50-card batch');
assert.ok(daily.every(r => !/^X|^-/.test(r.valid || '')), 'validated and refused concepts are excluded');
assert.ok(daily.every(r => r.n > 10), 'recently shown concepts are not repeated while enough qualified candidates remain');
assert.ok(daily.filter(row => row._titleFamily === 'dominant-title-family').length > 1,
  'a broad genre/style title family does not impose an artificial one-card quota');
assert.ok(daily.every(r => Array.isArray(r._dailyReasons) && r._dailyReasons.length >= 2), 'every concept exposes selection reasons');
assert.ok(daily.some(r => r._dailyReasons.some(reason => /Signal cha|Recent channel signal/.test(reason))), 'recent channel performance contributes an explainable signal');
assert.equal(context.recoProfile().windows['12m'], 1,
  'an owned video without a linked recommendation contributes over the 12-month horizon');
assert.match(source, /ageMonths<=60/, 'the ranking keeps explicit long-tail history buckets');
assert.match(source, /return \{id:'evergreen',weight:/,
  'the ranking has no hard cutoff after the first five years');
assert.match(source, /RECO_DAILY_LIMIT=50/, '50 remains a maximum, not a filler target');
assert.match(source, /RECO_ROTATION_KEY='lofi_radar_reco_rotation_v4'/,
  'the full-history learning model resets the rotation in the v4 storage namespace');
assert.equal(context.recoHorizonWeight(1).weight, 1.25,
  'videos published in the last 3 months receive the strongest learning weight');
assert.ok(context.recoHorizonWeight(4).weight < context.recoHorizonWeight(1).weight,
  'the 3-6 month horizon contributes less than the latest 3 months');
assert.ok(context.recoHorizonWeight(8).weight < context.recoHorizonWeight(4).weight,
  'the 6-12 month horizon remains useful but secondary');
assert.ok(context.recoHorizonWeight(18).weight < context.recoHorizonWeight(8).weight,
  'the 12-24 month horizon remains useful with a smaller weight');
assert.ok(context.recoHorizonWeight(36).weight < context.recoHorizonWeight(18).weight,
  'the 24-60 month horizon remains useful with a smaller weight');
assert.ok(context.recoHorizonWeight(72).weight < context.recoHorizonWeight(36).weight,
  'evergreen results remain available with the smallest positive weight');
assert.equal(context.recoHorizonWeight(72).id, 'evergreen',
  'videos older than five years enter the evergreen history bucket');
assert.equal(context.recoHorizonWeight(null), null,
  'a missing publication age never enters performance learning');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 1}) > context.recoSourceRecencyBoost({_sourceAgeM: 4}),
  'the 0-3 month source window receives the strongest ranking prior');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 4}) > context.recoSourceRecencyBoost({_sourceAgeM: 8}),
  'the 3-6 month source window outranks the 6-12 month window');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 8}) > context.recoSourceRecencyBoost({_sourceAgeM: 18}),
  'the 6-12 month source window outranks the 12-24 month window');
assert.ok(context.recoSourceRecencyBoost({_sourceAgeM: 18}) > context.recoSourceRecencyBoost({_sourceAgeM: 36}),
  'the 12-24 month source window retains a small advantage over older history');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: null}), 0,
  'missing performance data is neutral instead of being treated as a failure');
assert.ok(context.recoPerformanceSignal({pctNow: 90, pctCh: 10, st: null}) > 0,
  'recent measured velocity takes priority over lifetime velocity when available');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: {imp: 500, ctr: 20, awp: 95}}), 0,
  'extreme Studio metrics from fewer than 1,000 impressions remain neutral');
assert.equal(context.recoPerformanceSignal({pctNow: null, pctCh: null, st: {imp: 100000, ctr: null, awp: 220}}), 0,
  'an impossible long-form percentage watched cannot influence recommendation scoring');

const migrationRows = [
  {n: 8001, title: 'Old neutral location template', valid: '', score: 99, genre: 'Lofi'},
  {n: 8002, title: 'Old accepted example', valid: 'X', score: 99, genre: 'Lofi'},
  {
    n: -4000000000001, title: 'summer lofi ☀️ chill beats to relax to', valid: '', score: 90,
    genre: 'Lofi', _generated: true, _generatorVersion: 4, _conceptFamily: 'lofi|season|summer',
    _titleFamily: 'lofi|direct', _sourceVideoId: 'market-v4', _scoringVersion: 5,
  },
];
const migrationContext = makeContext(migrationRows, new Map(), [], {
  schema: 3, version: 4, buildId: 'v4-build', ledgerRevision: 'v4-ledger', modelRevision: 'v4-model',
});
assert.deepEqual(Array.from(migrationContext.dailyRecommendationSet(), row => row.n), [-4000000000001],
  'once V4 is present, old neutral proposals stay as audit history but never re-enter the active review batch');
assert.equal(migrationContext.recoProfile().feedbackGenre.lofi, 6,
  'accepted legacy titles remain positive learning evidence during the V4 migration');

const absentPoolStorage = new Map();
const absentPoolContext = makeContext(migrationRows.slice(0, 2), absentPoolStorage, [], null);
assert.deepEqual(Array.from(absentPoolContext.dailyRecommendationSet()), [],
  'a missing or failed pool fetch fails closed instead of reviving an old neutral proposal');
assert.equal(absentPoolStorage.has('lofi_radar_reco_rotation_v4'), false,
  'a failed pool fetch does not persist a fake empty editorial queue');
assert.equal(absentPoolContext.recoProfile().feedbackGenre.lofi, 6,
  'accepted history remains learning evidence when the active pool is unavailable');

const staleV3Rows = [
  {n: -3000000000001, title: 'Stale V3 neutral', valid: '', score: 99, genre: 'Ambient', _generated: true, _generatorVersion: 3},
  {n: -3000000000002, title: 'Stale V3 accepted', valid: 'X', score: 99, genre: 'Jazz', _generated: true, _generatorVersion: 3},
  {n: -3000000000003, title: 'Stale V3 refused', valid: '-', score: 99, genre: 'Piano', _generated: true, _generatorVersion: 3},
];
const staleV3Storage = new Map();
const staleV3Context = makeContext(staleV3Rows, staleV3Storage, [], {
  schema: 3, version: 3, buildId: 'v3-build', ledgerRevision: 'v3-ledger', modelRevision: '',
});
assert.deepEqual(Array.from(staleV3Context.dailyRecommendationSet()), [],
  'a stale V3 pool fails closed instead of exposing its neutral candidates');
assert.equal(staleV3Storage.has('lofi_radar_reco_rotation_v4'), false,
  'a stale V3 pool cannot persist an empty V4 review lot');
assert.equal(staleV3Context.recoProfile().feedbackGenre.jazz, 6,
  'V3 accepted decisions remain positive learning history');
assert.equal(staleV3Context.recoProfile().feedbackGenre.piano, -8,
  'V3 refused decisions remain negative learning history');

const recoveryRows = [{
  n: -3050, title: 'Recovered V4 idea', genre: 'Lofi', score: 90, valid: '',
  _generated: true, _generatorVersion: 4, _sourceVideoId: 'recovery-source',
}];
const recoveryStorage = new Map();
const recoveryContext = makeContext(recoveryRows, recoveryStorage, [], {
  schema: 3, version: 3, buildId: 'failed-v3', ledgerRevision: 'failed-ledger', modelRevision: '',
});
assert.deepEqual(Array.from(recoveryContext.dailyRecommendationSet()), [],
  'the initial stale-pool paint fails closed');
assert.equal(recoveryStorage.has('lofi_radar_reco_rotation_v4'), false,
  'the initial stale-pool paint leaves no empty queue behind');
recoveryContext.window.LOFI_RECOMMENDATION_POOL = {
  schema: 3, version: 4, buildId: 'recovered-v4', ledgerRevision: 'recovered-ledger', modelRevision: 'recovered-model',
};
assert.deepEqual(Array.from(recoveryContext.dailyRecommendationSet(), row => row.n), [-3050],
  'a later V4 identity invalidates the fail-closed cache and becomes reviewable immediately');

const recoveryDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const staleEmptyDecisionSentinel = JSON.stringify({'-3051': {value: 'X'}});
const staleEmptyEditSentinel = JSON.stringify({'-3052': {title: 'Edited title'}});
const staleEmptyRoadmapSentinel = JSON.stringify([{key: 'roadmap-sentinel'}]);
const staleEmptyStorage = new Map([
  ['lofi_radar_reco_rotation_v4', JSON.stringify({
    [recoveryDayKey]: [],
    _pool: {schema: 3, version: 4, buildId: 'old-v4', ledgerRevision: 'old-ledger', modelRevision: 'old-model', sourceT: 1, feedbackT: 1},
    _consumed: [987654],
  })],
  ['lofi_radar_generated_reco_decisions_v1', staleEmptyDecisionSentinel],
  ['lofi_radar_recommendation_edits_v1', staleEmptyEditSentinel],
  ['lofi_radar_roadmap_archive_v3', staleEmptyRoadmapSentinel],
]);
const staleEmptyContext = makeContext(recoveryRows.map(row => Object.assign({}, row)), staleEmptyStorage, [], {
  schema: 3, version: 4, buildId: 'new-v4', ledgerRevision: 'new-ledger', modelRevision: 'new-model', sourceT: 2, feedbackT: 2,
});
assert.deepEqual(Array.from(staleEmptyContext.dailyRecommendationSet(), row => row.n), [-3050],
  'a changed V4 identity repairs an empty queue persisted by an older client');
assert.deepEqual(JSON.parse(staleEmptyStorage.get('lofi_radar_reco_rotation_v4'))._consumed, [987654],
  'repairing a stale empty queue preserves the durable consumed ledger');
assert.equal(staleEmptyStorage.get('lofi_radar_generated_reco_decisions_v1'), staleEmptyDecisionSentinel,
  'repairing rotation never touches explicit recommendation decisions');
assert.equal(staleEmptyStorage.get('lofi_radar_recommendation_edits_v1'), staleEmptyEditSentinel,
  'repairing rotation never touches edited recommendation copy');
assert.equal(staleEmptyStorage.get('lofi_radar_roadmap_archive_v3'), staleEmptyRoadmapSentinel,
  'repairing rotation never touches Roadmap state');

const comboFeedbackRows = [
  ...Array.from({length: 5}, (_, index) => ({
    n: 20000 + index, title: `Refused ambient sleep ${index}`, genre: 'Ambient', _genreKey: 'ambient', _purposeKey: 'sleep', valid: '-',
  })),
  ...Array.from({length: 10}, (_, index) => ({
    n: 20100 + index, title: `Accepted sleep elsewhere ${index}`, genre: index % 2 ? 'Jazz' : 'Piano',
    _genreKey: index % 2 ? 'jazz' : 'piano', _purposeKey: 'sleep', valid: 'X',
  })),
];
const rejectedAmbientSleep = {n: -4201, title: 'Ambient Sleep', genre: 'Ambient', _genreKey: 'ambient', _purposeKey: 'sleep', score: 90, valid: ''};
const safeClassicalSleep = {n: -4202, title: 'Classical Sleep', genre: 'Classical', _genreKey: 'classical', _purposeKey: 'sleep', score: 90, valid: ''};
const comboContext = makeContext([...comboFeedbackRows, rejectedAmbientSleep, safeClassicalSleep], new Map(), []);
const comboProfile = comboContext.recoProfile();
assert.equal(comboProfile.feedbackCombo['ambient|sleep'], -40,
  'five unanimous ambient-sleep refusals are learned as an exact combo');
assert.equal(comboProfile.feedbackPurpose.sleep, 20,
  'sleep remains globally positive after acceptances in other genres');
const comboDay = '2026-08-20';
const rejectedComboScore = comboContext.recoDailyScore(rejectedAmbientSleep, comboProfile, comboDay);
const safeSleepScore = comboContext.recoDailyScore(safeClassicalSleep, comboProfile, comboDay);
assert.ok(rejectedComboScore < 90 && safeSleepScore > 90 && safeSleepScore > rejectedComboScore,
  'the rejected genre×purpose combo dominates locally without condemning sleep in other genres');

const editedFeedbackRow = {
  n: 20500, title: 'Soft Jazz for deep sleep', genre: 'Ambient', valid: 'X',
  niche: 'Study / focus / work', kw: 'productivity coding',
  _genreKey: 'nature', _purposeKey: 'sleep', _titleEdited: true,
};
const editedContext = makeContext([editedFeedbackRow], new Map(), []);
assert.equal(editedContext.recoGenreKey(editedFeedbackRow.genre, editedFeedbackRow), 'jazz',
  'an edited title derives its genre from final copy instead of stale row.genre or generated keys');
assert.equal(editedContext.recoPurposeKey(editedFeedbackRow), 'sleep',
  'an edited title derives its purpose from the final reviewed copy');
const editedProfile = editedContext.recoProfile();
assert.equal(editedProfile.feedbackCombo['jazz|sleep'], 6,
  'feedback from edited copy teaches the final genre×purpose combination');
assert.equal(editedProfile.feedbackCombo['nature|sleep'], undefined,
  'feedback from edited copy never teaches the superseded generated keys');
for(const staleToken of ['study','focus','work','productivity','coding']){
  assert.equal(editedProfile.feedbackToken[staleToken], undefined,
    `edited feedback never learns stale ${staleToken} metadata`);
}
for(const finalToken of ['soft','jazz','deep','sleep']){
  assert.ok(Number(editedProfile.feedbackToken[finalToken])>0,
    `edited feedback learns ${finalToken} from final copy`);
}
const editedSeasonalPiano = {
  title: 'Christmas Piano | soft piano for deep sleep', genre: 'Christmas Lofi',
  _genreKey: 'christmas', _purposeKey: 'season', _titleEdited: true,
};
assert.equal(editedContext.recoGenreKey(editedSeasonalPiano.genre, editedSeasonalPiano), 'piano',
  'an edited seasonal title keeps its explicit musical lane instead of a seasonal wrapper');
const editedGenreFixtures = [
  [{title:'Jazz Noir 🎷 [jazz lofi]',genre:'Jazz',_titleEdited:true},'jazz'],
  [{title:'Cello & Rain | calm strings for deep sleep',genre:'Classical',_titleEdited:true},'classical'],
  [{title:'Fan Sounds | cozy nature ambience',genre:'Nature',_titleEdited:true},'nature'],
  [{title:'Rainstorm Sounds | cozy nature ambience',genre:'Nature',_titleEdited:true},'nature'],
];
for(const [row,expected] of editedGenreFixtures){
  assert.equal(editedContext.recoGenreKey(row.genre,row),expected,
    `edited genre classifier agrees with backend for ${row.title}`);
}
const editedPurposeFixtures = [
  [{title:'Focus Jazz | jazz for reading',_titleEdited:true},'reading'],
  [{title:'synthwave music to program to',_titleEdited:true},'study'],
  [{title:'synthwave to chill/game to',_titleEdited:true},'relax'],
];
for(const [row,expected] of editedPurposeFixtures){
  assert.equal(editedContext.recoPurposeKey(row),expected,
    `edited purpose classifier agrees with backend for ${row.title}`);
}
const editedWithoutGenre = {
  title: 'Quiet Evening', genre: 'Lofi', cluster: 'Study',
  _genreKey: 'jazz', _purposeKey: 'sleep', _titleEdited: true,
};
assert.equal(editedContext.recoGenreKey(editedWithoutGenre.genre, editedWithoutGenre), '',
  'a title-only edit without an explicit genre does not invent a genre change');
assert.equal(editedContext.recoPurposeKey(editedWithoutGenre), 'relax',
  'an edited neutral title uses the backend relax fallback instead of stale Study metadata');

const recencyRankingRows = [
  {n: -4101, title: 'Evergreen exceptional', valid: '', score: 99, genre: 'Ambient', _generatorVersion: 4, _sourceAgeM: 84, _titleFamily: 'evergreen'},
  {n: -4102, title: 'Older slightly stronger', valid: '', score: 92, genre: 'Piano', _generatorVersion: 4, _sourceAgeM: 30, _titleFamily: 'older'},
  {n: -4103, title: 'Recent measured average', valid: '', score: 88, genre: 'Jazz', _generatorVersion: 4, _sourceAgeM: 1, _titleFamily: 'recent'},
];
const recencyRankingBatch = Array.from(makeContext(recencyRankingRows, new Map(), []).dailyRecommendationSet());
assert.deepEqual(recencyRankingBatch.map(row => row.n), [-4101, -4103, -4102],
  'a recent measured source wins a close ranking call, while an exceptional evergreen source can still lead');
assert.deepEqual(recencyRankingBatch.map(row => row.scoreAdj), [99, 88, 92],
  'the separate recency prior never changes objective visible scores or tiers');

const diversityRows = [
  {n: -4301, title: 'Deep Focus Session | rainy lofi', genre: 'Lofi', score: 99, valid: '', _topicKey: 'deep work', _titleFamily: 'lofi|direct', _sourceVideoId: 'd1'},
  {n: -4302, title: 'Deep Focus Session | night lofi', genre: 'Lofi', score: 98, valid: '', _topicKey: 'Deep Work', _titleFamily: 'lofi|direct', _sourceVideoId: 'd2'},
  {n: -4303, title: 'Deep Focus Session | soft lofi', genre: 'Lofi', score: 97, valid: '', _topicKey: 'deep-work music', _titleFamily: 'lofi|direct', _sourceVideoId: 'd3'},
  {n: -4304, title: 'Rainy Coding Beats', genre: 'Lofi', score: 96, valid: '', _topicKey: 'rainy coding', _titleFamily: 'lofi|direct', _sourceVideoId: 'd4'},
  {n: -4305, title: 'Late Night Study', genre: 'Lofi', score: 95, valid: '', _topicKey: 'late night study', _titleFamily: 'lofi|direct', _sourceVideoId: 'd5'},
  {n: -4306, title: 'Quiet Reading Flow', genre: 'Lofi', score: 94, valid: '', _topicKey: 'quiet reading', _titleFamily: 'lofi|direct', _sourceVideoId: 'd6'},
  {n: -4307, title: 'Morning Focus Beats', genre: 'Lofi', score: 93, valid: '', _topicKey: 'morning focus', _titleFamily: 'lofi|direct', _sourceVideoId: 'd7'},
  {n: -4308, title: 'Soft Piano Rest', genre: 'Piano', score: 91, valid: '', _topicKey: 'soft piano rest', _titleFamily: 'piano|direct', _sourceVideoId: 'd8'},
  {n: -4309, title: 'Jazz Evening', genre: 'Jazz', score: 90, valid: '', _topicKey: 'jazz evening', _titleFamily: 'jazz|direct', _sourceVideoId: 'd9'},
];
const diversityBatch = Array.from(makeContext(diversityRows, new Map(), []).dailyRecommendationSet());
const diversityTopFive = diversityBatch.slice(0, 5);
assert.ok(diversityTopFive.filter(row => row.genre === 'Lofi').length >= 4,
  'a strongly ranked genre keeps several distinct concepts instead of being forced into equal style quotas');
assert.equal(diversityTopFive.filter(row => row.title.startsWith('Deep Focus Session')).length, 1,
  'a normalized duplicate topic is strictly limited to one card across the entire batch');
assert.equal(diversityBatch.length, 7,
  'strict topic deduplication removes both duplicate Deep Work variants without imposing genre quotas');
assert.equal(new Set(diversityBatch.map(row => row._topicKey && editedContext.recoNormalizedTopicKey(row))).size, diversityBatch.length,
  'every retained fixture card has a unique normalized global topic');
const storedDuplicateQueue = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [recoveryDayKey]: diversityRows.map(row => row.n), _pool: DEFAULT_V4_POOL,
})]]);
const storedDiversityBatch = Array.from(makeContext(diversityRows.map(row => Object.assign({}, row)), storedDuplicateQueue, []).dailyRecommendationSet());
assert.equal(storedDiversityBatch.length, 7,
  'strict topic uniqueness also repairs a previously stored daily queue, not only a newly ranked batch');
assert.equal(JSON.parse(storedDuplicateQueue.get('lofi_radar_reco_rotation_v4'))[recoveryDayKey].length, 7,
  'the repaired stored queue persists only its unique topic identities');

const publishedVideo = {
  ageM: 2, pctCh: 90, title: 'Published Quasar focus mix', genre: 'Lofi', niche: '',
  reco: {
    title: 'Rejected Nebula sleep proposal', genre: 'Ambient', purpose: 'Sleep', niche: 'Deep sleep', kw: 'instrumental',
    _genreKey: 'ambient', _purposeKey: 'sleep',
  },
};
const publishedContext = makeContext([], new Map(), [publishedVideo]);
const publishedFields = publishedContext.recoVideoFields(publishedVideo);
assert.equal(publishedFields.title, 'Published Quasar focus mix',
  'Analyse always supplies the title that was actually published');
assert.equal(publishedFields.genre, 'Lofi',
  'published Analyse metadata wins over linked recommendation metadata');
assert.equal(publishedFields.niche, '',
  'missing Analyse metadata stays missing instead of being copied from the linked recommendation');
assert.equal(publishedFields._genreKey, undefined,
  'a contradictory linked genre key never enters published-video learning');
assert.equal(publishedFields._purposeKey, undefined,
  'a contradictory linked purpose key never enters published-video learning');
const publishedProfile = publishedContext.recoProfile();
assert.ok(publishedProfile.performanceToken.quasar > 0,
  'performance learning tokenises the actually published title');
assert.equal(publishedProfile.performanceToken.nebula, undefined,
  'performance learning never tokenises the superseded recommendation title');
assert.ok(publishedProfile.performanceGenre.lofi > 0,
  'performance learning classifies the real published genre');
assert.equal(publishedProfile.performanceGenre.ambient, undefined,
  'linked recommendation genre metadata cannot corrupt published-video learning');
assert.ok(publishedProfile.performancePurpose.study > 0,
  'performance learning derives purpose from the real published title');
assert.equal(publishedProfile.performancePurpose.sleep, undefined,
  'linked recommendation purpose metadata cannot corrupt published-video learning');

const fullHistoryProfile = makeContext([], new Map(), [
  {ageM: 2, pctCh: 60, title: 'Recent signal', genre: 'Lofi'},
  {ageM: 5, pctCh: 60, title: 'Half year signal', genre: 'Jazz'},
  {ageM: 10, pctCh: 60, title: 'Annual signal', genre: 'Piano'},
  {ageM: 18, pctCh: 60, title: 'Two year signal', genre: 'Classical'},
  {ageM: 40, pctCh: 60, title: 'Five year signal', genre: 'Guitar'},
  {ageM: 84, pctCh: 60, title: 'Evergreen signal', genre: 'Ambient'},
]).recoProfile();
assert.equal(fullHistoryProfile.recentVideos, 6,
  'all dated owned videos contribute to performance learning');
['3m', '6m', '12m', '24m', '60m', 'evergreen'].forEach(windowId => {
  assert.equal(fullHistoryProfile.windows[windowId], 1, `${windowId} history bucket is represented`);
});

// A refusal removes exactly the reviewed card from the finite daily queue.
// Reserve candidates remain untouched until the explicit New ideas action.
const decidedId = daily[0].n;
const retainedIds = new Set(daily.slice(1).map(row => row.n));
recos.find(r => r.n === decidedId).valid = '-';
const afterRefusal = context.dailyRecommendationSet();
assert.equal(afterRefusal.length, 49,
  'a refusal immediately reduces a full daily queue from 50 to 49');
assert.ok(!afterRefusal.some(row => row.n === decidedId), 'a refused idea leaves the active queue');
assert.deepEqual(new Set(afterRefusal.map(row => row.n)), retainedIds,
  'no unseen reserve candidate replaces a refused card implicitly');
assert.equal(context.activeDailyRecommendationCount(), 49,
  'the navigation badge and the visible queue share the reduced count');
assert.equal(context.recoPotentialForScore(94)[0], 'A', '94 remains an A');
assert.equal(context.recoPotentialForScore(95)[0], 'S', '95 is the evidence-backed S threshold');

// Personalisation orders the queue but cannot erase an objective S label.
// Ten refusals sharing the same source/topic deliberately pull this S below
// the adaptive S threshold, while its measured market tier remains visible.
const objectiveS = {
  n: 9000, title: 'Objective S concept', genre: 'Jazz', niche: 'Relaxation',
  perso: 'Girl', concept: 'late night jazz relaxation', score: 95,
  pot: 'S - Rente potentielle', _scoringVersion: 4,
  _sourceVideoId: 'objective-source', valid: '',
};
const negativePeers = Array.from({length: 10}, (_, index) => ({
  n: 9100 + index, title: `Refused peer ${index}`, genre: 'Jazz', niche: 'Relaxation',
  perso: 'Girl', concept: 'late night jazz relaxation', score: 90,
  _sourceVideoId: 'objective-source', valid: '-',
}));
const tierDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const tierStored = new Map([
  ['lofi_radar_reco_rotation_v4', JSON.stringify({[tierDayKey]: [objectiveS.n]})],
]);
const tierContext = makeContext([objectiveS, ...negativePeers], tierStored, []);
const tierBatch = tierContext.dailyRecommendationSet();
assert.equal(tierBatch.length, 1, 'the retained objective S stays in its active queue');
assert.ok(tierBatch[0]._dailyScore < 95, 'negative learned feedback still demotes its adaptive rank');
assert.ok(!String(tierBatch[0]._dailyPotential).startsWith('S'),
  'the internal adaptive tier records that demotion separately');
assert.ok(String(tierBatch[0].pot).startsWith('S'),
  'the visible market-potential tier remains the objective evidence-backed S');
assert.equal(tierBatch[0].scoreAdj, 95,
  'the visible score remains consistent with the objective S tier');

const legacyS = Object.assign({}, objectiveS, {n: 9001, _scoringVersion: undefined});
const legacyTierStored = new Map([
  ['lofi_radar_reco_rotation_v4', JSON.stringify({[tierDayKey]: [legacyS.n]})],
]);
const legacyTierContext = makeContext([legacyS, ...negativePeers], legacyTierStored, []);
const legacyTierBatch = legacyTierContext.dailyRecommendationSet();
assert.ok(legacyTierBatch[0]._dailyScore < 95, 'the same negative feedback demotes the legacy idea');
assert.ok(!String(legacyTierBatch[0].pot).startsWith('S'),
  'an uncalibrated legacy S label cannot return after V4 launches');
assert.equal(legacyTierBatch[0].scoreAdj, Math.round(legacyTierBatch[0]._dailyScore),
  'legacy visible score and tier stay aligned with adaptive evidence');

const previousIds = new Set(daily.map(row => row.n));
context.refreshDailyRecommendations({stopPropagation() {}});
const refreshed = context.dailyRecommendationSet();
assert.equal(refreshed.length, 50, 'refresh can still load a full batch when 50 qualified unseen ideas exist');
assert.ok(refreshed.every(row => !previousIds.has(row.n)),
  'refresh avoids the current batch while enough qualified unseen concepts remain');
assert.equal(context.rerenderCount(), 1, 'refresh rerenders the recommendation workspace immediately');

// A stored 50-card queue with 29 decisions remains a finite 21-card queue.
// It must not silently draw 29 new candidates from the reserve.
const todayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const regressionRecos = Array.from({length: 100}, (_, index) => ({
  n: 2000 + index,
  title: `Regression concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: 90,
  valid: index < 29 ? 'X' : '',
}));
const originalQueue = regressionRecos.slice(0, 50).map(row => row.n);
const decisionSentinel = JSON.stringify({'2029': {value: '-'}});
const regressionStored = new Map([[
  'lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: originalQueue}),
], ['lofi_radar_generated_reco_decisions_v1', decisionSentinel]]);
const regressionContext = makeContext(regressionRecos, regressionStored, []);
const remainingQueue = regressionContext.dailyRecommendationSet();
assert.equal(remainingQueue.length, 21, '29 decisions reduce the stored 50-card queue to 21');
assert.deepEqual(Array.from(remainingQueue, row => row.n), originalQueue.slice(29),
  'the 21 still-pending cards retain their exact order without replacements');
const persistedRegression = JSON.parse(regressionStored.get('lofi_radar_reco_rotation_v4'));
assert.deepEqual(persistedRegression[todayKey], originalQueue,
  'the original finite lot remains stored until an explicit refresh');
assert.equal(regressionStored.get('lofi_radar_generated_reco_decisions_v1'), decisionSentinel,
  'rendering the reduced queue never rewrites the generated-decision store');
const lazyHistory = {[todayKey]: originalQueue.slice()};
assert.equal(regressionContext.finalizeDailyRecommendationHistoryProfile(lazyHistory, todayKey), false,
  'late performance history does not rebuild a queue after review has started');
assert.deepEqual(lazyHistory[todayKey], originalQueue,
  'late performance history preserves every identity in the reviewed daily lot');

const untouchedRecos = Array.from({length: 50}, (_, index) => ({
  n: 6000 + index,
  title: `Untouched lazy concept ${index + 1}`,
  genre: 'Lofi',
  perso: 'Lofi Girl',
  score: 90,
  valid: '',
  _titleFamily: `untouched-title-${index}`,
}));
const untouchedQueue = untouchedRecos.map(row => row.n);
const untouchedStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: untouchedQueue})]]);
const untouchedContext = makeContext(untouchedRecos, untouchedStored, []);
const untouchedHistory = JSON.parse(untouchedStored.get('lofi_radar_reco_rotation_v4'));
assert.equal(untouchedContext.finalizeDailyRecommendationHistoryProfile(untouchedHistory, todayKey), false,
  'late performance history never replaces an untouched existing lot');
assert.deepEqual(untouchedHistory[todayKey], untouchedQueue,
  'all untouched queue IDs remain stable after lazy performance history');
assert.equal(untouchedContext.dailyRecommendationSet().length, 50,
  'the untouched lot remains fully visible');

const missingIdQueue = [6999, ...untouchedQueue.slice(1)];
const missingStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: missingIdQueue})]]);
const missingContext = makeContext(untouchedRecos.slice(1), missingStored, []);
const missingHistory = JSON.parse(missingStored.get('lofi_radar_reco_rotation_v4'));
assert.equal(missingContext.finalizeDailyRecommendationHistoryProfile(missingHistory, todayKey), false,
  'a stored ID absent from DATA prevents lazy history from recreating the lot');
assert.deepEqual(missingHistory[todayKey], missingIdQueue,
  'the missing resolved identity remains recorded in the finite lot');
assert.equal(missingContext.dailyRecommendationSet().length, 49,
  'one absent stored ID reduces the visible queue instead of triggering a replacement');

const refreshedQueue = untouchedQueue.slice().reverse();
const refreshRaceStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({
  [todayKey]: refreshedQueue,
  _consumed: Array.from({length: 50}, (_, index) => 5900 + index),
})]]);
const refreshRaceContext = makeContext(untouchedRecos, refreshRaceStored, []);
const refreshRaceHistory = JSON.parse(refreshRaceStored.get('lofi_radar_reco_rotation_v4'));
assert.equal(refreshRaceContext.finalizeDailyRecommendationHistoryProfile(refreshRaceHistory, todayKey), false,
  'lazy history cannot overwrite a lot just created by New ideas');
assert.deepEqual(refreshRaceHistory[todayKey], refreshedQueue,
  'the refreshed queue order survives the lazy-history race');
assert.deepEqual(Array.from(refreshRaceContext.dailyRecommendationSet(), row => row.n), refreshedQueue,
  'the refreshed queue remains the visible lot after lazy history completes');

// The quality floor is authoritative. When only a few ideas clear it, the
// engine deliberately returns fewer than 50 instead of adding weak filler.
const sparseRecos = Array.from({length: 68}, (_, index) => ({
  n: 1000 + index,
  title: `Sparse concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: index < 8 ? 90 : 10,
  valid: '',
  _titleFamily: 'single-small-pool-family',
}));
const sparseContext = makeContext(sparseRecos, new Map(), []);
const sparseDaily = sparseContext.dailyRecommendationSet();
assert.equal(sparseDaily.length, 8,
  'the score threshold is allowed to produce a batch smaller than 50');
assert.ok(sparseDaily.every(row => row.score === 90),
  'no below-threshold recommendation is used as filler');
assert.ok(sparseDaily.every(row => row._titleFamily === 'single-small-pool-family'),
  'a broad shared title family never shrinks a small qualified pool');

const emptyStored = new Map([['lofi_radar_reco_rotation_v4', JSON.stringify({[todayKey]: [], _pool: DEFAULT_V4_POOL})]]);
const emptyContext = makeContext(regressionRecos, emptyStored, []);
assert.equal(emptyContext.dailyRecommendationSet().length, 0,
  'an explicitly stored empty daily queue stays empty until New ideas is clicked');

const familyRecos = Array.from({length: 130}, (_, index) => ({
  n: 4000 + index,
  title: `Family guard concept ${index + 1}`,
  genre: index % 2 ? 'Lofi' : 'Ambient',
  perso: 'Lofi Girl',
  score: index < 2 ? 99 - index : 90,
  valid: '',
  _conceptFamily: index < 2 ? 'shared-concept-family' : `safe-concept-family-${index}`,
  _titleFamily: `family-guard-title-${index}`,
}));
const familyContext = makeContext(familyRecos, new Map(), []);
const familyInitial = familyContext.dailyRecommendationSet();
assert.ok(familyInitial.some(row => row.n === 4000) && familyInitial.some(row => row.n === 4001),
  'the fixture begins with two pending sisters from the same concept family');
familyRecos[0].valid = '-';
const familyAfterRefusal = familyContext.dailyRecommendationSet();
assert.ok(!familyAfterRefusal.some(row => row._conceptFamily === 'shared-concept-family'),
  'a refusal immediately removes pending sisters from the same concept family');
familyContext.refreshDailyRecommendations({stopPropagation() {}});
const familyAfterRefresh = familyContext.dailyRecommendationSet();
assert.ok(!familyAfterRefresh.some(row => row._conceptFamily === 'shared-concept-family'),
  'New ideas cannot serve a sister of a refused concept before the backend refresh');

const hookRecos = Array.from({length: 130}, (_, index) => ({
  n: 5000 + index,
  title: index < 2 ? (index ? 'Night Jazz | jazz for reading' : 'Night Jazz | jazz to relax to') : `Distinct hook ${index}`,
  genre: index < 2 ? 'Jazz' : 'Lofi',
  perso: 'Lofi Girl',
  score: index < 2 ? 99 - index : 90,
  valid: '',
  _topicKey: index < 2 ? 'night jazz' : `distinct hook ${index}`,
  _purposeKey: index ? 'reading' : 'relax',
  _conceptFamily: index < 2 ? `jazz|${index ? 'reading' : 'relax'}|night jazz` : `safe-hook-family-${index}`,
  _titleFamily: `hook-guard-title-${index}`,
}));
const hookContext = makeContext(hookRecos, new Map(), []);
assert.ok(hookContext.dailyRecommendationSet().some(row => row.n === 5000),
  'the fixture initially exposes the strongest variant of a repeated hook');
assert.ok(!hookContext.dailyRecommendationSet().some(row => row.n === 5001),
  'the alternate purpose variant remains available in reserve');
hookRecos[0].valid = '-';
assert.ok(!hookContext.dailyRecommendationSet().some(row => row._topicKey === 'night jazz'),
  'a refusal immediately blocks the same hook across concept families and purposes');
hookContext.refreshDailyRecommendations({stopPropagation() {}});
assert.ok(!hookContext.dailyRecommendationSet().some(row => row._topicKey === 'night jazz'),
  'New ideas cannot revive a globally refused hook before the backend refresh');

console.log('YouTube daily recommendations: OK');
