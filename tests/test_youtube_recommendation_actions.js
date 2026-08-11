'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');

assert.match(source, /function recosHTML\(\)\{ensureRecommendationPerformanceHistory\(\);const html=recoTabControlHTML\(\)\+'<div id="reco-list">'/,
  'the daily selection has compact status controls but no verbose header');
assert.doesNotMatch(source.slice(source.indexOf('function recoCardHTML'), source.indexOf('function recoInfoRows')),
  /_dailyReasons/, 'selection-reason chips are absent from recommendation cards');
assert.doesNotMatch(source, /function validateRecommendationNow\(/,
  'validation must not silently add a recommendation to the roadmap');
assert.doesNotMatch(source, /Validate &amp; schedule/,
  'the action must remain a plain validation');
const validation = source.slice(source.indexOf('function setValid('), source.indexOf('const WRITE_URL=', source.indexOf('function setValid(')));
assert.doesNotMatch(validation, /openSchedulePopup/,
  'validation and roadmap placement must remain two separate decisions');
assert.match(source, /function placeValidatedRecommendation\(n,ev\)/,
  'validated recommendations expose a dedicated roadmap-placement action');
const placement = source.slice(source.indexOf('function placeValidatedRecommendation('), source.indexOf('function recommendationRoadmapActionHTML('));
assert.match(placement, /openSchedulePopup\(reco\)/,
  'the explicit roadmap action opens the existing date picker');
assert.match(source, /onclick="placeValidatedRecommendation\('\+reco\.n\+',event\)"/,
  'validated cards expose the explicit roadmap-placement button');
assert.match(source, /function refreshDailyRecommendations\(ev\)/,
  'the pending queue exposes an explicit refresh action');
assert.match(source, /reco-refresh-btn/,
  'the pending status controls render the new-ideas button');
assert.match(source, /function openRecoEditor\(n,ev\)/,
  'recommendation cards expose a title and description editor');
for (const [name, startMarker, endMarker] of [
  ['pending', 'function recoCardHTML(', 'function recoInfoRows('],
  ['validated', 'function recoValidatedCardHTML(', 'function recoValidatedHTML('],
]) {
  const section = source.slice(source.indexOf(startMarker), source.indexOf(endMarker));
  assert.match(section, /openRecoEditor\(/, `${name} recommendation cards expose the edit action`);
}
const refusedCard = source.slice(source.indexOf('function recoRefusedCardHTML('), source.indexOf('function recoRefusedHTML('));
assert.doesNotMatch(refusedCard, /openRecoEditor\(/,
  'refused recommendation cards expose only restoration, not editing');
assert.match(refusedCard, /reco-restore/,
  'refused recommendation cards keep a clear restore action');
const validatedCard = source.slice(source.indexOf('function recoValidatedCardHTML('), source.indexOf('function recoValidatedHTML('));
assert.doesNotMatch(validatedCard, /reco-validated-state/,
  'the validated tab does not repeat a redundant validated-state badge');
assert.match(validatedCard, /reco-refuse-btn[^>]*>✕ /,
  'validated cards expose a full labelled refusal button');
assert.match(source, /function previewSchedDay\(timestamp\)/,
  'each date circle can reveal releases on that day');
assert.match(source, /function schedDayPopoverHtml\(date,rows\)/,
  'the date picker opens a compact release popover beside an occupied day');
assert.match(source, /function positionSchedDayPopover\(\)/,
  'the compact release popover is positioned by its clicked date');
assert.match(source, /function shiftSchedMonth\(delta\)/,
  'the date picker can navigate to adjacent months');
assert.match(source, /data-sched-day=/,
  'calendar controls identify their exact day for the popover');
assert.match(source, /SCHED_CUR\.sug=Object\.assign\(\{\},SCHED_CUR\.sug,\{date\}\)/,
  'a date click must move the proposed release marker and saved date');
const schedulePopup = source.slice(source.indexOf('function renderSchedPopup()'), source.indexOf('function previewSchedDay('));
assert.match(schedulePopup, /sched-btn-alt/,
  'the date picker restores the yellow alternate-date action beside confirmation');
assert.match(source, /function proposeAlternateSchedDate\(\)/,
  'the alternate-date action generates another rules-based proposal');
assert.doesNotMatch(schedulePopup, /Not now|Date de sortie proposée|Suggested release date/,
  'the date picker stays minimal: no explanatory header or deferred action');
assert.doesNotMatch(source, /schedNearbyReleases/,
  'nearby releases must be replaced by the compact exact-day popover');
assert.match(source, /recoN:reco\.n/,
  'roadmap entries preserve their recommendation identity');
assert.match(source, /saveSharedRecommendationRoadmap\(reco,entry\)/,
  'a generated recommendation placement is queued for the shared Roadmap');
assert.doesNotMatch(source, /Remember to also report this date in the Google Sheet Roadmap/,
  'the confirmation no longer asks the team to duplicate a shared placement manually');
assert.match(source, /function setRecoTab\(tab\)/,
  'the recommendation view exposes its three decision-status tabs');
assert.match(source, /refusedRecommendationRows\(\)/,
  'refused recommendations remain available in their dedicated tab');
assert.match(source, /activeTodayIds=todayIds\.slice\(0,RECO_DAILY_LIMIT\)/,
  'a legacy queue cannot exceed the daily cap');
assert.match(source, /renderNav\(\)/,
  'the sidebar count refreshes after a recommendation decision');
assert.match(source, /setValid\('\+r\.n\+',\\'-\\'/,
  'each card exposes a direct refusal control');
const card = source.slice(source.indexOf('function recoCardHTML'), source.indexOf('function recoInfoRows'));
assert.ok(card.indexOf('rbtn-ko') < card.indexOf('rbtn-ok'),
  'card refusal must sit left of validation');
const detail = source.slice(source.indexOf('function recoActions'), source.indexOf('function recoCommentBox'));
assert.ok(detail.indexOf('rbtn-ko') < detail.indexOf('rbtn-ok'),
  'detail refusal must sit left of validation');
assert.doesNotMatch(detail, /rst-done rst-(?:ok|ko)/,
  'detail actions do not repeat the status already communicated by the active tab');
assert.match(detail, /:isRef\s*\?'<button class="rbtn reco-restore"/,
  'a refused recommendation detail exposes only restoration');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');
assert.match(css, /\.rbtn-ok\{background:rgba\(74,222,128,\.1\);color:var\(--green\);border:1\.5px solid rgba\(74,222,128,\.5\)\}/,
  'validation uses the same transparent treatment as refusal');
assert.match(css, /\.reco-roadmap-btn\{background:rgba\(74,222,128,\.12\)/,
  'Roadmap placement is the green primary action on validated cards');
assert.match(css, /\.rtile:hover\{[^}]*border-color:color-mix\(in srgb,var\(--gc\) 58%,var\(--border\)\)/,
  'recommendation hover follows the card genre accent instead of a fixed red border');
assert.match(css, /\.sched-cell\{appearance:none;border:1px solid transparent;background:rgba\(150,163,214,\.06\);width:34px;height:34px/,
  'the date picker renders large circular day controls');
assert.match(css, /\.sched-cell\.has-event\{background:var\(--sched-event-color/,
  'occupied days fill the whole date circle with their genre color');
assert.match(css, /\.sched-cell:hover\{transform:none;border-color:var\(--sched-event-color/,
  'calendar hover must extend the day color around the full contour without enlarging a red block');
assert.match(css, /\.sched-cal-nav\{width:26px;height:26px/,
  'calendar month navigation uses compact previous/next controls');
assert.match(css, /\.sched-day-popover\{position:absolute/,
  'the release detail is a mini popover instead of a block below the calendar');
assert.match(source, /const hasStoredDailyQueue=Array\.isArray\(history\[day\]\)/,
  'the daily queue distinguishes an existing empty lot from a missing lot');
assert.match(source, /if\(hasStoredDailyQueue\)\{/,
  'an existing daily lot returns only its still-pending cards without replenishment');
assert.match(source, /finalizeDailyRecommendationHistoryProfile\(history,day\)/,
  'late performance history never replaces an existing daily lot');

console.log('YouTube recommendation actions: OK');
