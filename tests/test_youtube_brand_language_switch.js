'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const youtubeIndex = fs.readFileSync('index.html', 'utf8');
const youtubeCss = fs.readFileSync('assets/css/dashboard.css', 'utf8');
const youtubeHelpers = fs.readFileSync('assets/js/dashboard-02-helpers.js', 'utf8');
const youtubeRecommendations = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const spotifyIndex = fs.readFileSync('spotify/index.html', 'utf8');
const spotifyCss = fs.readFileSync('spotify/dashboard.css', 'utf8');
const spotifyDashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');

assert.match(youtubeIndex, /<title>Lofi Radar — YouTube Veille<\/title>/);
assert.match(youtubeIndex, /<small>YouTube Veille<\/small>/);
assert.doesNotMatch(youtubeIndex, /Opportunity Map/);
assert.match(youtubeRecommendations, /tag\.textContent='YouTube Veille'/);
assert.match(youtubeHelpers, /Synchronisation avec YouTube Veille/);
assert.match(youtubeCss, /--acc:#ff0033; --acc2:#ff5272; --accSoft:rgba\(255,0,51,\.13\)/);
for (const oldAccent of ['#8b7cf6', '#a78bfa', 'rgba(139,124,246', 'rgba(167,139,250']) {
  assert.equal(youtubeCss.includes(oldAccent), false, `YouTube UI still contains its old violet accent: ${oldAccent}`);
}

assert.match(spotifyIndex, /<button id="lang-btn" class="fr"/);
assert.match(spotifyIndex, /class="lg-slide"/);
assert.match(spotifyIndex, /class="lg-opt" data-l="en"/);
assert.match(spotifyIndex, /class="lg-opt" data-l="fr"/);
assert.doesNotMatch(spotifyIndex, /lang-switch|ls-knob|ls-flag/);
assert.match(spotifyCss, /#lang-btn\{position:fixed;top:14px;right:18px/);
assert.match(spotifyCss, /#lang-btn \.lg-slide/);
assert.match(spotifyCss, /#lang-btn\.fr \.lg-slide\{transform:translateX\(47px\)\}/);
assert.match(spotifyDashboard, /getElementById\('lang-btn'\)/);
assert.match(spotifyDashboard, /querySelectorAll\('\.lg-opt'\)/);
assert.doesNotMatch(spotifyDashboard, /lang-switch|ls-knob|ls-flag/);

console.log('YouTube red identity and shared language-switch format are enforced.');
