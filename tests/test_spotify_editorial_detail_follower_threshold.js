'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('spotify/dashboard.js', 'utf8');
const index = fs.readFileSync('spotify/index.html', 'utf8');
const helperStart = source.indexOf('const AR_DETAIL_EDITORIAL_MIN_FOLLOWERS=');
const helperEnd = source.indexOf('\nfunction arPlaylistSnapshotValue', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'the editorial detail threshold helper must remain independently testable');

const context = {
  arEditorialPlaylists: opportunity => {
    const rows = Array.isArray(opportunity.editorialPlaylists)
      ? opportunity.editorialPlaylists.filter(playlist => playlist && (playlist.spotifyId || playlist.name))
      : [];
    if (rows.length) return rows;
    return opportunity.topPlaylist
      ? [{name: opportunity.topPlaylist, followers: opportunity.playlistFollowers}]
      : [];
  },
  arEditorialMiniData: playlist => ({followers: playlist.resolvedFollowers ?? playlist.followers}),
};
vm.runInNewContext(`${source.slice(helperStart, helperEnd)}; this.filterDetailPlaylists=arDetailEditorialPlaylists; this.minimum=AR_DETAIL_EDITORIAL_MIN_FOLLOWERS;`, context);

assert.equal(context.minimum, 10_000, 'the detail threshold is inclusive at 10k followers');
const filtered = context.filterDetailPlaylists({editorialPlaylists: [
  {name: 'Below', resolvedFollowers: 9_999},
  {name: 'Boundary', resolvedFollowers: 10_000},
  {name: 'Above', resolvedFollowers: 25_000},
  {name: 'Missing'},
  {name: 'Empty', resolvedFollowers: ''},
  {name: 'Invalid', resolvedFollowers: 'unknown'},
  {name: 'Infinite', resolvedFollowers: Infinity},
]});
assert.deepEqual(Array.from(filtered, playlist => playlist.name), ['Boundary', 'Above'],
  'track details must include 10k+ playlists and exclude lower, missing, or invalid audiences');
assert.deepEqual(Array.from(context.filterDetailPlaylists({
  topPlaylist: 'Aggregate-only fallback',
  playlistCount: 2,
  playlistFollowers: 25_000,
}), playlist => playlist.name), [],
  'an aggregate editorial follower total must never qualify an individual fallback playlist');

const evidenceStart = source.indexOf('function arEditorialPlaylistEvidenceHtml(');
const evidenceEnd = source.indexOf('\nfunction arDetailEditorialPlaylistsHtml', evidenceStart);
assert.ok(evidenceStart >= 0 && evidenceEnd > evidenceStart, 'the shared editorial detail panel must exist');
const evidence = source.slice(evidenceStart, evidenceEnd);
assert.match(evidence, /const playlists=arDetailEditorialPlaylists\(opportunity\)/,
  'catalogue track evidence must use the 10k detail filter');
assert.match(evidence, /function arEditorialPlaylistPanelHtml[\s\S]*const playlists=arDetailEditorialPlaylists\(opportunity\)/,
  'the shared catalogue and A&R detail panel must use the 10k filter');
assert.doesNotMatch(evidence, /Origine de la découverte/,
  'unknown discovery-source audiences must not bypass the minimum in track details');
assert.match(evidence, /≥ 10k followers/,
  'the detail panel must disclose the editorial audience threshold');
assert.match(index, /dashboard\.js\?v=20260821-web-playback-v1&amp;editorial=10k-v1/,
  'the published dashboard asset must bypass caches for the 10k detail rule');

const cardStart = source.indexOf('function arEditorialCardHtml(');
const cardEnd = source.indexOf('\nconst AR_PLAYLIST_COVER_CACHE', cardStart);
assert.ok(cardStart >= 0 && cardEnd > cardStart, 'the non-detail A&R editorial card must remain available');
assert.match(source.slice(cardStart, cardEnd), /const playlists=arEditorialPlaylists\(opportunity\)/,
  'the request must not silently change the compact non-detail A&R list');

console.log('Spotify editorial detail follower threshold checks passed.');
