'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');
const roadmap = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

assert.match(css, /--uiAcc:#9aa8ff/, 'a muted UI accent is defined separately from YouTube red');
assert.match(css, /\.radar-switch a\.yt\.on\{color:#fff;background:rgba\(255,0,51/, 'the YouTube brand switch remains red');
assert.match(css, /\.nav button\.active\{\s*color:#fff;background:linear-gradient\(90deg, rgba\(154,168,255/, 'sidebar navigation uses the soft UI accent');
assert.match(css, /\.cal-viewtoggle button\.on\{background:#8f9ef8/, 'calendar and list controls use the soft UI accent');
assert.match(css, /\.vstat\.hl b\{color:var\(--uiAcc2\)/, 'views/month and live highlight metrics no longer use red');
assert.match(roadmap, /function roadmapUpcomingRows\(rows,now=Date\.now\(\)\)/, 'roadmap list has a forward-looking date filter');
assert.match(roadmap, /window\._rm_rows=RM\.mode==='cal'\?rows:listRows/, 'calendar retains full history while list receives only future rows');
assert.match(roadmap, /rows=roadmapUpcomingRows\(rows\)/, 'the table applies the future-only filter');
assert.match(index, /dashboard\.css\?v=20260724-youtube-analysis-title-v2/, 'stylesheet cache version is renewed');
assert.match(index, /dashboard-04-recommendations\.js\?v=20260724-soft-ui-roadmap-v1/, 'roadmap script cache version is renewed');

console.log('YouTube soft UI and roadmap queue: OK');
