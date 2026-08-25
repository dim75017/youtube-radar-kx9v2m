'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const youtubeHtml = fs.readFileSync('index.html', 'utf8');
const spotifyHtml = fs.readFileSync('spotify/index.html', 'utf8');
const socialLayout = fs.readFileSync('social-app/app/layout.tsx', 'utf8');
const socialPreview = fs.readFileSync('social-app/preview/main.tsx', 'utf8');
const socialShell = fs.readFileSync('social-app/app/SocialOS.tsx', 'utf8');
const foundation = fs.readFileSync('assets/css/radar-foundation.css', 'utf8');
const youtubeCss = fs.readFileSync('assets/css/dashboard.css', 'utf8');
const spotifyCss = fs.readFileSync('spotify/dashboard.css', 'utf8');
const socialCss = fs.readFileSync('social-app/app/editorial.css', 'utf8');

test('all three Radar surfaces load the same visual foundation and Inter family', () => {
  assert.match(youtubeHtml, /assets\/css\/radar-foundation\.css\?v=20260825-da-v1/);
  assert.match(spotifyHtml, /\.\.\/assets\/css\/radar-foundation\.css\?v=20260825-da-v1/);
  assert.match(socialLayout, /\.\.\/assets\/css\/radar-foundation\.css\?v=20260825-da-v1/);
  assert.match(socialPreview, /\.\.\/\.\.\/assets\/css\/radar-foundation\.css/);
  assert.match(socialPreview, /\.\.\/app\/editorial\.css/);
  for (const html of [youtubeHtml, spotifyHtml, socialLayout]) {
    assert.match(html, /family=Inter:wght@400;500;600;700;800/);
    assert.doesNotMatch(html, /family=Sora|&family=Sora/);
  }
  assert.match(foundation, /--radar-page-title:27px/);
  assert.match(foundation, /--radar-section-title:15px/);
  assert.match(foundation, /--radar-sidebar:224px/);
});

test('platform styles map their shell, titles and panels to the shared tokens', () => {
  for (const css of [youtubeCss, spotifyCss, socialCss]) {
    assert.match(css, /var\(--radar-font\)|var\(--radar-body\)/);
    assert.match(css, /var\(--radar-page-title\)/);
    assert.match(css, /var\(--radar-section-title\)/);
    assert.match(css, /var\(--radar-sidebar\)/);
    assert.match(css, /var\(--radar-panel\)/);
  }
  assert.match(socialShell, /className="brand-mark" src="\.\.\/assets\/lofi-radar-logo\.jpg"/);
});

test('Spotify keeps desktop tables intact and mobile cards auto-sized', () => {
  assert.doesNotMatch(spotifyCss, /@media\(max-width:1750px\)\{\s*\.panel\{overflow:visible\}/);
  assert.match(spotifyCss, /@media\(max-width:860px\)\{\s*\.panel\{overflow:visible\}/);
  assert.match(spotifyCss, /height:auto;min-height:68px/);
});
