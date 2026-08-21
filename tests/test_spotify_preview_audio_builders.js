'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const builder = require(path.join(root, 'build_spotify_preview_audio.js'));
const merger = require(path.join(root, 'merge_spotify_preview_audio.js'));

function trackId(index) {
  return String(index).padStart(22, '0');
}

function previewHash(character) {
  return String(character).repeat(40);
}

function payload(overrides = {}) {
  const hashes = overrides.hashes || {};
  const missing = overrides.missing || [];
  const failed = overrides.failed || [];
  return {
    version: 1,
    generated_at: '2026-08-21T16:00:00.000Z',
    source: 'spotify_audio_preview_clip',
    source_snapshot: '2026-08-19T23:26:57Z',
    duration_seconds: 30,
    total_tracks: overrides.total_tracks === undefined ? 6 : overrides.total_tracks,
    available_tracks: Object.keys(hashes).length,
    missing_tracks: missing.length,
    failed_tracks: failed.length,
    hashes,
    missing,
    failed,
    ...(overrides.shard || {}),
  };
}

function writeWindowAssignment(filePath, value) {
  fs.writeFileSync(
    filePath,
    `window.SPOTIFY_PREVIEW_AUDIO=${JSON.stringify(value)};\n`,
    'utf8',
  );
}

(async () => {
  const ids = Array.from({ length: 8 }, (value, index) => trackId(index + 1));
  const shards = Array.from(
    { length: 3 },
    (value, index) => builder.selectPendingShard(ids, 3, index),
  );
  assert.deepEqual(shards[0], [ids[0], ids[3], ids[6]]);
  assert.deepEqual(shards[1], [ids[1], ids[4], ids[7]]);
  assert.deepEqual(shards[2], [ids[2], ids[5]]);
  assert.deepEqual(
    builder.selectPendingShard(ids, 3, 1),
    shards[1],
    'the same pending list always produces the same shard',
  );
  assert.deepEqual([...new Set(shards.flat())].sort(), [...ids].sort());
  assert.equal(shards.flat().length, ids.length, 'pending IDs belong to exactly one shard');
  assert.throws(
    () => builder.normalizeShardOptions({ shardCount: 0, shardIndex: 0 }),
    /invalid_shard_count/,
  );
  assert.throws(
    () => builder.normalizeShardOptions({ shardCount: 3, shardIndex: 3 }),
    /invalid_shard_index/,
  );

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'spotify-preview-builders-'),
  );
  try {
    const browsePath = path.join(temporaryDirectory, 'browse.js');
    const outputPath = path.join(temporaryDirectory, 'shard.js');
    const integrationIds = Array.from({ length: 7 }, (value, index) => trackId(index + 20));
    writeWindowAssignment(browsePath, {
      generated_at: '2026-08-19T23:26:57Z',
      discovery_catalogue: {
        track_schema: ['spotify_id'],
        tracks: integrationIds.map(spotifyId => [spotifyId]),
      },
      active_legacy_spotify_ids: [],
    });
    writeWindowAssignment(outputPath, payload({
      total_tracks: integrationIds.length,
      hashes: { [integrationIds[0]]: previewHash('a') },
      missing: [],
      failed: integrationIds.slice(1),
    }));

    const requestedIds = [];
    const hashById = Object.fromEntries(
      integrationIds.map((spotifyId, index) => [
        spotifyId,
        `${'b'.repeat(39)}${(index + 1).toString(16)}`,
      ]),
    );
    const fetchImpl = async url => {
      const spotifyId = decodeURIComponent(String(url).split('/').pop());
      requestedIds.push(spotifyId);
      return {
        ok: true,
        status: 200,
        text: async () => `https://p.scdn.co/mp3-preview/${hashById[spotifyId]}?cid=test`,
      };
    };
    const built = await builder.buildPreviewMap({
      browsePath,
      soundchartsPath: '',
      outputPath,
      mode: 'embed',
      concurrency: 1,
      attempts: 1,
      embedDelayMs: -1,
      checkpointEvery: 25,
      shardCount: 2,
      shardIndex: 1,
      fetchImpl,
    });
    const expectedRequested = [integrationIds[2], integrationIds[4], integrationIds[6]];
    assert.deepEqual(requestedIds, expectedRequested, 'modulo is applied after resume filtering');
    assert.equal(built.hashes[integrationIds[0]], previewHash('a'), 'existing hashes survive');
    assert.deepEqual(
      Object.keys(built.hashes).sort(),
      [integrationIds[0], ...expectedRequested].sort(),
      'unassigned pending IDs are intentionally absent from a partial shard output',
    );
    assert.equal(built.total_tracks, integrationIds.length, 'shards retain the global total');
    assert.equal(built.pending_tracks, integrationIds.length - 1);
    assert.deepEqual(built.shard_ids, expectedRequested);
    assert.equal(built.shard_completed_tracks, expectedRequested.length);
    assert.match(
      fs.readFileSync(outputPath, 'utf8'),
      /^window\.SPOTIFY_PREVIEW_AUDIO=\{.*\};\s*$/s,
      'builder output remains a window assignment',
    );

    requestedIds.length = 0;
    const resumed = await builder.buildPreviewMap({
      browsePath,
      soundchartsPath: '',
      outputPath,
      mode: 'embed',
      concurrency: 1,
      attempts: 1,
      embedDelayMs: -1,
      checkpointEvery: 25,
      shardCount: 2,
      shardIndex: 1,
      fetchImpl,
    });
    assert.deepEqual(requestedIds, [], 'a shard resumes only its original unresolved assignments');
    assert.deepEqual(resumed.shard_ids, expectedRequested);
    assert.equal(resumed.hashes[integrationIds[0]], previewHash('a'));

    const mergeIds = Array.from({ length: 6 }, (value, index) => trackId(index + 100));
    const base = payload({
      hashes: { [mergeIds[0]]: previewHash('a') },
      missing: [mergeIds[1]],
      failed: mergeIds.slice(2),
    });
    const shardZero = payload({
      hashes: {
        [mergeIds[0]]: previewHash('a'),
        [mergeIds[2]]: previewHash('b'),
      },
      missing: [mergeIds[1]],
      failed: [mergeIds[1], mergeIds[4]],
      shard: {
        shard_count: 2,
        shard_index: 0,
        pending_tracks: 4,
        shard_tracks: 2,
        shard_completed_tracks: 2,
        shard_ids: [mergeIds[2], mergeIds[4]],
      },
    });
    const shardOne = payload({
      hashes: {
        [mergeIds[0]]: previewHash('a'),
        [mergeIds[5]]: previewHash('c'),
      },
      missing: [mergeIds[0], mergeIds[1], mergeIds[3]],
      failed: [],
      shard: {
        shard_count: 2,
        shard_index: 1,
        pending_tracks: 4,
        shard_tracks: 2,
        shard_completed_tracks: 2,
        shard_ids: [mergeIds[3], mergeIds[5]],
      },
    });
    const merged = merger.mergePreviewPayloads(base, [shardZero, shardOne], {
      shardCount: 2,
    });
    assert.deepEqual(merged.hashes, {
      [mergeIds[0]]: previewHash('a'),
      [mergeIds[2]]: previewHash('b'),
      [mergeIds[5]]: previewHash('c'),
    });
    assert.deepEqual(merged.missing, [mergeIds[1], mergeIds[3]]);
    assert.deepEqual(merged.failed, [mergeIds[4]]);
    assert.equal(merged.available_tracks, 3);
    assert.equal(merged.missing_tracks, 2);
    assert.equal(merged.failed_tracks, 1);
    assert.equal(
      merged.available_tracks + merged.missing_tracks + merged.failed_tracks,
      merged.total_tracks,
      'the complete shard set accounts for every base ID',
    );

    assert.throws(
      () => merger.validatePreviewPayload(payload({
        hashes: { short: previewHash('a') },
        missing: mergeIds.slice(1),
        failed: [],
      }), 'invalid-id'),
      /invalid_spotify_id/,
    );
    assert.throws(
      () => merger.validatePreviewPayload(payload({
        hashes: { [mergeIds[0]]: 'f'.repeat(39) },
        missing: [mergeIds[1]],
        failed: mergeIds.slice(2),
      }), 'invalid-hash'),
      /invalid_preview_hash/,
    );
    assert.throws(
      () => merger.mergePreviewPayloads(base, [
        { ...shardZero, source_snapshot: 'different-snapshot' },
        shardOne,
      ], { shardCount: 2 }),
      /source_snapshot_mismatch/,
    );
    assert.throws(
      () => merger.mergePreviewPayloads(base, [
        shardZero,
        { ...shardOne, total_tracks: 7 },
      ], { shardCount: 2 }),
      /total_tracks_mismatch/,
    );
    assert.throws(
      () => merger.mergePreviewPayloads(base, [
        shardZero,
        { ...shardOne, shard_index: 0 },
      ], { shardCount: 2 }),
      /duplicate_shard_index/,
    );
    assert.throws(
      () => merger.mergePreviewPayloads(base, [
        { ...shardZero, shard_completed_tracks: 1 },
        shardOne,
      ], { shardCount: 2 }),
      /shard_completed_tracks_mismatch|incomplete_shard/,
    );
    assert.throws(
      () => merger.mergePreviewPayloads(base, [base, base], { shardCount: 2 }),
      /incomplete_shard_metadata_set/,
      'untouched base copies must never pass as completed shard outputs',
    );

    const basePath = path.join(temporaryDirectory, 'base.js');
    const shardZeroPath = path.join(temporaryDirectory, 'shard-0.js');
    const shardOnePath = path.join(temporaryDirectory, 'shard-1.js');
    const mergedPath = path.join(temporaryDirectory, 'merged.js');
    writeWindowAssignment(basePath, base);
    writeWindowAssignment(shardZeroPath, shardZero);
    writeWindowAssignment(shardOnePath, shardOne);
    const mergeResult = childProcess.spawnSync(process.execPath, [
      path.join(root, 'merge_spotify_preview_audio.js'),
      '--base',
      basePath,
      '--output',
      mergedPath,
      '--shard-count',
      '2',
      '--shard',
      shardZeroPath,
      '--shard',
      shardOnePath,
    ], { encoding: 'utf8' });
    assert.equal(mergeResult.status, 0, mergeResult.stderr);
    assert.deepEqual(
      merger.parseWindowAssignment(mergedPath),
      { ...merged, generated_at: merger.parseWindowAssignment(mergedPath).generated_at },
      'the merge CLI writes the canonical window assignment payload',
    );
    assert.match(mergeResult.stdout, /"shards":2/);

    assert.deepEqual(
      merger.parseArguments([
        '--base', basePath,
        '--output', mergedPath,
        '--shards', shardZeroPath, shardOnePath,
      ]).shardPaths,
      [path.resolve(shardZeroPath), path.resolve(shardOnePath)],
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  console.log('Spotify preview audio shard builders: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
