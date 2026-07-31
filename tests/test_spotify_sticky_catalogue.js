const assert = require('assert');
const fs = require('fs');
const css = fs.readFileSync('spotify/dashboard.css','utf8');
const js = fs.readFileSync('spotify/dashboard.js','utf8');
const index = fs.readFileSync('spotify/index.html','utf8');

assert.match(css, /#view>\.toolbar,#view>\.ar-radar-head\{position:sticky/,
  'Les filtres catalogue et Opportunités doivent rester visibles au défilement.');
assert.match(css, /#view>\.ar-radar-head\+\.ar-columnbar\{position:sticky/,
  'Le tri des Opportunités doit rester associé à ses filtres.');
assert.match(css, /\.catalogue-table thead th\{position:sticky/,
  'Les intitulés de colonnes catalogue doivent rester visibles au défilement.');
assert.match(js, /function syncSpotifyStickyControls\(\)/,
  'La hauteur réelle des filtres doit être mesurée pour placer l’en-tête de tableau.');
assert.match(js, /requestAnimationFrame\(syncSpotifyStickyControls\)/,
  'La synchronisation doit s’exécuter après chaque rendu et redimensionnement.');
assert.match(index, /dashboard\.js\?v=20260801-track-floor-100k-v1/,
  'La nouvelle interface ne doit pas être servie depuis un cache périmé.');

console.log('Spotify sticky catalogue tests passed');
