'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync('assets/css/dashboard.css','utf8');
const helpers = fs.readFileSync('assets/js/dashboard-02-helpers.js','utf8');
const index = fs.readFileSync('index.html','utf8');

assert.match(css, /--ytRed:#ff0033/, 'La couleur de marque YouTube doit rester explicitement réservée.');
assert.match(css, /--acc:#9aa8ff/, 'Les contrôles génériques doivent employer une teinte froide plutôt que le rouge.');
assert.match(css, /\.radar-switch a\.yt\.on\{color:#fff;background:rgba\(255,0,51/, 'Le sélecteur YouTube conserve sa couleur de marque.');
assert.match(css, /\.vha-card\.down em\{color:var\(--red\)\}/, 'Les signaux négatifs restent rouges.');
assert.match(helpers, /const liveViewers=u==='viewers';/, 'Les courbes doivent distinguer les lives des vidéos.');
assert.match(helpers, /const chartStroke=liveViewers\?'#ff5272':'#9aa8ff';/, 'Les vidéos utilisent l’indigo ; les viewers live gardent le rouge.');
assert.match(index, /youtube-soft-palette-v1/, 'Les ressources mises à jour doivent contourner le cache navigateur.');

console.log('YouTube soft palette: OK');
