'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'spotify', 'dashboard.js'), 'utf8');
const playlists = fs.readFileSync(path.join(root, 'Spotify_Playlists_canonical_data.js'), 'utf8');

assert.match(dashboard, /plgenre:'all'/, 'Playlist filter state must include a genre selection.');
assert.match(dashboard, /function playlistGenreSignals\(r\)/, 'Playlist genre aliases must be normalized in one helper.');
assert.match(dashboard, /\[r\[1\], r\[10\], r\[11\], r\[13\]\]/, 'Genre matching must cover title, source genre, use case and validated keywords.');
assert.match(dashboard, /guitar: \/\(\?:guitar\|acoustic\|fingerstyle/, 'Guitar aliases must cover acoustic and fingerstyle playlists.');
assert.match(dashboard, /classical: \/\(\?:classical\|classique/, 'Classical aliases must be supported.');
assert.match(dashboard, /id="pl-genre"/, 'The Playlists toolbar must expose the genre filter.');
assert.match(dashboard, /value="guitar"/, 'The Guitar filter must be available.');
assert.match(dashboard, /value="classical"/, 'The Classical filter must be available.');
assert.match(dashboard, /"Guitare":"Guitar"/, 'The Guitar filter must be translated in English.');
assert.match(dashboard, /"Classique":"Classical"/, 'The Classical filter must be translated in English.');
assert.match(dashboard, /playlistMatchesGenre\(r, S\.plgenre\)/, 'The selected playlist genre must affect results.');
assert.match(playlists, /Peaceful Guitar/, 'Fixture must include the Ambient-classified Peaceful Guitar playlist.');

console.log('Spotify playlist guitar/classical filters: OK');
