'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/js/dashboard-04-recommendations.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/dashboard.css'), 'utf8');
const start = source.indexOf('function setValid(');
const end = source.indexOf('const WRITE_URL=', start);
const decisionSource = source.slice(start, end);

function testContext(reducedMotion){
  const classes=[];
  const timers=[];
  const card={
    classList:{add(...names){classes.push(...names);}},
    setAttribute(name,value){this[name]=value;},
    getAttribute(name){return this[name]||null;},
  };
  let saves=0;
  let renders=0;
  let writes=0;
  const context={
    DATA:{recos:[{n:1,valid:'',title:'Animated idea'}]},
    _cmtTimer:null,
    clearTimeout(){},
    setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},
    noteOf(){return '';},
    recommendationRoadmapEntry(){return null;},
    saveCache(){saves+=1;},
    rerenderRecos(){renders+=1;},
    writeValid(){writes+=1;},
    document:{getElementById(id){return id==='drawer'?{classList:{contains:()=>false}}:null;}},
    window:{_drawerRecoN:null,matchMedia:()=>({matches:reducedMotion})},
  };
  vm.runInNewContext(`${decisionSource}\nthis.setValidForTest=setValid;`,context);
  return {
    context,
    card,
    classes,
    timers,
    counts:()=>({saves,renders,writes}),
    button:{closest:selector=>selector==='.rtile'?card:null},
  };
}

for (const [mode,expectedClass] of [['X','is-accepted'],['-','is-refused']]){
  const test=testContext(false);
  test.context.setValidForTest(1,mode,test.button,{stopPropagation(){}});
  assert.equal(test.context.DATA.recos[0].valid,mode,
    'the recommendation state updates before the animation finishes');
  assert.deepEqual(test.counts(),{saves:1,renders:0,writes:1},
    'saving and remote persistence start immediately while rerender waits for the card animation');
  assert.ok(test.classes.includes('reco-decision')&&test.classes.includes(expectedClass),
    `the ${mode==='X'?'validation':'refusal'} decision applies its card animation class`);
  assert.equal(test.card['aria-busy'],'true',
    'the transitioning card exposes its temporary state to assistive technology');
  test.context.setValidForTest(1,mode,test.button,{stopPropagation(){}});
  assert.deepEqual(test.counts(),{saves:1,renders:0,writes:1},
    'a repeated click cannot enqueue a second decision while the card is leaving');
  assert.equal(test.timers.length,1);
  assert.equal(test.timers[0].delay,560,
    'the fade-in, short hold and fade-out stay visible without slowing the workflow beyond 600 ms');
  test.timers[0].callback();
  assert.equal(test.counts().renders,1,
    'the current recommendation tab rerenders after the animation');
}

const reduced=testContext(true);
reduced.context.setValidForTest(1,'X',reduced.button,{stopPropagation(){}});
assert.equal(reduced.timers.length,0,
  'reduced-motion users never wait on a decorative animation');
assert.equal(reduced.counts().renders,1,
  'the recommendation list rerenders immediately when motion is reduced');

assert.match(css,/\.rtile\.reco-decision\{[^}]*--reco-decision-rgb:74,222,128/,
  'validation uses a green decision treatment');
assert.match(css,/\.rtile\.reco-decision\{[^}]*pointer-events:none/,
  'the transitioning card ignores pointer input until it is removed');
assert.match(css,/\.rtile\.reco-decision\.is-refused\{[^}]*--reco-decision-rgb:251,113,133/,
  'refusal uses a red decision treatment');
assert.match(css,/@keyframes reco-decision-out/);
assert.match(css,/animation:reco-decision-out \.56s/,
  'the card exit duration must stay synchronized with the JavaScript rerender delay');
assert.match(css,/animation:reco-decision-flash \.56s/,
  'the decision overlay must use the same perceptible but fast duration');
assert.match(css,/@keyframes reco-decision-flash\{0%\{opacity:0;[^}]+\}18%\{opacity:1;[^}]+\}58%\{opacity:1;[^}]+\}100%\{opacity:0;/,
  'the overlay must fade in, remain visible briefly, then fade out');
assert.match(css,/@keyframes reco-decision-out\{[^}]+\}18%\{[^}]*opacity:1[^}]+\}58%\{[^}]*opacity:1[^}]+\}100%\{[^}]*opacity:0/,
  'the card must remain readable during the hold before its fade-out');
assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.rtile\.reco-decision,\.rtile\.reco-decision::after\{animation:none!important\}\}/,
  'CSS also disables the decorative animation for reduced-motion users');

console.log('YouTube recommendation decision animation: OK');
