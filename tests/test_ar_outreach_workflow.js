'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const spotify = fs.readFileSync('spotify/dashboard.js', 'utf8');
const spotifyNav = fs.readFileSync('spotify/index.html', 'utf8');
const youtubeNav = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');

for (const token of ['AR_LIST_STORAGE', 'function arAddToList(', 'function renderArList(', 'function openArOutreach(', 'function arOutreachDraft(', 'function arMarkContacted(']) {
  assert.ok(spotify.includes(token), `Missing A&R outreach workflow component: ${token}`);
}
assert.match(spotify, /arContactEligible\(opportunity\)/, 'Outreach must retain strict contact eligibility');
assert.match(spotify, /mailto:\$\{encodeURIComponent\(currentEmail\)\}/, 'The mail client handoff must remain user initiated');
assert.match(spotify, /aucun e-mail n’est envoyé/i, 'The UI must not imply automatic sending');
assert.doesNotMatch(spotifyNav, /data-v="watch"/, 'Spotify watchlist navigation must be removed');
assert.doesNotMatch(youtubeNav, /id:'watch'/, 'YouTube watchlist navigation must be removed');

console.log('A&R outreach workflow and watchlist removal: OK');
