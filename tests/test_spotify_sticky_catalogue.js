const assert = require('assert');
const fs = require('fs');
const css = fs.readFileSync('spotify/dashboard.css','utf8');
const js = fs.readFileSync('spotify/dashboard.js','utf8');
const index = fs.readFileSync('spotify/index.html','utf8');

assert.match(css, /#view>\.toolbar,#view>\.ar-radar-head\{position:sticky/,
  'Les filtres catalogue et OpportunitÃ©s doivent rester visibles au dÃ©filement.');
assert.match(css, /#view>\.ar-radar-head\+\.ar-columnbar\{position:sticky/,
  'Le tri des OpportunitÃ©s doit rester associÃ© Ã  ses filtres.');
assert.match(css, /\.catalogue-table thead th\{position:sticky/,
  'Les intitulÃ©s de colonnes catalogue doivent rester visibles au dÃ©filement.');
assert.match(js, /function syncSpotifyStickyControls\(\)/,
  'La hauteur rÃ©elle des filtres doit Ãªtre mesurÃ©e pour placer lâ€™en-tÃªte de tableau.');
assert.match(js, /requestAnimationFrame\(syncSpotifyStickyControls\)/,
  'La synchronisation doit sâ€™exÃ©cuter aprÃ¨s chaque rendu et redimensionnement.');
assert.match(index, /dashboard\.js\?v=20260801-track-floor-100k-v1/,
  'La nouvelle interface ne doit pas Ãªtre servie depuis un cache pÃ©rimÃ©.');

console.log('Spotify sticky catalogue tests passed');

