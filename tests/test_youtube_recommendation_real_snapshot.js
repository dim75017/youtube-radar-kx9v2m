'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const RECOMMENDATION_SOURCE = path.join(ROOT, 'assets/js/dashboard-04-recommendations.js');
const DATA_FILE = path.join(ROOT, 'Lofi_Radar_data.js');
const POOL_FILE = process.env.RECOMMENDATION_POOL_FILE
  ? path.resolve(process.env.RECOMMENDATION_POOL_FILE)
  : path.join(ROOT, 'Lofi_Radar_recommendation_pool.js');
const STUDIO_FILE = path.join(ROOT, 'Lofi_Radar_studio.js');
const HISTORY_DIR = path.join(ROOT, 'video_history');

function readAssignedJson(file) {
  const source = fs.readFileSync(file, 'utf8').trim();
  const equals = source.indexOf('=');
  assert.ok(equals > 0, `${path.basename(file)} must remain a JavaScript JSON assignment`);
  return JSON.parse(source.slice(equals + 1).replace(/;\s*$/, ''));
}

function readHistoryShards() {
  const files = fs.readdirSync(HISTORY_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();
  assert.ok(files.length > 0, 'the real video-history shards must be present');

  const history = {};
  for (const file of files) {
    const shard = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
    assert.ok(shard && shard.d && typeof shard.d === 'object', `${file} must expose a history map`);
    for (const [videoId, points] of Object.entries(shard.d)) {
      assert.equal(history[videoId], undefined, `history for ${videoId} must live in one shard only`);
      history[videoId] = points;
    }
  }
  return {history, files};
}

const AGE_COHORT_MAX_DAYS = [7, 30, 90, 180, 365, Infinity];

function cohortIndex(ageDays) {
  return AGE_COHORT_MAX_DAYS.findIndex(max => ageDays <= max);
}

function comparableRows(rows, ageDays, minimum) {
  const target = cohortIndex(ageDays);
  const exact = rows.filter(row => cohortIndex(row.ageDays) === target);
  if (exact.length >= minimum) return exact;
  const nearby = rows.filter(row => Math.abs(cohortIndex(row.ageDays) - target) <= 1);
  return nearby.length >= minimum ? nearby : [];
}

function buildOwnedAnalyticsRows(owned, history, studio, snapshotTime) {
  const dayMs = 86400000;
  const rows = owned
    .filter(row => row.pub && (row.durH == null || row.durH >= 0.15))
    .map(row => {
      const points = (history[row.vid] || []).slice().sort((a, b) => a[0] - b[0]);
      const ageDays = Math.max((snapshotTime - Number(row.pub)) / dayMs, 0);
      const views = points.length
        ? Number(points[points.length - 1][1])
        : (Number.isFinite(Number(row.views)) ? Number(row.views) : null);
      const vpm = Number.isFinite(views) && ageDays > 0 ? views / ageDays * 30.44 : null;
      let vNow = null;
      if (points.length >= 2) {
        const end = points[points.length - 1];
        const cutoff = end[0] - 30.44 * dayMs;
        const recent = points.filter(point => point[0] >= cutoff);
        const start = recent.length >= 2 ? recent[0] : points[points.length - 2];
        const elapsedDays = Math.max((end[0] - start[0]) / dayMs, 0.5);
        vNow = (Number(end[1]) - Number(start[1])) / elapsedDays * 30.44;
      }
      return Object.assign({}, row, {
        ageDays,
        ageM: ageDays / 30.44,
        views,
        vpm,
        vNow,
        st: studio.d[row.vid] || null,
      });
    });

  for (const row of rows) {
    const peers = comparableRows(rows.filter(peer => peer.vid !== row.vid), row.ageDays, 2);
    const lifetimePeers = peers.filter(peer => peer.vpm != null);
    const recentPeers = peers.filter(peer => peer.vNow != null);
    row.pctCh = row.vpm != null && lifetimePeers.length >= 2
      ? Math.round(lifetimePeers.filter(peer => peer.vpm < row.vpm).length / lifetimePeers.length * 100)
      : null;
    row.pctNow = row.vNow != null && recentPeers.length >= 2
      ? Math.round(recentPeers.filter(peer => peer.vNow < row.vNow).length / recentPeers.length * 100)
      : null;
  }
  return rows;
}

function personaCategory(value) {
  if (/synthwave boy/i.test(String(value || ''))) return 'Synthwave Boy';
  if (/lofi girl/i.test(String(value || ''))) return 'Lofi Girl';
  return 'Sans personnage';
}

function fixedDateClass(timestamp) {
  return class SnapshotDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [timestamp]));
    }

    static now() {
      return timestamp;
    }
  };
}

function recommendationContext({recos, ownedRows, measuredSeeds, snapshotTime, stored = new Map()}) {
  const source = fs.readFileSync(RECOMMENDATION_SOURCE, 'utf8');
  const start = source.indexOf('const GENERATED_RECO_DECISIONS_KEY=');
  const end = source.indexOf('function ensureRecommendationPerformanceHistory()', start);
  assert.ok(start >= 0 && end > start, 'recommendation learning helpers must remain available');

  const context = {
    DATA: {recos: recos.map(row => Object.assign({}, row))},
    LANG: 'fr',
    Date: fixedDateClass(snapshotTime),
    Intl,
    Set,
    Map,
    Object,
    Number,
    String,
    Math,
    JSON,
    Array,
    console,
    localStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, value); },
    },
    window: {
      LOFI_RECOMMENDATION_POOL: {
        schema: 3,
        version: measuredSeeds.some(row => Number(row._generatorVersion) === 4) ? 4 : 3,
        modelRevision: measuredSeeds.some(row => Number(row._generatorVersion) === 4) ? 'real-v4-model' : '',
        items: measuredSeeds.map(row => Object.assign({}, row)),
      },
    },
    normalizedRecommendationTitle(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    },
    persoCategory: personaCategory,
    isValidated(value) { return /^x(?=$|\s|[,;:\-])/i.test(String(value || '').trim()); },
    isRefused(value) { return /^-/.test(String(value || '').trim()); },
    recommendationRoadmapEntry() { return null; },
    scheduledRows() { return []; },
    anaRows() { return ownedRows.map(row => Object.assign({}, row)); },
    rerenderRecos() {},
  };

  vm.runInNewContext(`${source.slice(start, end)}
    this.profileForTest = recoProfile;
    this.scoreForTest = recoDailyScore;
    this.dailySetForTest = dailyRecommendationSet;
    this.topicForTest = recoNormalizedTopicKey;
    this.genreForTest = recoGenreKey;
    this.minimumScoreForTest = RECO_MIN_DAILY_SCORE;`, context);
  return context;
}

const dataPayload = readAssignedJson(DATA_FILE);
const poolPayload = readAssignedJson(POOL_FILE);
const studioPayload = readAssignedJson(STUDIO_FILE);
const {history, files: historyFiles} = readHistoryShards();
const snapshotTime = Number(dataPayload.videoMetricsT || dataPayload.t || poolPayload.sourceT);
const owned = dataPayload.d.ours || [];
const generated = poolPayload.items || [];

assert.equal(poolPayload.schema, 3, 'the recommendation browser projection must keep schema V3');
const isLearnedV4 = Number(poolPayload.version) === 4;
assert.ok(isLearnedV4 || Number(poolPayload.version) === 3,
  'the checked-in reservoir must be either the migration input V3 or the learned V4 projection');
assert.ok(generated.length > 0 && generated.length <= 2500,
  'the real browser projection is non-empty, bounded and never padded with filler');
assert.ok(poolPayload.ledger && Number(poolPayload.ledger.total) >= generated.length,
  'the append-only ledger must be larger than or equal to the bounded browser projection');
assert.match(String(poolPayload.buildId || ''), /^[a-f0-9]{24}$/,
  'the projection must expose its deterministic build id');
assert.match(String(poolPayload.ledgerRevision || ''), /^[a-f0-9]{64}$/,
  'the projection must expose its exact ledger revision');
if (isLearnedV4) {
  assert.equal(poolPayload.titleRecipeVersion, 4,
    'the learned pool must use the specific-title recipe deployed with daily rotation');
  assert.match(String(poolPayload.modelRevision || ''), /^[a-f0-9]{64}$/,
    'the learned projection must expose the exact title/performance model revision');
}
const expectedSheetOwned = Number(dataPayload.videoMetrics && dataPayload.videoMetrics.sheet_ours_expected);
const expectedAnalysisOwned = Number(dataPayload.videoMetrics && dataPayload.videoMetrics.analysis_rows_expected);
assert.ok(expectedSheetOwned > 0 && expectedAnalysisOwned > 0,
  'the real snapshot must expose its canonical Sheet and visible Analysis coverage');
assert.ok(owned.length >= expectedSheetOwned && owned.length >= expectedAnalysisOwned,
  'the real owned-channel snapshot must cover every canonical Sheet and visible Analysis row');
assert.ok(Number.isFinite(snapshotTime), 'the real snapshot must expose a stable measurement timestamp');
assert.ok(historyFiles.length >= 1, 'at least one real history shard must be loaded');

const allowedWindows = new Set(['0-3m', '3-6m', '6-12m', '12m+']);
const allowedGenres = new Set([
  'lofi', 'ambient', 'nature', 'jazz', 'piano', 'classical', 'guitar', 'house', 'dnb', 'synthwave',
]);
for (const row of generated) {
  assert.equal(row._generated, true, `pool row ${row.n} must be identified as generated`);
  if (isLearnedV4) {
    assert.equal(row._generatorVersion, 4,
      `learned pool row ${row.n} must use generator V4 without leaking legacy proposals`);
    assert.match(String(row._ideaKey || ''), /^g4\|r3\|/,
      `learned pool row ${row.n} must expose its stable V4 recipe key`);
    assert.equal(row._recipeVersion, 3, `learned pool row ${row.n} must use recipe schema 3`);
    assert.equal(row._scoringVersion, 5, `learned pool row ${row.n} must use scoring V5`);
    assert.ok(row._conceptFamily && row._titleStyleKey && row._titleFamily && row._titleTemplateKey,
      `learned pool row ${row.n} must expose its evidence-bound title model`);
    assert.ok(Number(row._specificityScore) >= 2,
      `learned pool row ${row.n} must pass the specific-title gate`);
    assert.ok(['measured_detail', 'measured_theme', 'editorial_fallback'].includes(row._hookOrigin),
      `learned pool row ${row.n} must classify its title hook provenance`);
    if (row._titleReference) {
      assert.equal(row._titleReferencePurposeKey, row._purposeKey,
        `learned pool row ${row.n} must use a same-purpose title reference`);
    }
    assert.equal(Boolean(row._settingKey), false,
      `learned pool row ${row.n} must never require an invented location`);
  } else {
    assert.ok(row._generatorVersion === 2 || row._generatorVersion === 3,
      `migration row ${row.n} must be a losslessly bootstrapped V2 item or a source-backed V3 item`);
  }
  if (!isLearnedV4 && row._generatorVersion === 3) {
    assert.match(String(row._ideaKey || ''), /^g3\|r1\|/,
      `V3 pool row ${row.n} must expose its stable recipe key`);
    assert.equal(row._recipeVersion, 1, `V3 pool row ${row.n} must use recipe schema 1`);
  }
  assert.ok(Number.isSafeInteger(Number(row.n)), `pool row ${row.n} must use a JS-safe stable id`);
  if (!isLearnedV4) {
    assert.equal(row._scoringVersion, 4, `migration pool row ${row.n} must retain calibrated scoring V4`);
  }
  assert.ok(Number.isFinite(Number(row._sourceAgeM)), `pool row ${row.n} must expose a measured source age`);
  assert.ok(Number(row._sourceAgeM) >= 0,
    `pool row ${row.n} must expose a non-negative measured source age`);
  if (!isLearnedV4) {
    assert.ok(Number(row._sourceAgeM) <= 12,
      `migration pool row ${row.n} must retain its historical 12-month bound`);
  }
  assert.ok(allowedWindows.has(row._sourceWindow), `pool row ${row.n} must use a canonical history window`);
  assert.ok(allowedGenres.has(row._genreKey), `pool row ${row.n} must use a normalized canonical genre`);
  assert.equal(Object.prototype.hasOwnProperty.call(row, '_continuousVariant'), false,
    `pool row ${row.n} must not be a browser-fabricated continuous variant`);
}
if (isLearnedV4) {
  assert.ok(generated.some(row => row._sourceWindow === '12m+'),
    'the learned reservoir must keep strong evergreen market evidence instead of cutting it at 12 months');
  assert.ok(generated.some(row => !row._settingKey),
    'the learned reservoir must contain titles that do not depend on a location');
} else {
  assert.ok(generated.some(row => row._generatorVersion === 2),
    'the migration input preserves the existing V2 recommendation identities for audit');
  assert.ok(generated.some(row => row._generatorVersion === 3),
    'the migration input preserves source-backed V3 ideas for audit');
}

const historyCoverage = owned.filter(row => Array.isArray(history[row.vid]) && history[row.vid].length > 0);
const multiPointCoverage = owned.filter(row => Array.isArray(history[row.vid]) && history[row.vid].length >= 2);
const studioCoverage = owned.filter(row => studioPayload.d && studioPayload.d[row.vid]);
assert.equal(historyCoverage.length, owned.length, 'all owned videos must be connected to real history shards');
assert.ok(multiPointCoverage.length >= 20, 'enough owned videos must have multi-day history for recent velocity');
assert.ok(studioCoverage.length >= 20, 'enough owned videos must be connected to real YouTube Studio metrics');

const analyticsEligibleOwned = owned.filter(
  row => row.pub && (row.durH == null || row.durH >= 0.15),
);
const analyticsEligibleStudioCoverage = analyticsEligibleOwned.filter(
  row => studioPayload.d && studioPayload.d[row.vid],
);
const ownedRows = buildOwnedAnalyticsRows(owned, history, studioPayload, snapshotTime);
assert.equal(
  ownedRows.length,
  analyticsEligibleOwned.length,
  'the simulated anaRows input must contain every duration-eligible owned video',
);
assert.ok(ownedRows.length >= 20, 'the real snapshot must keep enough eligible owned videos for learning');
assert.equal(ownedRows.filter(row => row.st).length, analyticsEligibleStudioCoverage.length,
  'the simulated anaRows input must preserve the real Studio coverage');
assert.ok(ownedRows.filter(row => row.vNow != null).length >= 20,
  'the simulated anaRows input must expose recent velocity from history shards');

const context = recommendationContext({
  recos: (dataPayload.d.recos || []).concat(generated),
  ownedRows,
  measuredSeeds: generated,
  snapshotTime,
});
const profile = context.profileForTest();

assert.ok(profile.windows['3m'] > 0, 'the real channel profile must contain a 0-3m performance window');
assert.ok(profile.windows['6m'] > 0, 'the real channel profile must contain a 3-6m performance window');
assert.ok(profile.windows['12m'] > 0, 'the real channel profile must contain a 6-12m performance window');
assert.ok(profile.windows['24m'] > 0 && profile.windows['60m'] > 0 && profile.windows.evergreen > 0,
  'the real channel profile must learn from the complete historical catalogue with decreasing weights');
for (const genre of ['lofi', 'synthwave', 'nature']) {
  const signal = Number(profile.performanceGenre[genre]);
  assert.ok(Number.isFinite(signal) && signal !== 0,
    `the real owned-video snapshot must produce a non-empty ${genre} performance signal`);
}

const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(snapshotTime));
const qualified = generated
  .map(row => ({row, score: Number(context.scoreForTest(row, profile, day))}))
  .filter(item => item.row._hookOrigin !== 'editorial_fallback')
  .filter(item => Number.isFinite(item.score) && item.score >= context.minimumScoreForTest)
  .sort((a, b) => b.score - a.score || Number(a.row.n) - Number(b.row.n));
assert.ok(qualified.length > 0,
  'the real measured reservoir and channel analytics must yield at least one quality-qualified idea');
if (isLearnedV4) {
  const qualifiedTopics = new Set(qualified.map(item => item.row._topicKey).filter(Boolean));
  assert.ok(qualifiedTopics.size >= 100,
    'the real pool must hold enough qualified topics for two fully different 50-card days');
  assert.ok(qualified.every(item => item.row._hookOrigin !== 'editorial_fallback'),
    'genre-only editorial fallbacks must remain below the daily quality gate');
}
assert.ok(qualified.every((item, index) => index === 0 || qualified[index - 1].score >= item.score),
  'the quality-qualified real reservoir must be rankable by the daily score');
const realDailyBatch = Array.from(context.dailySetForTest());
if (isLearnedV4) {
  assert.ok(realDailyBatch.length > 0 && realDailyBatch.length <= 50,
    'the learned V4 reservoir may stop below 50 instead of filling the batch with weak ideas');
  const normalizedTopics = realDailyBatch.map(row => context.topicForTest(row));
  const normalizedGenreTopics = realDailyBatch.map((row, index) => `${context.genreForTest(row.genre, row)}|${normalizedTopics[index]}`);
  assert.ok(normalizedTopics.every(Boolean),
    'every V4 daily card must expose a normalizable measured topic');
  assert.equal(new Set(normalizedTopics).size, realDailyBatch.length,
    'the real V4 daily batch must contain each normalized global hook/topic at most once');
  assert.equal(new Set(normalizedGenreTopics).size, realDailyBatch.length,
    'the real V4 daily batch must contain each genre×topic combination at most once');
  const rotationStorage = new Map();
  const dayOneContext = recommendationContext({
    recos: (dataPayload.d.recos || []).concat(generated), ownedRows, measuredSeeds: generated,
    snapshotTime, stored: rotationStorage,
  });
  const dayTwoContext = recommendationContext({
    recos: (dataPayload.d.recos || []).concat(generated), ownedRows, measuredSeeds: generated,
    snapshotTime: snapshotTime + 86400000, stored: rotationStorage,
  });
  const dayOne = Array.from(dayOneContext.dailySetForTest());
  const dayTwo = Array.from(dayTwoContext.dailySetForTest());
  assert.equal(dayOne.length, 50, 'the real qualified pool supplies a complete first daily lot');
  assert.equal(dayTwo.length, 50, 'the real qualified pool supplies a complete next-day lot');
  const dayOneIds = new Set(dayOne.map(row => Number(row.n)));
  const dayOneTopics = new Set(dayOne.map(row => dayOneContext.topicForTest(row)));
  assert.equal(dayTwo.filter(row => dayOneIds.has(Number(row.n))).length, 0,
    'the real pool has zero recommendation-ID overlap on consecutive Paris days');
  assert.equal(dayTwo.filter(row => dayOneTopics.has(dayTwoContext.topicForTest(row))).length, 0,
    'the real pool has zero topic overlap on consecutive Paris days');
} else {
  assert.equal(realDailyBatch.length, 0,
    'the checked-in V3 migration input fails closed until a learned V4 projection is loaded');
}
if (process.env.PRINT_RECOMMENDATION_BATCH === '1') {
  for (const [index, row] of realDailyBatch.entries()) {
    console.log(`${String(index + 1).padStart(2, '0')} ${Math.round(row._dailyScore)} ${row.title}`);
  }
}
const objectiveRowsById = new Map((dataPayload.d.recos || []).concat(generated).map(row => [Number(row.n), row]));
assert.ok(realDailyBatch.every(row => {
  const objective = objectiveRowsById.get(Number(row.n)) || {};
  const score = Number(objective.score != null ? objective.score : objective.scoreAdj);
  const calibrated = Number(objective._scoringVersion) >= 4 && Number.isFinite(score);
  const visibleScore = calibrated ? Math.round(score) : Math.round(Number(row._dailyScore));
  const expected = visibleScore >= 95 ? 'S' : visibleScore >= 88 ? 'A' : visibleScore >= 78 ? 'B' : 'C';
  return String(row.pot || '')[0] === expected
    && Number(row.scoreAdj) === visibleScore
    && Number.isFinite(Number(row._dailyScore));
}), 'V4 grades preserve objective evidence while legacy grades stay aligned with adaptive daily evidence');

console.log(`YouTube recommendation real snapshot: OK (${qualified.length} qualified, ${historyFiles.length} history shards, ${analyticsEligibleStudioCoverage.length}/${analyticsEligibleOwned.length} eligible Studio)`);
