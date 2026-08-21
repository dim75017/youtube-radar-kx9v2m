'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TRACK_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const PREVIEW_HASH_PATTERN = /^[a-f0-9]{40}$/i;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function parseWindowAssignment(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const separator = source.indexOf('=');
  if (separator < 0) throw new Error(`window_assignment_missing:${filePath}`);
  return JSON.parse(source.slice(separator + 1).replace(/;\s*$/u, ''));
}

function addTrackRows(target, rows, schema) {
  const spotifyIdIndex = Array.isArray(schema) ? schema.indexOf('spotify_id') : -1;
  if (spotifyIdIndex < 0 || !Array.isArray(rows)) return;
  for (const row of rows) {
    const spotifyId = String(row && row[spotifyIdIndex] || '').trim();
    if (TRACK_ID_PATTERN.test(spotifyId)) target.add(spotifyId);
  }
}

function collectTrackIds(browse, soundcharts) {
  const ids = new Set();
  const snapshot = soundcharts || {};
  const schemas = snapshot.schemas || {};
  // Player-facing opportunities and measured tracks are resolved first so a
  // resumed build always has useful coverage before it reaches the long tail.
  addTrackRows(ids, snapshot.opportunities, schemas.opportunities);
  addTrackRows(ids, snapshot.tracks, schemas.tracks);
  const editorial = snapshot.editorial || {};
  addTrackRows(ids, editorial.tracks, editorial.track_schema);
  const discovery = snapshot.discovery_catalogue || {};
  addTrackRows(ids, discovery.tracks, discovery.track_schema);
  const browseDiscovery = browse && browse.discovery_catalogue || {};
  addTrackRows(ids, browseDiscovery.tracks, browseDiscovery.track_schema);
  for (const value of browse && browse.active_legacy_spotify_ids || []) {
    const spotifyId = String(value || '').trim();
    if (TRACK_ID_PATTERN.test(spotifyId)) ids.add(spotifyId);
  }
  return [...ids];
}

function extractPreviewHash(html) {
  const normalized = String(html || '')
    .replace(/\\u002[fF]/gu, '/')
    .replace(/\\\//gu, '/');
  const match = normalized.match(
    /https:\/\/p\.scdn\.co\/mp3-preview\/([a-f0-9]{40})(?=[^a-f0-9]|$)/iu,
  );
  return match ? match[1].toLowerCase() : '';
}

function extractPreviewHashFromUrl(value) {
  const match = String(value || '').match(
    /^https:\/\/p\.scdn\.co\/mp3-preview\/([a-f0-9]{40})(?:[/?#]|$)/iu,
  );
  return match ? match[1].toLowerCase() : '';
}

function findAnonymousAccessToken(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 40 &&
    value.isAnonymous !== false
  ) return value.accessToken;
  for (const nested of Object.values(value)) {
    const token = findAnonymousAccessToken(nested, seen);
    if (token) return token;
  }
  return '';
}

function extractAnonymousEmbedSession(html) {
  const source = String(html || '');
  const match = source.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu,
  );
  if (!match) return { accessToken: '', previewHash: extractPreviewHash(source) };
  try {
    const data = JSON.parse(match[1]);
    return {
      accessToken: findAnonymousAccessToken(data),
      previewHash: extractPreviewHash(source),
    };
  } catch (error) {
    return { accessToken: '', previewHash: extractPreviewHash(source) };
  }
}

function parseExistingOutput(filePath) {
  if (!fs.existsSync(filePath)) return { hashes: {}, missing: [] };
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    const separator = source.indexOf('=');
    if (separator < 0) return { hashes: {}, missing: [] };
    const data = JSON.parse(source.slice(separator + 1).replace(/;\s*$/u, ''));
    return {
      hashes: data && typeof data.hashes === 'object' && data.hashes ? data.hashes : {},
      missing: Array.isArray(data && data.missing) ? data.missing : [],
    };
  } catch (error) {
    return { hashes: {}, missing: [] };
  }
}

function retryAfterMilliseconds(response, attempt) {
  const header = Number(response && response.headers && response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 300_000);
  return Math.min(750 * (2 ** attempt), 12_000) + Math.floor(Math.random() * 350);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchPreviewHash(spotifyId, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const attempts = Math.max(1, Number(options.attempts) || 4);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 18_000);
  const url = `https://open.spotify.com/embed/track/${encodeURIComponent(spotifyId)}`;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.8',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });
      if (response.status === 404) return { status: 'missing', hash: '' };
      if (!response.ok) {
        const error = new Error(`spotify_embed_http_${response.status}`);
        error.response = response;
        throw error;
      }
      const hash = extractPreviewHash(await response.text());
      return hash ? { status: 'available', hash } : { status: 'missing', hash: '' };
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      await wait(retryAfterMilliseconds(error && error.response, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('spotify_preview_lookup_failed');
}

async function fetchAnonymousEmbedSession(spotifyId, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const attempts = Math.max(1, Number(options.attempts) || 6);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 18_000);
  const url = `https://open.spotify.com/embed/track/${encodeURIComponent(spotifyId)}`;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.8',
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });
      if (!response.ok) {
        const error = new Error(`spotify_embed_session_http_${response.status}`);
        error.response = response;
        throw error;
      }
      const session = extractAnonymousEmbedSession(await response.text());
      if (!session.accessToken) throw new Error('spotify_embed_anonymous_token_missing');
      return session;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      await wait(retryAfterMilliseconds(error && error.response, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('spotify_embed_session_failed');
}

async function fetchPreviewBatch(spotifyIds, accessToken, options = {}) {
  const ids = [...new Set(spotifyIds)].filter(id => TRACK_ID_PATTERN.test(id)).slice(0, 50);
  if (!ids.length) return { status: 'ok', hashes: {}, missing: [] };
  if (!accessToken) throw new Error('spotify_embed_anonymous_token_missing');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const attempts = Math.max(1, Number(options.attempts) || 8);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 18_000);
  const url = `https://api.spotify.com/v1/tracks?market=FR&ids=${ids.join(',')}`;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });
      if (response.status === 401) return { status: 'expired', hashes: {}, missing: [] };
      if (!response.ok) {
        const error = new Error(`spotify_tracks_http_${response.status}`);
        error.response = response;
        throw error;
      }
      const body = await response.json();
      const rows = Array.isArray(body && body.tracks) ? body.tracks : [];
      const hashes = {};
      const returned = new Set();
      for (const track of rows) {
        const spotifyId = String(track && track.id || '');
        if (!ids.includes(spotifyId)) continue;
        returned.add(spotifyId);
        const hash = extractPreviewHashFromUrl(track.preview_url);
        if (hash) hashes[spotifyId] = hash;
      }
      return {
        status: 'ok',
        hashes,
        missing: ids.filter(id => !hashes[id] || !returned.has(id)),
      };
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      const delay = retryAfterMilliseconds(error && error.response, attempt);
      if (error && error.response && error.response.status === 429) {
        process.stdout.write(`spotify-api rate-limited; retrying in ${Math.ceil(delay / 1000)}s\n`);
      }
      await wait(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('spotify_preview_batch_failed');
}

function buildPayload(options) {
  const wanted = new Set(options.ids);
  const hashes = {};
  for (const spotifyId of options.ids) {
    const hash = String(options.hashes[spotifyId] || '').toLowerCase();
    if (PREVIEW_HASH_PATTERN.test(hash)) hashes[spotifyId] = hash;
  }
  const missing = [...options.missing].filter(id => wanted.has(id)).sort();
  const failed = [...options.failed].filter(id => wanted.has(id)).sort();
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source: 'spotify_audio_preview_clip',
    source_snapshot: options.sourceSnapshot || '',
    duration_seconds: 30,
    total_tracks: options.ids.length,
    available_tracks: Object.keys(hashes).length,
    missing_tracks: missing.length,
    failed_tracks: failed.length,
    hashes,
    missing,
    failed,
  };
}

function writePayload(filePath, payload) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporary,
    `window.SPOTIFY_PREVIEW_AUDIO=${JSON.stringify(payload)};\n`,
    'utf8',
  );
  fs.renameSync(temporary, filePath);
}

async function buildPreviewMap(options) {
  const browse = parseWindowAssignment(options.browsePath);
  const soundcharts = options.soundchartsPath
    ? parseWindowAssignment(options.soundchartsPath)
    : null;
  const ids = collectTrackIds(browse, soundcharts);
  const wanted = new Set(ids);
  const mode = options.mode === 'embed' ? 'embed' : 'batch';
  const previous = parseExistingOutput(options.outputPath);
  const hashes = {};
  for (const [spotifyId, hash] of Object.entries(previous.hashes)) {
    if (wanted.has(spotifyId) && PREVIEW_HASH_PATTERN.test(String(hash || ''))) {
      hashes[spotifyId] = String(hash).toLowerCase();
    }
  }
  // A nullable Web API preview_url is not definitive: the public embed page
  // can still expose a licensed preview clip, so embed mode rechecks misses.
  const missing = new Set(
    (mode === 'embed' ? [] : previous.missing).filter(id => wanted.has(id)),
  );
  const failed = new Set();
  const pending = ids.filter(id => !hashes[id] && !missing.has(id));
  const concurrency = Math.max(1, Math.min(80, Number(options.concurrency) || 4));
  const checkpointEvery = Math.max(25, Number(options.checkpointEvery) || 250);
  const batchDelayMs = Math.max(0, Number(options.batchDelayMs) || 350);
  const embedDelayMs = Math.max(0, Number(options.embedDelayMs) || 500);
  let cursor = 0;
  let completed = 0;
  let lastCheckpoint = Date.now();

  const checkpoint = force => {
    if (!force && completed % checkpointEvery !== 0 && Date.now() - lastCheckpoint < 20_000) return;
    writePayload(options.outputPath, buildPayload({
      ids,
      hashes,
      missing,
      failed,
      sourceSnapshot: browse.generated_at || '',
    }));
    lastCheckpoint = Date.now();
    process.stdout.write(
      `preview-map ${Object.keys(hashes).length}/${ids.length} available, ` +
      `${missing.size} missing, ${failed.size} failed, ${pending.length - completed} pending\n`,
    );
  };

  async function embedWorker() {
    while (cursor < pending.length) {
      const spotifyId = pending[cursor];
      cursor += 1;
      try {
        const result = await fetchPreviewHash(spotifyId, options);
        if (result.status === 'available') hashes[spotifyId] = result.hash;
        else missing.add(spotifyId);
      } catch (error) {
        failed.add(spotifyId);
      } finally {
        completed += 1;
        checkpoint(false);
      }
      if (cursor < pending.length && embedDelayMs) await wait(embedDelayMs);
    }
  }

  checkpoint(true);
  if (mode === 'embed') {
    await Promise.all(Array.from(
      { length: Math.min(concurrency, Math.max(1, pending.length)) },
      embedWorker,
    ));
  } else if (pending.length) {
    let session = await fetchAnonymousEmbedSession(pending[0], options);
    if (session.previewHash) hashes[pending[0]] = session.previewHash;
    while (cursor < pending.length) {
      const batch = pending.slice(cursor, cursor + 50);
      cursor += batch.length;
      try {
        let result = await fetchPreviewBatch(batch, session.accessToken, options);
        if (result.status === 'expired') {
          session = await fetchAnonymousEmbedSession(batch[0], options);
          result = await fetchPreviewBatch(batch, session.accessToken, options);
        }
        if (result.status !== 'ok') throw new Error(`spotify_preview_batch_${result.status}`);
        Object.assign(hashes, result.hashes);
        for (const spotifyId of Object.keys(result.hashes)) missing.delete(spotifyId);
        for (const spotifyId of result.missing) {
          if (!hashes[spotifyId]) missing.add(spotifyId);
        }
      } catch (error) {
        for (const spotifyId of batch) failed.add(spotifyId);
      } finally {
        completed += batch.length;
        checkpoint(false);
      }
      if (cursor < pending.length && batchDelayMs) await wait(batchDelayMs);
    }
  }
  checkpoint(true);
  return buildPayload({
    ids,
    hashes,
    missing,
    failed,
    sourceSnapshot: browse.generated_at || '',
  });
}

function argumentValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const root = __dirname;
  const options = {
    browsePath: path.resolve(argumentValue(args, '--browse', path.join(root, 'Spotify_Browse_Catalogue_data.js'))),
    soundchartsPath: path.resolve(argumentValue(
      args,
      '--soundcharts',
      path.join(root, 'Spotify_Soundcharts_data_20260819T232812Z.js'),
    )),
    outputPath: path.resolve(argumentValue(args, '--output', path.join(root, 'Spotify_Preview_Audio_data.js'))),
    mode: argumentValue(args, '--mode', 'batch'),
    concurrency: Number(argumentValue(args, '--concurrency', '4')),
    attempts: Number(argumentValue(args, '--attempts', '8')),
    timeoutMs: Number(argumentValue(args, '--timeout-ms', '18000')),
    checkpointEvery: Number(argumentValue(args, '--checkpoint-every', '250')),
    batchDelayMs: Number(argumentValue(args, '--batch-delay-ms', '350')),
    embedDelayMs: Number(argumentValue(args, '--embed-delay-ms', '500')),
  };
  const payload = await buildPreviewMap(options);
  process.stdout.write(`${JSON.stringify({
    total_tracks: payload.total_tracks,
    available_tracks: payload.available_tracks,
    missing_tracks: payload.missing_tracks,
    failed_tracks: payload.failed_tracks,
    output: options.outputPath,
  })}\n`);
  if (payload.failed_tracks > 0) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectTrackIds,
  extractPreviewHash,
  extractPreviewHashFromUrl,
  extractAnonymousEmbedSession,
  fetchPreviewHash,
  fetchAnonymousEmbedSession,
  fetchPreviewBatch,
  parseWindowAssignment,
  buildPayload,
};
