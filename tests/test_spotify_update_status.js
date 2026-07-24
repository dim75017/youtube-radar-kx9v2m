const fs=require('fs');
const dashboard=fs.readFileSync('spotify/dashboard.js','utf8');
const css=fs.readFileSync('spotify/dashboard.css','utf8');
const index=fs.readFileSync('spotify/index.html','utf8');
for(const required of [
  'function spotifyUpdateRows()',
  'function spotifyUpdateColor(when)',
  'function toggleSpotifyUpdateStatus(event)',
  'Pistes',
  'Artistes',
  'Playlists',
  'Labels',
  'PERF.generated_at',
  'PLmeta&&PLmeta.generated_ts',
  'LBmeta&&LBmeta.generated_ts'
]) if(!dashboard.includes(required)) throw new Error('Spotify update status is incomplete: '+required);
for(const required of ['.btn-spotify-update-status','.spotify-update-status-panel','.spotify-update-status-line'])
  if(!css.includes(required)) throw new Error('Spotify update status styling missing: '+required);
if(!/dashboard\.js\?v=[^"'\s]+/.test(index)) throw new Error('Spotify dashboard cache-busting version is missing');
console.log('spotify update status: ok');
