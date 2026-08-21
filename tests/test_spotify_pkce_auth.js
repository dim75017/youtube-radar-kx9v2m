'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'spotify', 'index.html'), 'utf8');
const player = fs.readFileSync(path.join(root, 'spotify', 'player.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'spotify', 'dashboard.js'), 'utf8');
const previewData = fs.readFileSync(path.join(root, 'Spotify_Preview_Audio_data.js'), 'utf8');
const activeBrowserPayload = [index, player, dashboard, previewData].join('\n');

assert.doesNotMatch(
  index,
  /<script\b[^>]*\bsrc=["'][^"']*(?:auth\.js|callback\.html|sdk\.scdn\.co\/spotify-player\.js)[^"']*["']/i,
  'the Spotify Radar page must not load OAuth, callback, or Web Playback SDK code',
);
assert.doesNotMatch(
  activeBrowserPayload,
  /SpotifyRadarAuth|onSpotifyWebPlaybackSDKReady|new\s+(?:global\.)?Spotify\.Player|accounts\.spotify\.com\/authorize|accounts\.spotify\.com\/api\/token/i,
  'the active browser payload must not contain an authentication or Web Playback path',
);
assert.doesNotMatch(
  activeBrowserPayload,
  /\b(?:client_id|clientId|client_secret|access_token|refresh_token|code_verifier|code_challenge)\b|Authorization\s*:\s*["'`]Bearer/i,
  'the static Radar payload must not embed an OAuth client identifier, token, or secret',
);
assert.doesNotMatch(
  player,
  /sessionStorage|spotify_radar_oauth|user-modify-playback-state|\/v1\/me\/player|forceRefresh/i,
  'the custom preview player must not retain dormant OAuth or playback-transfer behavior',
);

const previewIndex = index.indexOf('../Spotify_Preview_Audio_data.js');
const playerIndex = index.indexOf('player.js?v=20260821-custom-preview-v1');
assert.ok(previewIndex >= 0 && playerIndex > previewIndex,
  'the anonymous preview map is available before player initialization');

console.log('Spotify anonymous player auth guardrails: OK');
