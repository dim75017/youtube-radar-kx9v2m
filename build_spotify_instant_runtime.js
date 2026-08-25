#!/usr/bin/env node
'use strict';

/**
 * Build the lightweight Spotify runtime used by the public dashboard.
 *
 * The source exports are intentionally large and keep complete histories for
 * offline analysis. Sending them to every browser blocked the main thread for
 * tens of seconds. This build step projects only the fields required by the
 * catalogue UI, plus a very small first-paint snapshot.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const DEFAULT_INSTANT = path.join(ROOT, 'Spotify_Instant_data.js');
const DEFAULT_CATALOGUE = path.join(ROOT, 'Spotify_Catalogue_data.js');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

function loadWindowExport(fileName, globalName) {
  const sourcePath = path.join(ROOT, fileName);
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, {
    filename: sourcePath,
    timeout: 30_000,
  });
  const value = context.window[globalName];
  if (!value || typeof value !== 'object') {
    throw new Error(`${fileName} did not expose window.${globalName}`);
  }
  return { value, sourcePath };
}

function schemaIndex(schema) {
  return Object.fromEntries(schema.map((field, index) => [field, index]));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return value == null ? '' : String(value);
}

function maxDate(...values) {
  return values.filter(Boolean).map(String).sort().pop() || '';
}

function atomicWrite(target, contents) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, 'utf8');
  fs.renameSync(temporary, target);
}

function stableHash(paths) {
  const hash = crypto.createHash('sha256');
  for (const sourcePath of paths) hash.update(fs.readFileSync(sourcePath));
  return hash.digest('hex').slice(0, 16);
}

function main() {
  const instantPath = argument('--instant', DEFAULT_INSTANT);
  const cataloguePath = argument('--catalogue', DEFAULT_CATALOGUE);
  const browseLoaded = loadWindowExport('Spotify_Browse_Catalogue_data.js', 'SPOTIFY_BROWSE_CATALOGUE');
  const playlistsLoaded = loadWindowExport('Spotify_Playlists_canonical_data.js', 'SPOTIFY_PLAYLISTS');
  const labelsLoaded = loadWindowExport('Spotify_Labels_data.js', 'SPOTIFY_LABELS');
  const browse = browseLoaded.value;
  const playlistsSource = playlistsLoaded.value;
  const labelsSource = labelsLoaded.value;
  const discovery = browse.discovery_catalogue || {};

  if (!Array.isArray(discovery.track_schema) || !Array.isArray(discovery.tracks)) {
    throw new Error('Spotify browse catalogue is missing its track schema or rows');
  }
  if (!Array.isArray(discovery.artist_schema) || !Array.isArray(discovery.artists)) {
    throw new Error('Spotify browse catalogue is missing its artist schema or rows');
  }
  if (!Array.isArray(playlistsSource.cols) || !Array.isArray(playlistsSource.rows)) {
    throw new Error('Spotify playlist catalogue is missing its schema or rows');
  }
  if (!Array.isArray(labelsSource.cols) || !Array.isArray(labelsSource.rows)) {
    throw new Error('Spotify label catalogue is missing its schema or rows');
  }

  const t = schemaIndex(discovery.track_schema);
  const a = schemaIndex(discovery.artist_schema);
  const p = schemaIndex(playlistsSource.cols);
  const l = schemaIndex(labelsSource.cols);
  const requiredTrackFields = [
    'spotify_id', 'title', 'credit_name', 'release_date', 'streams',
    'streams_delta_24h', 'rights_status', 'primary_genre', 'artists',
  ];
  for (const field of requiredTrackFields) {
    if (!Number.isInteger(t[field])) throw new Error(`Track schema is missing ${field}`);
  }

  // Compact positional schema. Keep it in the export so the browser never
  // depends on undocumented array offsets.
  const trackSchema = [
    'spotify_id', 'title', 'credit_name', 'release_date', 'streams',
    'delta_24h', 'rights_status', 'label', 'copyright', 'genre', 'image_url',
    'playlist_count', 'playlist_best_position', 'playlist_followers_total',
    'opportunity_eligible', 'artist_spotify_id', 'updated_at',
  ];
  const artistSchema = [
    'spotify_id', 'name', 'monthly_listeners', 'genre', 'image_url',
    'track_count', 'catalogue_streams', 'delta_24h', 'latest_release',
  ];
  const playlistSchema = [
    'spotify_id', 'name', 'owner', 'curator_category', 'followers', 'tracks',
    'first_seen', 'last_seen', 'genre', 'use_case', 'fit', 'image_url',
    'growth_30d', 'growth_days',
  ];
  const labelSchema = [
    'key', 'name', 'tracks', 'streams', 'since', 'artist_count', 'logo', 'email',
  ];

  const tracks = [];
  const artistRollup = new Map();
  for (const row of discovery.tracks) {
    if (!Array.isArray(row)) continue;
    const spotifyId = text(row[t.spotify_id]).trim();
    if (!spotifyId) continue;
    const artists = Array.isArray(row[t.artists]) ? row[t.artists] : [];
    const primaryArtist = artists.find(item => item && item.role === 'main') || artists[0] || {};
    const artistId = text(primaryArtist.spotify_id).trim();
    const streams = finite(row[t.streams]);
    const delta24 = finite(row[t.streams_delta_24h]);
    const releaseDate = text(row[t.release_date]);
    const compact = [
      spotifyId,
      text(row[t.title]),
      text(row[t.credit_name]),
      releaseDate,
      streams,
      delta24,
      text(row[t.rights_status]),
      text(row[t.label]),
      text(row[t.copyright]),
      text(row[t.primary_genre]),
      text(row[t.image_url]),
      finite(row[t.playlist_count]),
      finite(row[t.playlist_best_position]),
      finite(row[t.playlist_followers_total]),
      row[t.opportunity_eligible] === true,
      artistId,
      text(row[t.updated_at] || row[t.streams_source_date]),
    ];
    tracks.push(compact);
    if (artistId) {
      const rollup = artistRollup.get(artistId) || {
        tracks: 0,
        streams: 0,
        delta24: 0,
        latest: '',
        image: '',
        credit: text(primaryArtist.name || row[t.credit_name]),
      };
      rollup.tracks += 1;
      rollup.streams += streams || 0;
      rollup.delta24 += delta24 || 0;
      rollup.latest = maxDate(rollup.latest, releaseDate);
      if (!rollup.image) rollup.image = text(row[t.image_url]);
      artistRollup.set(artistId, rollup);
    }
  }

  const artistMetadata = new Map();
  for (const row of discovery.artists) {
    if (!Array.isArray(row)) continue;
    const spotifyId = text(row[a.spotify_id]).trim();
    if (spotifyId) artistMetadata.set(spotifyId, row);
  }
  const artists = [...artistRollup.entries()].map(([spotifyId, rollup]) => {
    const row = artistMetadata.get(spotifyId) || [];
    return [
      spotifyId,
      text(row[a.name] || rollup.credit || 'Artiste non renseigné'),
      finite(row[a.monthly_listeners]),
      text(row[a.primary_genre]),
      text(row[a.image_url] || rollup.image),
      rollup.tracks,
      rollup.streams,
      rollup.delta24,
      rollup.latest,
    ];
  });

  const playlists = playlistsSource.rows
    .filter(row => Array.isArray(row) && row[p.big10k])
    .map(row => [
      text(row[p.id]), text(row[p.name]), text(row[p.owner]), text(row[p.curatorCat]),
      finite(row[p.followers]), finite(row[p.tracks]), text(row[p.first_seen]),
      text(row[p.last_seen]), text(row[p.genre]), text(row[p.use_case]),
      finite(row[p.fit]), text(row[p.image_url]), finite(row[p.growth30]),
      finite(row[p.growth30Days]),
    ]);

  const labels = labelsSource.rows
    .filter(Array.isArray)
    .map(row => [
      text(row[l.key]), text(row[l.name]), finite(row[l.tracks]), finite(row[l.streams]),
      text(row[l.since]), finite(row[l.nArtists]), text(row[l.logo]), text(row[l.email]),
    ]);

  tracks.sort((left, right) => (right[4] || 0) - (left[4] || 0));
  artists.sort((left, right) => (right[6] || 0) - (left[6] || 0));
  playlists.sort((left, right) => (right[4] || 0) - (left[4] || 0));
  labels.sort((left, right) => (right[3] || 0) - (left[3] || 0));
  const opportunities = tracks
    .filter(row => row[14])
    .sort((left, right) => (right[5] || 0) - (left[5] || 0) || (right[4] || 0) - (left[4] || 0));

  if (tracks.length < 1_000 || artists.length < 100 || playlists.length < 100 || labels.length < 100) {
    throw new Error(`Refusing incomplete compact catalogue: ${tracks.length} tracks, ${artists.length} artists, ${playlists.length} playlists, ${labels.length} labels`);
  }

  const sourceHash = stableHash([
    browseLoaded.sourcePath,
    playlistsLoaded.sourcePath,
    labelsLoaded.sourcePath,
  ]);
  const counts = {
    tracks: tracks.length,
    artists: artists.length,
    playlists: playlists.length,
    labels: labels.length,
    opportunities: opportunities.length,
  };
  const common = {
    version: 2,
    generated_at: maxDate(
      browse.generated_at,
      playlistsSource.meta && playlistsSource.meta.snapshot_ts,
      labelsSource.meta && labelsSource.meta.generated_ts,
    ),
    source_hash: sourceHash,
    counts,
    schemas: {
      tracks: trackSchema,
      artists: artistSchema,
      playlists: playlistSchema,
      labels: labelSchema,
    },
  };
  const catalogue = {
    ...common,
    tracks,
    radar: opportunities,
    artists,
    playlists,
    labels,
  };
  const instant = {
    ...common,
    // Enough rows for the first screen and the first navigation interactions.
    // The complete 1–2 MiB gzip catalogue is hydrated after first paint.
    tracks: tracks.slice(0, 160),
    radar: opportunities.slice(0, 160),
    artists: artists.slice(0, 100),
    playlists: playlists.slice(0, 100),
    labels: labels.slice(0, 100),
  };

  const catalogueJson = JSON.stringify(catalogue);
  const instantJson = JSON.stringify(instant);
  const instantBytes = Buffer.byteLength(instantJson);
  const catalogueBytes = Buffer.byteLength(catalogueJson);
  if (instantBytes > 250_000) {
    throw new Error(`Spotify first-paint snapshot exceeds 250 kB: ${instantBytes} bytes`);
  }
  if (catalogueBytes > 8_000_000) {
    throw new Error(`Spotify compact catalogue exceeds 8 MB: ${catalogueBytes} bytes`);
  }

  atomicWrite(
    cataloguePath,
    `/* Generated by build_spotify_instant_runtime.js. */\nwindow.SPOTIFY_CATALOGUE=${catalogueJson};\n`,
  );
  atomicWrite(
    instantPath,
    `/* Generated by build_spotify_instant_runtime.js. */\nwindow.SPOTIFY_INSTANT=${instantJson};\n`,
  );
  process.stdout.write(
    `Spotify compact runtime built (${sourceHash}): ` +
    `${counts.tracks} tracks, ${counts.artists} artists, ${counts.playlists} playlists, ` +
    `${counts.labels} labels, ${counts.opportunities} opportunities; ` +
    `${instantBytes} B first paint, ${catalogueBytes} B compact catalogue.\n`,
  );
}

main();
