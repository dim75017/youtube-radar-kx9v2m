'use strict';

const assert = require('node:assert/strict');
const builder = require('../build_spotify_preview_audio.js');

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const ID_C = 'CCCCCCCCCCCCCCCCCCCCCC';
const HASH_A = '0123456789abcdef0123456789abcdef01234567';

(async () => {
  const ids = builder.collectTrackIds(
    {
      active_legacy_spotify_ids: [ID_A, ID_B],
      discovery_catalogue: {track_schema: ['spotify_id'], tracks: [[ID_B]]},
    },
    {
      schemas: {
        opportunities: ['spotify_id'],
        tracks: ['spotify_id'],
      },
      opportunities: [[ID_C]],
      tracks: [[ID_A]],
    },
  );
  assert.deepEqual(ids, [ID_C, ID_A, ID_B], 'player-facing rows are prioritized and deduplicated');

  assert.equal(
    builder.extractPreviewHash(`audioPreview=https:\\u002f\\u002fp.scdn.co\\u002fmp3-preview\\u002f${HASH_A}`),
    HASH_A,
  );
  assert.equal(
    builder.extractPreviewHashFromUrl(`https://p.scdn.co/mp3-preview/${HASH_A}?cid=public`),
    HASH_A,
  );

  const fakeToken = 'anonymous-session-token-'.padEnd(64, 'x');
  const embedHtml = [
    '<script id="__NEXT_DATA__" type="application/json">',
    JSON.stringify({props: {session: {accessToken: fakeToken, isAnonymous: true}}}),
    '</script>',
    `https://p.scdn.co/mp3-preview/${HASH_A}`,
  ].join('');
  assert.deepEqual(
    builder.extractAnonymousEmbedSession(embedHtml),
    {accessToken: fakeToken, previewHash: HASH_A},
    'the anonymous session and exact CDN hash are parsed in memory',
  );

  let requestedUrl = '';
  let authorization = '';
  const batch = await builder.fetchPreviewBatch([ID_A, ID_B], fakeToken, {
    attempts: 1,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      authorization = options.headers.Authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({tracks: [
          {id: ID_A, preview_url: `https://p.scdn.co/mp3-preview/${HASH_A}`},
          {id: ID_B, preview_url: null},
        ]}),
      };
    },
  });
  assert.match(requestedUrl, /market=FR/);
  assert.equal(authorization, `Bearer ${fakeToken}`);
  assert.deepEqual(batch, {status: 'ok', hashes: {[ID_A]: HASH_A}, missing: [ID_B]});

  const expired = await builder.fetchPreviewBatch([ID_A], fakeToken, {
    attempts: 1,
    fetchImpl: async () => ({ok: false, status: 401}),
  });
  assert.deepEqual(expired, {status: 'expired', hashes: {}, missing: []});

  const payload = builder.buildPayload({
    ids: [ID_A, ID_B],
    hashes: {[ID_A]: HASH_A, [ID_B]: 'invalid'},
    missing: new Set([ID_B]),
    failed: new Set(),
    sourceSnapshot: 'snapshot',
  });
  assert.equal(payload.available_tracks, 1);
  assert.equal(payload.missing_tracks, 1);
  assert.equal(payload.failed_tracks, 0);
  assert.deepEqual(payload.hashes, {[ID_A]: HASH_A});

  console.log('Spotify preview audio builder: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
