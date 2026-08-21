'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TRACK_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const PREVIEW_HASH_PATTERN = /^[a-f0-9]{40}$/i;
const IDENTITY_FIELDS = ['version', 'source', 'source_snapshot', 'duration_seconds', 'total_tracks'];

function parseWindowAssignment(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const separator = source.indexOf('=');
  if (separator < 0) throw new Error(`window_assignment_missing:${filePath}`);
  try {
    return JSON.parse(source.slice(separator + 1).replace(/;\s*$/u, ''));
  } catch (error) {
    throw new Error(`window_assignment_invalid_json:${filePath}`, { cause: error });
  }
}

function assertNonNegativeInteger(value, field, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid_${field}:${label}`);
  }
}

function validateIdList(value, field, label) {
  if (!Array.isArray(value)) throw new Error(`invalid_${field}:${label}`);
  const seen = new Set();
  for (const spotifyId of value) {
    if (typeof spotifyId !== 'string' || !TRACK_ID_PATTERN.test(spotifyId)) {
      throw new Error(`invalid_spotify_id:${label}:${field}:${spotifyId}`);
    }
    if (seen.has(spotifyId)) throw new Error(`duplicate_spotify_id:${label}:${field}:${spotifyId}`);
    seen.add(spotifyId);
  }
  return seen;
}

function validatePreviewPayload(payload, label = 'payload', options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`invalid_payload:${label}`);
  }
  assertNonNegativeInteger(payload.total_tracks, 'total_tracks', label);
  if (typeof payload.source !== 'string' || !payload.source.trim()) {
    throw new Error(`invalid_source:${label}`);
  }
  if (typeof payload.source_snapshot !== 'string') {
    throw new Error(`invalid_source_snapshot:${label}`);
  }
  if (!payload.hashes || typeof payload.hashes !== 'object' || Array.isArray(payload.hashes)) {
    throw new Error(`invalid_hashes:${label}`);
  }

  const hashes = {};
  for (const [spotifyId, value] of Object.entries(payload.hashes)) {
    if (!TRACK_ID_PATTERN.test(spotifyId)) {
      throw new Error(`invalid_spotify_id:${label}:hashes:${spotifyId}`);
    }
    const hash = String(value || '').toLowerCase();
    if (!PREVIEW_HASH_PATTERN.test(hash)) {
      throw new Error(`invalid_preview_hash:${label}:${spotifyId}`);
    }
    hashes[spotifyId] = hash;
  }

  const missing = validateIdList(payload.missing, 'missing', label);
  const failed = validateIdList(payload.failed, 'failed', label);
  if (payload.available_tracks !== undefined) {
    assertNonNegativeInteger(payload.available_tracks, 'available_tracks', label);
    if (payload.available_tracks !== Object.keys(hashes).length) {
      throw new Error(`available_tracks_mismatch:${label}`);
    }
  }
  if (payload.missing_tracks !== undefined) {
    assertNonNegativeInteger(payload.missing_tracks, 'missing_tracks', label);
    if (payload.missing_tracks !== payload.missing.length) {
      throw new Error(`missing_tracks_mismatch:${label}`);
    }
  }
  if (payload.failed_tracks !== undefined) {
    assertNonNegativeInteger(payload.failed_tracks, 'failed_tracks', label);
    if (payload.failed_tracks !== payload.failed.length) {
      throw new Error(`failed_tracks_mismatch:${label}`);
    }
  }

  const accountedIds = new Set([...Object.keys(hashes), ...missing, ...failed]);
  if (accountedIds.size > payload.total_tracks) {
    throw new Error(`too_many_accounted_tracks:${label}`);
  }
  if (options.requireComplete && accountedIds.size !== payload.total_tracks) {
    throw new Error(
      `unaccounted_tracks:${label}:${payload.total_tracks - accountedIds.size}`,
    );
  }

  const shardFields = [
    'shard_count',
    'shard_index',
    'pending_tracks',
    'shard_tracks',
    'shard_completed_tracks',
    'shard_ids',
  ];
  const shardFieldCount = shardFields.filter(field => payload[field] !== undefined).length;
  let shard = null;
  if (shardFieldCount > 0) {
    if (shardFieldCount !== shardFields.length) {
      throw new Error(`incomplete_shard_metadata:${label}`);
    }
    assertNonNegativeInteger(payload.shard_count, 'shard_count', label);
    assertNonNegativeInteger(payload.shard_index, 'shard_index', label);
    assertNonNegativeInteger(payload.pending_tracks, 'pending_tracks', label);
    assertNonNegativeInteger(payload.shard_tracks, 'shard_tracks', label);
    assertNonNegativeInteger(
      payload.shard_completed_tracks,
      'shard_completed_tracks',
      label,
    );
    if (payload.shard_count < 2 || payload.shard_index >= payload.shard_count) {
      throw new Error(`invalid_shard_identity:${label}`);
    }
    if (
      payload.shard_tracks > payload.pending_tracks ||
      payload.shard_completed_tracks > payload.shard_tracks
    ) {
      throw new Error(`invalid_shard_counts:${label}`);
    }
    const shardIds = validateIdList(payload.shard_ids, 'shard_ids', label);
    if (shardIds.size !== payload.shard_tracks) {
      throw new Error(`shard_tracks_mismatch:${label}`);
    }
    const completedShardIds = new Set(
      [...shardIds].filter(
        spotifyId => hashes[spotifyId] || missing.has(spotifyId) || failed.has(spotifyId),
      ),
    );
    if (completedShardIds.size !== payload.shard_completed_tracks) {
      throw new Error(`shard_completed_tracks_mismatch:${label}`);
    }
    shard = {
      count: payload.shard_count,
      index: payload.shard_index,
      pendingTracks: payload.pending_tracks,
      tracks: payload.shard_tracks,
      completedTracks: payload.shard_completed_tracks,
      ids: shardIds,
    };
  }

  return { payload, hashes, missing, failed, accountedIds, shard };
}

function validateIdentity(base, shard, label) {
  for (const field of IDENTITY_FIELDS) {
    if (shard.payload[field] !== base.payload[field]) {
      throw new Error(`${field}_mismatch:${label}`);
    }
  }
}

function mergePreviewPayloads(basePayload, shardPayloads, options = {}) {
  const base = validatePreviewPayload(basePayload, options.baseLabel || 'base', {
    requireComplete: true,
  });
  if (!Array.isArray(shardPayloads) || shardPayloads.length < 1) {
    throw new Error('missing_shard_payloads');
  }
  const expectedShardCount = options.shardCount === undefined
    ? shardPayloads.length
    : Number(options.shardCount);
  if (!Number.isInteger(expectedShardCount) || expectedShardCount < 1) {
    throw new Error(`invalid_shard_count:${options.shardCount}`);
  }
  if (shardPayloads.length !== expectedShardCount) {
    throw new Error(`shard_count_mismatch:${shardPayloads.length}:${expectedShardCount}`);
  }

  const labels = Array.isArray(options.shardLabels) ? options.shardLabels : [];
  const shards = shardPayloads.map((payload, index) => {
    const label = labels[index] || `shard-${index}`;
    const shard = validatePreviewPayload(payload, label);
    validateIdentity(base, shard, label);
    for (const spotifyId of shard.accountedIds) {
      if (!base.accountedIds.has(spotifyId)) {
        throw new Error(`unknown_spotify_id:${label}:${spotifyId}`);
      }
    }
    if (shard.shard) {
      for (const spotifyId of shard.shard.ids) {
        if (!base.accountedIds.has(spotifyId)) {
          throw new Error(`unknown_spotify_id:${label}:shard_ids:${spotifyId}`);
        }
      }
    }
    return { ...shard, label };
  });

  const metadataShards = shards.filter(shard => shard.shard);
  if (expectedShardCount > 1 && metadataShards.length !== shards.length) {
    throw new Error('incomplete_shard_metadata_set');
  }
  if (metadataShards.length) {
    const seenIndexes = new Set();
    const seenShardIds = new Set();
    let pendingTracks = null;
    for (const item of metadataShards) {
      const shard = item.shard;
      if (shard.count !== expectedShardCount) {
        throw new Error(`shard_count_mismatch:${item.label}`);
      }
      if (seenIndexes.has(shard.index)) {
        throw new Error(`duplicate_shard_index:${shard.index}`);
      }
      seenIndexes.add(shard.index);
      if (pendingTracks === null) pendingTracks = shard.pendingTracks;
      else if (pendingTracks !== shard.pendingTracks) {
        throw new Error(`pending_tracks_mismatch:${item.label}`);
      }
      if (shard.completedTracks !== shard.tracks) {
        throw new Error(`incomplete_shard:${item.label}`);
      }
      for (const spotifyId of shard.ids) {
        if (seenShardIds.has(spotifyId)) {
          throw new Error(`duplicate_shard_assignment:${spotifyId}`);
        }
        seenShardIds.add(spotifyId);
      }
    }
    if (seenIndexes.size !== expectedShardCount) throw new Error('missing_shard_index');
    if (seenShardIds.size !== pendingTracks) {
      throw new Error(`pending_tracks_uncovered:${pendingTracks - seenShardIds.size}`);
    }
  }

  const hashes = {};
  const missing = new Set();
  const failed = new Set();
  const addPayload = (validated, label) => {
    for (const [spotifyId, hash] of Object.entries(validated.hashes)) {
      if (hashes[spotifyId] && hashes[spotifyId] !== hash) {
        throw new Error(`preview_hash_conflict:${spotifyId}:${label}`);
      }
      hashes[spotifyId] = hash;
    }
    for (const spotifyId of validated.missing) missing.add(spotifyId);
    for (const spotifyId of validated.failed) failed.add(spotifyId);
  };
  addPayload(base, options.baseLabel || 'base');
  for (const shard of shards) addPayload(shard, shard.label);

  for (const spotifyId of Object.keys(hashes)) {
    missing.delete(spotifyId);
    failed.delete(spotifyId);
  }
  for (const spotifyId of missing) failed.delete(spotifyId);

  const sortedHashes = {};
  for (const spotifyId of Object.keys(hashes).sort()) sortedHashes[spotifyId] = hashes[spotifyId];
  const sortedMissing = [...missing].sort();
  const sortedFailed = [...failed].sort();
  const accountedIds = new Set([
    ...Object.keys(sortedHashes),
    ...sortedMissing,
    ...sortedFailed,
  ]);
  if (accountedIds.size !== base.payload.total_tracks) {
    throw new Error(`merged_total_tracks_mismatch:${accountedIds.size}:${base.payload.total_tracks}`);
  }

  return {
    version: base.payload.version,
    generated_at: new Date().toISOString(),
    source: base.payload.source,
    source_snapshot: base.payload.source_snapshot,
    duration_seconds: base.payload.duration_seconds,
    total_tracks: base.payload.total_tracks,
    available_tracks: Object.keys(sortedHashes).length,
    missing_tracks: sortedMissing.length,
    failed_tracks: sortedFailed.length,
    hashes: sortedHashes,
    missing: sortedMissing,
    failed: sortedFailed,
  };
}

function writePayload(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporary,
    `window.SPOTIFY_PREVIEW_AUDIO=${JSON.stringify(payload)};\n`,
    'utf8',
  );
  fs.renameSync(temporary, filePath);
}

function parseArguments(args) {
  const root = __dirname;
  const result = {
    basePath: path.join(root, 'Spotify_Preview_Audio_data.js'),
    outputPath: path.join(root, 'Spotify_Preview_Audio_data.js'),
    shardPaths: [],
    shardCount: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--base' || argument === '--output' || argument === '--shard') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing_argument_value:${argument}`);
      index += 1;
      if (argument === '--base') result.basePath = path.resolve(value);
      else if (argument === '--output') result.outputPath = path.resolve(value);
      else result.shardPaths.push(path.resolve(value));
    } else if (argument === '--shard-count') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('missing_argument_value:--shard-count');
      index += 1;
      result.shardCount = Number(value);
    } else if (argument === '--shards') {
      const start = result.shardPaths.length;
      while (args[index + 1] && !args[index + 1].startsWith('--')) {
        result.shardPaths.push(path.resolve(args[index + 1]));
        index += 1;
      }
      if (result.shardPaths.length === start) throw new Error('missing_argument_value:--shards');
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown_argument:${argument}`);
    } else {
      result.shardPaths.push(path.resolve(argument));
    }
  }
  if (!result.shardPaths.length) throw new Error('missing_shard_paths');
  if (result.shardCount === null) result.shardCount = result.shardPaths.length;
  return result;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const basePayload = parseWindowAssignment(options.basePath);
  const shardPayloads = options.shardPaths.map(parseWindowAssignment);
  const payload = mergePreviewPayloads(basePayload, shardPayloads, {
    baseLabel: options.basePath,
    shardLabels: options.shardPaths,
    shardCount: options.shardCount,
  });
  writePayload(options.outputPath, payload);
  process.stdout.write(`${JSON.stringify({
    total_tracks: payload.total_tracks,
    available_tracks: payload.available_tracks,
    missing_tracks: payload.missing_tracks,
    failed_tracks: payload.failed_tracks,
    shards: options.shardPaths.length,
    output: options.outputPath,
  })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseWindowAssignment,
  validatePreviewPayload,
  mergePreviewPayloads,
  writePayload,
  parseArguments,
};
