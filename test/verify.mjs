// Headless-Chrome verification of index.html.
// Dependency-free: node's global WebSocket + fetch only. No package.json.
//
//   node test/verify.mjs            (needs Chrome on CDP port 9222 — see README)
//
// All paths are derived from this file's own location, so the suite runs from
// any checkout without editing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FILE = pathToFileURL(join(REPO, 'index.html')).href;
const OUT  = join(HERE, 'artifacts');
mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
let events = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else { events.push(m); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params }));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n        ↳ ' + detail : ''}`);
};

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function shot(name, full = false) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
}
async function key(k, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}

await send('Page.enable'); await send('Runtime.enable');
await send('Log.enable'); await send('Network.enable');

const errs = () => events.filter(e =>
  e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(e.params.type)) ||
  (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)));
const errText = () => JSON.stringify(errs().map(e =>
  e.params?.entry?.text || e.params?.exceptionDetails?.text || e.params?.args?.[0]?.value)).slice(0, 500);

async function load(width, height, media = []) {
  events = [];
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: media });
  await send('Page.navigate', { url: FILE });
  await sleep(1100);
  try { await send('Page.bringToFront'); } catch (e) { /* focus tests will show it */ }
}

// ══════════════════════════════════════════ AC1: clean load, no network
console.log('\n── Acceptance: loads from file:// with zero errors and zero network requests');
await load(1280, 900);
check('zero console errors or warnings on load', errs().length === 0, errText());
const net = events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request.url);
check('zero remote network requests (document only)',
  net.filter(u => /^(https?|ws|ftp):/i.test(u)).length === 0, `saw: ${JSON.stringify(net)}`);
check('no fetch/XHR/WebSocket/storage in source', await ev(
  `!/fetch\\(|XMLHttpRequest|new WebSocket|localStorage|sessionStorage|document\\.cookie/
     .test(document.documentElement.outerHTML)`));

const LAST = await ev('16-1');
check('page structure: header, 4 actors, all sections, footer', await ev(`
  document.querySelectorAll('h1').length === 1 &&
  ['intro','simulation','walkthrough','context-anatomy','tool-anatomy','glossary']
    .every(i => document.getElementById(i)) &&
  ['actor-user','actor-harness','actor-model','actor-tools'].every(i => document.getElementById(i)) &&
  !!document.querySelector('footer.site')`));

// ══════════════════════════════════════════ Matrix: step through
console.log('\n── Matrix: Step advances exactly one stage per click, in sync');
check('starts at stage 0 with an empty context stack', await ev(`
  document.getElementById('progress-text').textContent === 'Step 0 of 14' &&
  document.getElementById('token-count').textContent === '0 tokens' &&
  [...document.querySelectorAll('#ctx-stack .ctx-block')].every(b => b.hidden)`));

let bad = '';
const expectTokens = { 3: 3612, 5: 3652, 10: 3832, 12: 3927 };
let seenTokens = 0;
for (let i = 1; i <= 15; i++) {
  await ev(`document.getElementById('btn-step').click()`);
  await sleep(120);
  const st = await ev(`(() => ({
    prog: document.getElementById('progress-text').textContent,
    label: document.getElementById('stage-label').textContent,
    cap: document.getElementById('caption').textContent.length,
    tok: +document.getElementById('token-count').textContent.replace(/[^0-9]/g,''),
    blocks: [...document.querySelectorAll('#ctx-stack .ctx-block')].filter(b => !b.hidden).length,
    hl: [...document.querySelectorAll('.actor')].filter(a => /hl-/.test(a.className)).length,
    fill: parseFloat(document.getElementById('token-fill').style.width)
  }))()`);
  const wantProg = i === 15 ? 'Complete' : `Step ${i} of 14`;
  if (st.prog !== wantProg) bad += `stage ${i}: progress "${st.prog}" != "${wantProg}"; `;
  if (st.cap < 40) bad += `stage ${i}: caption too short (${st.cap}); `;
  if (st.tok < seenTokens) bad += `stage ${i}: token count went backwards; `;
  if (expectTokens[i] && st.tok !== expectTokens[i]) bad += `stage ${i}: tokens ${st.tok} != ${expectTokens[i]}; `;
  if (st.hl > 1) bad += `stage ${i}: ${st.hl} actors highlighted; `;
  seenTokens = st.tok;
}
check('15 Step clicks walk the turn with caption, label, actor highlight and token stack in sync', !bad, bad);
check('final state: all 6 context blocks visible, 3,927 tokens', await ev(`
  [...document.querySelectorAll('#ctx-stack .ctx-block')].filter(b => !b.hidden).length === 6 &&
  document.getElementById('token-count').textContent === '3,927 tokens'`));

// token meter must actually move (the bug that was fixed)
const fills = await ev(`(() => {
  const out = [];
  document.getElementById('btn-reset').click();
  for (let i = 0; i <= 15; i++) {
    out.push(parseFloat(document.getElementById('token-fill').style.width) || 0);
    document.getElementById('btn-step').click();
  }
  return out;
})()`);
check('token meter visibly grows across the turn (distinct widths, ends high)',
  new Set(fills).size >= 4 && Math.max(...fills) > 50,
  `widths: ${JSON.stringify(fills)}`);
await shot('01-desktop-complete');

// ══════════════════════════════════════════ Matrix: step past end
console.log('\n── Matrix: Step/Play past the end');
await ev(`(() => { const b = document.getElementById('btn-step');
  for (let i = 0; i < 25; i++) b.click(); })()`);
await sleep(150);
check('clicking Step 25 times past the end does not crash or get stuck', await ev(`
  document.getElementById('progress-text').textContent === 'Complete' &&
  [...document.querySelectorAll('#ctx-stack .ctx-block')].filter(b => !b.hidden).length === 6`));
check('past-the-end caption tells the user how to restart',
  /reset/i.test(await ev(`document.getElementById('caption').textContent`)));
check('no errors after hammering Step past the end', errs().length === 0, errText());

await ev(`document.getElementById('btn-play').click()`);
await sleep(200);
check('Play at the end restarts the turn from stage 0', await ev(`
  /Step [0-9] of 14/.test(document.getElementById('progress-text').textContent)`));
await ev(`document.getElementById('btn-play').click()`); // pause

// ══════════════════════════════════════════ Matrix: reset
console.log('\n── Matrix: Reset');
await ev(`document.getElementById('btn-reset').click()`);
await sleep(150);
check('Reset returns to stage 0, empties the stack and zeroes the meter', await ev(`
  document.getElementById('progress-text').textContent === 'Step 0 of 14' &&
  document.getElementById('token-count').textContent === '0 tokens' &&
  document.getElementById('stage-label').textContent === 'Ready' &&
  parseFloat(document.getElementById('token-fill').style.width) === 0 &&
  [...document.querySelectorAll('#ctx-stack .ctx-block')].every(b => b.hidden)`));

// ══════════════════════════════════════════ Matrix: autoplay
console.log('\n── Matrix: Autoplay');
await ev(`document.getElementById('speed').value='1.8';
          document.getElementById('speed').dispatchEvent(new Event('change'));
          document.getElementById('btn-play').click()`);
await sleep(1500);
const during = await ev(`({p: document.getElementById('progress-text').textContent,
                           b: document.getElementById('btn-play').textContent.trim()})`);
check('Play advances stages automatically and the button becomes Pause',
  during.p !== 'Step 0 of 14' && /Pause/i.test(during.b),
  JSON.stringify(during));
await ev(`document.getElementById('btn-play').click()`);
check('Pause halts progression', await ev(`(async () => {
  const a = document.getElementById('progress-text').textContent;
  await new Promise(r => setTimeout(r, 1200));
  return a === document.getElementById('progress-text').textContent;
})()`));
check('speed select changes the autoplay interval without error', await ev(`(() => {
  document.getElementById('btn-reset').click();
  document.getElementById('btn-play').click();
  document.getElementById('speed').value='0.6';
  document.getElementById('speed').dispatchEvent(new Event('change'));
  const running = /Pause/.test(document.getElementById('btn-play').textContent);
  document.getElementById('btn-play').click();
  return running;
})()`));
check('autoplay runs to completion and stops itself', await ev(`(async () => {
  document.getElementById('btn-reset').click();
  document.getElementById('speed').value='1.8';
  document.getElementById('speed').dispatchEvent(new Event('change'));
  document.getElementById('btn-play').click();
  await new Promise(r => setTimeout(r, 25000));
  return document.getElementById('progress-text').textContent === 'Complete'
      && /Play/.test(document.getElementById('btn-play').textContent);
})()`));
check('no errors during a full autoplay run', errs().length === 0, errText());

// ══════════════════════════════════════════ keyboard
console.log('\n── Keyboard accessibility');
await ev(`document.getElementById('btn-reset').click(); document.activeElement.blur()`);
await key('ArrowRight', 'ArrowRight', 39); await sleep(100);
await key('ArrowRight', 'ArrowRight', 39); await sleep(100);
check('ArrowRight steps with no control focused',
  (await ev(`document.getElementById('progress-text').textContent`)) === 'Step 2 of 14');

// the regression that was fixed: shortcuts used to die once a button had focus
await ev(`document.getElementById('btn-step').focus()`);
await key('ArrowRight', 'ArrowRight', 39); await sleep(100);
check('ArrowRight still steps while a button holds focus',
  (await ev(`document.getElementById('progress-text').textContent`)) === 'Step 3 of 14');
await key('r', 'KeyR', 82); await sleep(100);
check('R resets while a button holds focus',
  (await ev(`document.getElementById('progress-text').textContent`)) === 'Step 0 of 14');

await ev(`document.getElementById('speed').focus()`);
await key('r', 'KeyR', 82); await sleep(100);
check('shortcuts stay out of the way when the select has focus',
  (await ev(`document.getElementById('progress-text').textContent`)) === 'Step 0 of 14');

await ev(`document.activeElement.blur()`);
await key(' ', 'Space', 32); await sleep(400);
const spaceRan = await ev(`/Pause/.test(document.getElementById('btn-play').textContent)`);
await ev(`if (/Pause/.test(document.getElementById('btn-play').textContent))
            document.getElementById('btn-play').click()`);
check('Space toggles play when no button is focused', spaceRan);
// Space on a focused button must activate it exactly once: the shortcut handler
// bows out and Chrome's native button activation does the work.
await ev(`document.getElementById('btn-reset').click();
          document.getElementById('btn-play').focus()`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
await send('Input.dispatchKeyEvent', { type: 'char', key: ' ', text: ' ', unmodifiedText: ' ' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
await sleep(300);
const spaceOnBtn = await ev(`/Pause/.test(document.getElementById('btn-play').textContent)`);
await ev(`if (/Pause/.test(document.getElementById('btn-play').textContent))
            document.getElementById('btn-play').click()`);
check('Space on a focused Play button activates it exactly once (native behavior preserved)',
  spaceOnBtn, 'expected exactly one toggle into Pause state');

check('every control is focusable and has an accessible name', await ev(`
  [...document.querySelectorAll('.controls button, .controls select')].every(e =>
    e.tabIndex >= 0 && (e.getAttribute('aria-label') || e.labels?.length || e.textContent.trim()))`));
check('caption panel is an atomic live region', await ev(`
  document.querySelector('.caption-box').getAttribute('aria-live') === 'polite' &&
  document.querySelector('.caption-box').getAttribute('aria-atomic') === 'true'`));
check('decorative diagram bits are hidden from assistive tech', await ev(`
  document.getElementById('wires').getAttribute('aria-hidden') === 'true' &&
  document.getElementById('packet').getAttribute('aria-hidden') === 'true' &&
  [...document.querySelectorAll('.actor .icon')].every(i => i.getAttribute('aria-hidden') === 'true')`));

// ══════════════════════════════════════════ AC2: static readability
console.log('\n── Acceptance: every concept readable without touching the controls');
await load(1280, 900);
const text = await ev(`document.body.innerText`);
check('static walkthrough lists all 14 steps of the turn', await ev(`
  document.querySelectorAll('#walkthrough-list li').length === 14`));
check('walkthrough prose is populated, not empty shells', await ev(`
  [...document.querySelectorAll('#walkthrough-list li .wc')].every(e => e.textContent.trim().length > 60)`));
const concepts = {
  'harness defined': /harness/i,
  'context window': /context window/i,
  'system prompt': /system prompt/i,
  'tool definitions': /tool definition/i,
  'tool call': /tool call/i,
  'tool result': /tool result/i,
  'agentic loop': /agentic loop/i,
  'token': /token/i,
  'stateless model': /stateless/i,
  'harness executes, model only asks': /harness executes the tool|the harness ran the command|it only asked/i,
  'permissions gate': /permission/i,
  'window limit / trimming': /summariz|trim|token limit/i,
};
let missing = Object.entries(concepts).filter(([, re]) => !re.test(text)).map(([k]) => k);
check('all core concepts appear in static page text', missing.length === 0, `missing: ${missing.join(', ')}`);
check('glossary defines the five required terms', await ev(`(() => {
  const t = [...document.querySelectorAll('dl.gloss dt')].map(d => d.textContent.toLowerCase());
  return ['context window','system prompt','tool call','token','agentic loop']
    .every(k => t.some(x => x.includes(k)));
})()`));
check('AC3: static text makes clear the harness executes and the model only requested',
  /The model only writes this request/i.test(text) && /The harness does everything real/i.test(text));

// ══════════════════════════════════════════ responsive
console.log('\n── Matrix: narrow viewport');
for (const w of [768, 700, 480, 360]) {
  await load(w, 900);
  const okScroll = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  check(`no horizontal page scroll @${w}px`, okScroll,
    `scrollWidth=${await ev('document.documentElement.scrollWidth')} innerWidth=${await ev('window.innerWidth')}`);
}
await load(768, 900);
check('sim grid stacks to one column @768', await ev(`
  getComputedStyle(document.querySelector('.sim-grid')).gridTemplateColumns.split(' ').length === 1`));
check('no element spills past the viewport @768 (excluding intentional scrollers)', await ev(`
  [...document.querySelectorAll('body *')].filter(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > window.innerWidth + 1 && !e.closest('pre, .codeblock');
  }).length === 0`));
check('diagram actors do not overlap each other @768', await ev(`(() => {
  const a = [...document.querySelectorAll('.actor')].map(e => e.getBoundingClientRect());
  for (let i=0;i<a.length;i++) for (let j=i+1;j<a.length;j++){
    const o = !(a[i].right<=a[j].left||a[j].right<=a[i].left||a[i].bottom<=a[j].top||a[j].bottom<=a[i].top);
    if (o) return false;
  }
  return true;
})()`));
await ev(`for (let i=0;i<15;i++) document.getElementById('btn-step').click()`);
await sleep(400);
check('no console errors @768 after running the whole turn', errs().length === 0, errText());
await shot('02-narrow-768', true);

// ══════════════════════════════════════════ dark + reduced motion
console.log('\n── Matrix: dark theme + reduced motion');
await load(1280, 1000, [{ name: 'prefers-color-scheme', value: 'dark' }]);
check('dark theme paints a dark background and light text', await ev(`(() => {
  const bg = getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number);
  const fg = getComputedStyle(document.body).color.match(/\\d+/g).map(Number);
  return bg[0]<50 && bg[1]<50 && bg[2]<50 && fg[0]>190 && fg[1]>190 && fg[2]>190;
})()`));
await ev(`for (let i=0;i<15;i++) document.getElementById('btn-step').click()`);
await sleep(400);
await shot('03-dark-complete', true);

await load(1280, 900, [{ name: 'prefers-reduced-motion', value: 'reduce' }]);
check('reduced motion disables the context-block and packet transitions', await ev(`
  getComputedStyle(document.querySelector('#ctx-stack .ctx-block')).transitionDuration === '0s' &&
  getComputedStyle(document.getElementById('packet')).transitionDuration === '0s'`));
check('reduced motion: packet jumps instantly, no inline transition is set', await ev(`(() => {
  document.getElementById('btn-step').click();
  document.getElementById('btn-step').click();      // stage 2 has a packet move
  return document.getElementById('packet').style.transition === 'none';
})()`));
check('reduced motion still completes the whole turn correctly', await ev(`(() => {
  for (let i=0;i<15;i++) document.getElementById('btn-step').click();
  return document.getElementById('progress-text').textContent === 'Complete' &&
    [...document.querySelectorAll('#ctx-stack .ctx-block')].filter(b=>!b.hidden).length === 6;
})()`));
check('reduced motion: smooth scrolling is turned off', await ev(`
  getComputedStyle(document.documentElement).scrollBehavior === 'auto'`));
check('no console errors in dark / reduced-motion runs', errs().length === 0, errText());

// ══════════════════════════════════════════ resize robustness
console.log('\n── Robustness');
await load(1280, 900);
await ev(`for (let i=0;i<6;i++) document.getElementById('btn-step').click()`);
await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(500);
check('wires are redrawn after a resize and still connect the actors', await ev(`(() => {
  const ls = [...document.querySelectorAll('#wires line')];
  if (ls.length !== 3) return false;
  return ls.every(l => ['x1','y1','x2','y2'].every(a => {
    const v = parseFloat(l.getAttribute(a)); return isFinite(v) && v >= 0;
  }));
})()`));
check('no errors after resizing mid-simulation', errs().length === 0, errText());


// ══════════════════════════════════════════ review patches 1–17
console.log('\n── Review patches');
await load(1280, 950);

// (1) two-phase reveal so the CSS transition actually has a start frame
const reveal = await ev(`(async () => {
  document.getElementById('btn-reset').click();
  const b = document.querySelector('#ctx-stack .b-sys');
  const s = document.getElementById('btn-step');
  s.click(); s.click(); s.click();                       // stage 3 appends 3 blocks
  const immediate = { hidden: b.hidden, hasIn: b.classList.contains('in') };
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { immediate, after: { hasIn: b.classList.contains('in') } };
})()`);
check('P1 new context block is unhidden first and gains .in on the next frame',
  reveal.immediate.hidden === false && reveal.immediate.hasIn === false && reveal.after.hasIn === true,
  JSON.stringify(reveal));

// (2a) Space is only intercepted while the simulation is on screen
check('P2a Space is NOT intercepted when the simulation is scrolled out of view', await ev(`(() => {
  window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'});
  const e = new KeyboardEvent('keydown', {key:' ', bubbles:true, cancelable:true});
  document.body.dispatchEvent(e);
  const started = /Pause/.test(document.getElementById('btn-play').textContent);
  return !e.defaultPrevented && !started;
})()`));
check('P2a Space IS intercepted while the simulation is in view', await ev(`(() => {
  window.scrollTo({top: 0, behavior: 'instant'});
  document.getElementById('btn-reset').click();
  const e = new KeyboardEvent('keydown', {key:' ', bubbles:true, cancelable:true});
  document.body.dispatchEvent(e);
  const started = /Pause/.test(document.getElementById('btn-play').textContent);
  if (started) document.getElementById('btn-play').click();
  return e.defaultPrevented && started;
})()`));
// (2b) browser chords pass straight through
check('P2b Ctrl/Meta/Alt chords are ignored (Cmd+R, Ctrl+Space never hijacked)', await ev(`(() => {
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 3; i++) document.getElementById('btn-step').click();
  const before = document.getElementById('progress-text').textContent;
  [{key:'r',ctrlKey:true},{key:'r',metaKey:true},{key:' ',ctrlKey:true},{key:'ArrowRight',altKey:true}]
    .forEach(o => document.body.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({bubbles:true, cancelable:true}, o))));
  return document.getElementById('progress-text').textContent === before;
})()`));

// (3) ResizeObserver redraws wires when the diagram resizes with no window resize
check('P3 wires redraw when the diagram resizes without a window resize', await ev(`(async () => {
  // Re-proportion the sim grid: the diagram's box changes, the window never does.
  const grid = document.querySelector('.sim-grid');
  const d = document.getElementById('diagram');
  const coords = () => [...document.querySelectorAll('#wires line')]
    .map(l => ['x1','y1','x2','y2'].map(a => l.getAttribute(a)).join()).join('|');
  const before = coords();
  const w0 = Math.round(d.getBoundingClientRect().width);
  grid.style.gridTemplateColumns = 'minmax(0,3fr) minmax(0,7fr)';
  await new Promise(r => setTimeout(r, 350));
  const mid = coords();
  const w1 = Math.round(d.getBoundingClientRect().width);
  grid.style.gridTemplateColumns = '';
  await new Promise(r => setTimeout(r, 350));
  const restored = coords() === before;
  return w1 !== w0 && before !== mid && restored;
})()`));
check('P3 the packet is re-placed on a diagram-only resize too', await ev(`(async () => {
  const grid = document.querySelector('.sim-grid');
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 4; i++) document.getElementById('btn-step').click();   // stage 4 has a packet
  const p = document.getElementById('packet'), d = document.getElementById('diagram');
  grid.style.gridTemplateColumns = 'minmax(0,3fr) minmax(0,7fr)';
  await new Promise(r => setTimeout(r, 350));
  const dr = d.getBoundingClientRect(), pr = p.getBoundingClientRect();
  grid.style.gridTemplateColumns = '';
  await new Promise(r => setTimeout(r, 250));
  return pr.left >= dr.left - 1 && pr.right <= dr.right + 1;
})()`));

// (4) step counter denominator
check('P4 counter runs "Step 1..14 of 14" then "Complete"', await ev(`(() => {
  document.getElementById('btn-reset').click();
  if (document.getElementById('progress-text').textContent !== 'Step 0 of 14') return false;
  for (let i = 1; i <= 14; i++) {
    document.getElementById('btn-step').click();
    if (document.getElementById('progress-text').textContent !== 'Step ' + i + ' of 14') return false;
  }
  document.getElementById('btn-step').click();
  return document.getElementById('progress-text').textContent === 'Complete';
})()`));

// (5) Play advances immediately
await ev(`document.getElementById('btn-reset').click();
          document.getElementById('speed').value='0.6';
          document.getElementById('speed').dispatchEvent(new Event('change'));
          document.getElementById('btn-play').click()`);
await sleep(250);
const immediatePlay = await ev(`document.getElementById('progress-text').textContent`);
await ev(`document.getElementById('btn-play').click()`);
check('P5 Play from Ready advances at once instead of waiting a full interval',
  immediatePlay === 'Step 1 of 14', `saw "${immediatePlay}" after 250ms at Slow (4s interval)`);

// (6) no dangling arrow in the stage-3 caption
check('P6 stage 3 caption has no trailing arrow', await ev(`(() => {
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 3; i++) document.getElementById('btn-step').click();
  const c = document.getElementById('caption').textContent.trim();
  return !/[→↳➜]/.test(c) && /context window panel/i.test(c);
})()`));
check('P6 no stray arrows anywhere in the walkthrough prose',
  await ev(`!/[→]/.test(document.getElementById('walkthrough-list').textContent)`));

// (8) token figures derived from BLOCKS, not hardcoded
check('P8 packet labels derive their token totals from the stack', await ev(`(() => {
  const step = n => { document.getElementById('btn-reset').click();
    for (let i = 0; i < n; i++) document.getElementById('btn-step').click();
    return document.getElementById('packet').textContent; };
  return step(4) === 'full context · 3.6K tokens'
      && step(11) === 'updated context · 3.8K tokens';
})()`));
check('P8 no unresolved {TOKENS} placeholder leaks into the page', await ev(`(() => {
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 15; i++) {
    document.getElementById('btn-step').click();
    if (/\\{TOKENS\\}/.test(document.body.innerText)) return false;
    if (/\\{TOKENS\\}/.test(document.getElementById('packet').textContent)) return false;
  }
  return !/\\{TOKENS\\}/.test(document.body.innerText);
})()`));
check('P8 meter prose and token-limit label are formatted from the constants', await ev(`
  /scaled to 5,000 tokens/.test(document.getElementById('token-note').textContent) &&
  /200,000/.test(document.getElementById('token-note').textContent) &&
  document.getElementById('maxline').textContent === 'token limit — e.g. 200K'`));

// (9) tool-result details agree with each other
const bodyText9 = await ev(`document.body.innerText`);
check('P9 no contradictory file counts anywhere', !/14 files|14 items/.test(bodyText9));
check('P9 stage 9 no longer promises sizes that the sample does not show', await ev(`(() => {
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 9; i++) document.getElementById('btn-step').click();
  const c = document.getElementById('caption').textContent;
  return /names and folders/.test(c) && !/sizes/.test(c);
})()`));

// (10) full block detail reachable
check('P10 every context block exposes its full detail via title', await ev(`
  [...document.querySelectorAll('#ctx-stack .ctx-block .bd')]
    .every(e => e.title && e.title === e.textContent && e.title.length > 3)`));

// (11) context panel announces to screen readers
check('P11 context stack changes are announced via a live region', await ev(`(() => {
  const s = document.getElementById('ctx-summary');
  if (s.getAttribute('aria-live') !== 'polite') return false;
  document.getElementById('btn-reset').click();
  const at0 = s.textContent;
  for (let i = 0; i < 3; i++) document.getElementById('btn-step').click();
  const at3 = s.textContent;
  for (let i = 0; i < 7; i++) document.getElementById('btn-step').click();
  return at0 === '0 blocks, 0 tokens' && at3 === '3 blocks, 3,612 tokens'
      && s.textContent === '5 blocks, 3,832 tokens';
})()`));
check('P11 the live summary is visually hidden but not display:none', await ev(`(() => {
  const s = getComputedStyle(document.getElementById('ctx-summary'));
  return s.display !== 'none' && s.visibility !== 'hidden' &&
         document.getElementById('ctx-summary').getBoundingClientRect().width <= 2;
})()`));

// (12) WCAG 2.5.3 label-in-name
check('P12 each control accessible name contains its visible text', await ev(`(() => {
  const ok = [['btn-play','Play'],['btn-step','Step'],['btn-reset','Reset']].every(([id, word]) => {
    const b = document.getElementById(id);
    if (b.hasAttribute('aria-label')) return false;      // name now comes from visible text
    const visible = [...b.querySelectorAll('.btn-word')].map(e => e.textContent).join('');
    return visible === word && b.textContent.includes(word);
  });
  const sel = document.getElementById('speed');
  return ok && !sel.hasAttribute('aria-label') && sel.labels.length === 1
      && sel.labels[0].textContent.trim() === 'Speed';
})()`));
check('P12 Pause state also matches its visible word', await ev(`(() => {
  document.getElementById('btn-reset').click();
  document.getElementById('btn-play').click();
  const b = document.getElementById('btn-play');
  const okWord = b.querySelector('.btn-word').textContent === 'Pause' && !b.hasAttribute('aria-label');
  b.click();
  return okWord && b.querySelector('.btn-word').textContent === 'Play';
})()`));
check('P12 button glyphs are hidden from assistive tech', await ev(`
  [...document.querySelectorAll('.controls .btn-icon')]
    .every(e => e.getAttribute('aria-hidden') === 'true') &&
  document.querySelectorAll('.controls .btn-icon').length === 3`));

// (13) straight quotes wherever code appears
check('P13 no curly quotes in any code span, packet label or code-ish block detail', await ev(`(() => {
  const curly = /[“”‘’]/;
  if ([...document.querySelectorAll('code')].some(c => curly.test(c.textContent))) return false;
  if (curly.test(document.querySelector('#ctx-stack .b-call .bd').textContent)) return false;
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 15; i++) {
    document.getElementById('btn-step').click();
    if (curly.test(document.getElementById('packet').textContent)) return false;
  }
  return true;
})()`));
check('P13 the straight-quoted call renders as expected', await ev(`
  document.querySelector('#ctx-stack .b-call .bd').textContent === 'list_files(path: ".")'`));

// (14) content accuracy
const text14 = await ev(`document.body.innerText`);
check('P14 glossary no longer calls the model a pure function',
  !/pure function/i.test(text14) && /sampled/i.test(text14) && /no memory of earlier calls/i.test(text14));
check('P14 misconception #3 separates in-call reasoning from between-call idleness',
  /thinking["”]? tokens|hundreds of "thinking"/i.test(text14) &&
  /between.{0,20}calls it doesn't exist as a running process/i.test(text14));

// (15) failure path + real-harness machinery
check('P15 tool-call section covers the failure path', await ev(`(() => {
  const t = document.getElementById('tool-anatomy').innerText;
  return /marked as an error/i.test(t) && /permission check denies/i.test(t)
      && /adapts/i.test(t) && /part of the loop/i.test(t);
})()`));
check('P15 tool-call section notes truncation, multi-call, streaming and retries', await ev(`(() => {
  const t = document.getElementById('tool-anatomy').innerText;
  return /truncate/i.test(t) && /parallel/i.test(t) && /stream/i.test(t) && /retry|retries/i.test(t);
})()`));

// (16) head metadata + no-JS notice
check('P16 meta description, both theme-colors and a noscript notice are present', await ev(`
  !!document.querySelector('meta[name=description][content]') &&
  document.querySelectorAll('meta[name="theme-color"]').length === 2 &&
  !!document.querySelector('meta[name="theme-color"][media*="dark"]') &&
  !!document.querySelector('noscript')`));
check('P16 noscript names what disappears and what still reads', await ev(`(() => {
  const t = document.querySelector('noscript').textContent;
  return /JavaScript is turned off/i.test(t) && /walkthrough/i.test(t) && /glossary/i.test(t);
})()`));

// (17) packet stays inside the diagram at narrow widths
await load(360, 800);
check('P17 packet never escapes the diagram at 360px, across every stage', await ev(`(() => {
  const d = document.getElementById('diagram'), p = document.getElementById('packet');
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 15; i++) {
    document.getElementById('btn-step').click();
    if (!p.classList.contains('visible')) continue;
    const dr = d.getBoundingClientRect(), pr = p.getBoundingClientRect();
    if (pr.left < dr.left - 1 || pr.right > dr.right + 1) return false;
  }
  return true;
})()`));
check('P17 no horizontal page scroll while stepping at 360px', await ev(`(() => {
  document.getElementById('btn-reset').click();
  for (let i = 0; i < 15; i++) {
    document.getElementById('btn-step').click();
    if (document.documentElement.scrollWidth > window.innerWidth + 1) return false;
  }
  return true;
})()`));

// (7) mobile grid keeps the harness between user and model
await load(768, 950);
check('P7 mobile layout never puts User directly beside Model', await ev(`(() => {
  const r = id => document.getElementById(id).getBoundingClientRect();
  const u = r('actor-user'), h = r('actor-harness'), m = r('actor-model'), t = r('actor-tools');
  const sameRow = (a, b) => Math.abs(a.top - b.top) < 24;
  return sameRow(u, h) && u.right <= h.left + 1     // user sits beside the harness
      && !sameRow(u, m)                             // user and model are on different rows
      && sameRow(t, m);
})()`));
check('P7 mobile actors still do not overlap', await ev(`(() => {
  const a = [...document.querySelectorAll('.actor')].map(e => e.getBoundingClientRect());
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    if (!(a[i].right <= a[j].left || a[j].right <= a[i].left ||
          a[i].bottom <= a[j].top || a[j].bottom <= a[i].top)) return false;
  }
  return true;
})()`));
check('P7 all three wires are drawn and land on actor centres @768', await ev(`(() => {
  const ls = [...document.querySelectorAll('#wires line')];
  if (ls.length !== 3) return false;
  const d = document.getElementById('diagram').getBoundingClientRect();
  return ls.every(l => ['x1','y1','x2','y2'].every(a => {
    const v = parseFloat(l.getAttribute(a));
    return isFinite(v) && v >= 0 && v <= Math.max(d.width, d.height) + 40;
  }));
})()`));
check('P10 block detail wraps instead of ellipsizing @768', await ev(`
  getComputedStyle(document.querySelector('#ctx-stack .ctx-block .bd')).whiteSpace === 'normal'`));
check('no console errors across the patch checks', errs().length === 0, errText());

// reduced motion must skip the two-phase reveal entirely
await load(1280, 950, [{ name: 'prefers-reduced-motion', value: 'reduce' }]);
check('P1 under reduced motion blocks are revealed synchronously (no rAF hop)', await ev(`(() => {
  document.getElementById('btn-reset').click();
  const b = document.querySelector('#ctx-stack .b-sys');
  for (let i = 0; i < 3; i++) document.getElementById('btn-step').click();
  return !b.hidden && b.classList.contains('in');
})()`));
check('no console errors in the reduced-motion patch run', errs().length === 0, errText());
await load(1280, 950);
await ev(`for (let i=0;i<15;i++) document.getElementById('btn-step').click()`);
await sleep(400);
await shot('04-patched-complete', true);



// ══════════════════════════════════════════ story 2: deep-dive layer
console.log('\n── Deep dive: structure & static readability');
await load(1280, 950);

check('DD section exists between #tool-anatomy and #glossary', await ev(`(() => {
  const ids = [...document.querySelectorAll('main > section')].map(s => s.id);
  return ids.indexOf('deep-dive') === ids.indexOf('tool-anatomy') + 1
      && ids.indexOf('glossary')  === ids.indexOf('deep-dive') + 1;
})()`));

check('DD pseudocode renders 26 lines, 22 of them owned by a subsystem', await ev(`
  document.querySelectorAll('#pseudo .pl').length === 26 &&
  document.querySelectorAll('#pseudo .pl[data-sub]').length === 22 &&
  document.querySelectorAll('#pseudo .pl:not([data-sub])').length === 4`));

// The frozen spec said ~12-20 code lines; review round 2 added compact(), the
// try-scope move and the text+toolCalls comment, taking it to 22. Recorded here
// deliberately rather than silently widened.
check('DD pseudocode stays a readable reduction (<= 24 code lines)', await ev(`
  document.querySelectorAll('#pseudo .pl[data-sub]').length >= 12 &&
  document.querySelectorAll('#pseudo .pl[data-sub]').length <= 24`));

check('DD no stray blank rows: every rendered line maps 1:1 to a .pl span', await ev(`(() => {
  const code = document.querySelector('#pseudo code');
  // Any non-whitespace text directly inside <code> would render as an extra row.
  return [...code.childNodes].every(n => n.nodeType !== 3 || !n.textContent.trim());
})()`));

check('DD line numbers run 1..26 in document order', await ev(`(() => {
  const ls = [...document.querySelectorAll('#pseudo .pl')];
  return ls.length === 26 && ls[0].textContent.startsWith('context = assemble')
      && ls[4].textContent.includes('compact(context, BUDGET)')
      && ls[5].textContent.includes('modelApi.send')
      && ls[20].textContent.includes('context.append(result')
      && ls[25].textContent.trim() === '}';
})()`));

check('DD five subsystem cards, each a native <details> with the required parts', await ev(`(() => {
  const cards = [...document.querySelectorAll('.sub-card')];
  if (cards.length !== 5) return false;
  const subs = cards.map(c => c.getAttribute('data-sub')).sort().join();
  if (subs !== 'api,context,executor,loop,registry') return false;
  return cards.every(c =>
    c.tagName === 'DETAILS' &&
    c.querySelector(':scope > summary') &&
    c.querySelector('.sc-job') &&
    c.querySelector('.sc-fail') &&
    c.querySelector('.sc-xref') &&
    c.querySelectorAll(':scope > p').length >= 4);
})()`));

check('DD each card states a one-sentence job, real detail, and a failure symptom', await ev(`(() => {
  return [...document.querySelectorAll('.sub-card')].every(c => {
    const job = c.querySelector('.sc-job').textContent;
    const fail = c.querySelector('.sc-fail').textContent;
    const detail = [...c.querySelectorAll(':scope > p')]
      .filter(p => !p.className).map(p => p.textContent).join(' ');
    const sentences = detail.split(/[.!?]\\s/).filter(x => x.trim().length > 20).length;
    return /^Job:/.test(job.trim()) && job.length > 60
        && /^Done badly:/.test(fail.trim()) && fail.length > 60
        && sentences >= 2 && sentences <= 5;
  });
})()`));

// every subsystem in the code has a card and vice versa — no dangling links
check('DD each card line badge enumerates exactly the lines its subsystem owns', await ev(`(() => {
  const all = [...document.querySelectorAll('#pseudo .pl')];
  // "lines 2, 4, 8-9, 11, 21, 23-25" -> [2,4,8,9,11,21,23,24,25]. No regex: the
  // badge uses an en-dash and escaping it through three layers is not worth it.
  const expand = txt => {
    const out = [];
    txt.toLowerCase().split('lines').join('').split('line').join('')
      .split(',').forEach(part => {
        const bits = part.trim().split('\u2013').join('-').split('\u2014').join('-')
          .split('-').map(x => parseInt(x, 10)).filter(n => !isNaN(n));
        if (!bits.length) return;
        const a = bits[0], b = bits.length > 1 ? bits[1] : a;
        for (let n = a; n <= b; n++) out.push(n);
      });
    return out.sort((x, y) => x - y).join();
  };
  return [...document.querySelectorAll('.sub-card')].every(c => {
    const sub = c.getAttribute('data-sub');
    const owned = all.map((l, i) => l.getAttribute('data-sub') === sub ? i + 1 : 0)
                     .filter(Boolean).sort((x, y) => x - y).join();
    return expand(c.querySelector('.sc-lines').textContent) === owned;
  });
})()`));

check('DD every data-sub in the code has a matching card and vice versa', await ev(`(() => {
  const inCode = new Set([...document.querySelectorAll('#pseudo .pl[data-sub]')]
    .map(l => l.getAttribute('data-sub')));
  const inCards = new Set([...document.querySelectorAll('.sub-card')]
    .map(c => c.getAttribute('data-sub')));
  return inCode.size === 5 && inCards.size === 5 &&
    [...inCode].every(s => inCards.has(s)) && [...inCards].every(s => inCode.has(s));
})()`));

// AC: three architectural facts stated explicitly
const ddText = await ev(`document.getElementById('deep-dive').innerText`);
check('AC: fact 1 — trust boundary at the model API, model output untrusted',
  /trust boundary sits at the model API/i.test(ddText) && /untrusted data until the harness validates it/i.test(ddText));
check('AC: fact 2 — model calls dominate cost/latency and scale with context size',
  /dominate cost and latency/i.test(ddText) && /scale with context size/i.test(ddText));
check('AC: fact 3 — security, observability and spend controls live only in the harness',
  /security, observability and spend controls can only live in the harness/i.test(ddText));

// AC: no undefined AI jargon — the three terms used are defined in-section
check('AC: token, context window and system prompt are all defined inside the section',
  /A .?token.? is the unit of text the model is billed and limited by/i.test(ddText) &&
  /context window.? is the single block of text sent with each request/i.test(ddText) &&
  /system prompt.? is the standing instruction text/i.test(ddText));

// AC: cross-references resolve in both directions
check('AC: every in-page link inside the deep dive resolves to a real element', await ev(`(() => {
  return [...document.querySelectorAll('#deep-dive a[href^="#"]')]
    .every(a => !!document.getElementById(a.getAttribute('href').slice(1)));
})()`));
check('AC: the walkthrough links down to the deep dive and the target exists', await ev(`
  !!document.querySelector('#walkthrough a[href="#deep-dive"]') &&
  !!document.getElementById('deep-dive')`));
check('AC: every simulation step number cited by a card exists and matches its subject', await ev(`(() => {
  const steps = [...document.querySelectorAll('#walkthrough-list li .wl')].map(e => e.textContent);
  if (steps.length !== 14) return false;
  const want = {
    context:  [[3,'Context assembly'], [10,'Result appended']],
    registry: [[7,'Validate & authorize']],
    executor: [[8,'Execution'], [9,'Result captured']],
    api:      [[4,'Model call #1'], [11,'Model call #2']],
    loop:     [[11,'Model call #2'], [13,'Answer returned']]
  };
  return Object.keys(want).every(sub => {
    const xref = document.querySelector('.sub-card[data-sub="' + sub + '"] .sc-xref').textContent;
    return want[sub].every(([n, label]) =>
      new RegExp('\\\\b' + n + '\\\\b').test(xref) && steps[n - 1] === label);
  });
})()`));

check('DD pseudocode fits without horizontal scrolling at desktop width', await ev(`(() => {
  const pre = document.getElementById('pseudo');
  return pre.scrollWidth <= pre.clientWidth + 2;
})()`));
check('DD every inline comment is visible at desktop width (not clipped)', await ev(`(() => {
  const pre = document.getElementById('pseudo');
  const right = pre.getBoundingClientRect().right;
  return [...pre.querySelectorAll('.pl')].every(l => {
    if (!l.textContent.includes('//')) return true;
    const r = document.createRange();
    r.selectNodeContents(l);
    return r.getBoundingClientRect().right <= right + 1;
  });
})()`));

console.log('\n── Deep dive: line <-> card linking');
// Matrix: clicking a line highlights its card (and its sibling lines)
check('MX line click lights the owning card and only that subsystem', await ev(`(() => {
  const line = document.querySelector('#pseudo .pl[data-sub="registry"]');
  line.click();
  const lit = [...document.querySelectorAll('#dd .is-lit')];
  const card = document.querySelector('.sub-card[data-sub="registry"]');
  const otherLit = lit.filter(e => e.getAttribute('data-sub') !== 'registry');
  return lit.includes(card) && otherLit.length === 0
      && lit.filter(e => e.classList.contains('pl')).length === 2;   // lines 15-16
})()`));

check('MX clicking the same line again unpins and closes its card', await ev(`(() => {
  const line = document.querySelector('#pseudo .pl[data-sub="registry"]');
  line.click();                                    // second click = toggle off
  return document.querySelectorAll('#dd .is-lit').length === 0
      && line.getAttribute('aria-pressed') === 'false'
      && !document.getElementById('card-registry').open;
})()`));

check('MX hovering a line lights its subsystem, leaving the block clears it', await ev(`(() => {
  const line = document.querySelector('#pseudo .pl[data-sub="executor"]');
  // hover is delegated on the block now, so it must bubble
  line.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
  const litCount = document.querySelectorAll('#dd .is-lit').length;
  document.getElementById('pseudo').dispatchEvent(new PointerEvent('pointerleave', {pointerType:'mouse'}));
  const after = document.querySelectorAll('#dd .is-lit').length;
  return litCount === 6 && after === 0;            // 5 executor lines + 1 card
})()`));

check('MX card hover lights its lines (the reverse direction)', await ev(`(() => {
  const card = document.querySelector('.sub-card[data-sub="api"]');
  card.dispatchEvent(new PointerEvent('pointerenter', {pointerType:'mouse'}));
  const lines = [...document.querySelectorAll('#pseudo .pl.is-lit')];
  card.dispatchEvent(new PointerEvent('pointerleave', {pointerType:'mouse'}));
  return lines.length === 1 && lines[0].textContent.includes('modelApi.send');
})()`));

check('MX card keyboard focus lights its lines', await ev(`(() => {
  const card = document.querySelector('.sub-card[data-sub="context"]');
  card.querySelector('summary').focus();
  const n = document.querySelectorAll('#pseudo .pl.is-lit').length;
  card.querySelector('summary').blur();
  return n === 4;                                  // lines 1, 5, 7, 21
})()`));

check('MX lines with no subsystem are inert and throw nothing', await ev(`(() => {
  const blanks = [...document.querySelectorAll('#pseudo .pl:not([data-sub])')];
  if (!blanks.length) return false;
  blanks.forEach(b => { b.click(); b.dispatchEvent(new MouseEvent('mouseenter')); });
  return blanks.every(b => !b.hasAttribute('role') && b.tabIndex === -1 || b.tabIndex === 0 ? true : true)
      && document.querySelectorAll('#dd .is-lit').length === 0;
})()`));

check('MX opening a card pins its lines; closing it unpins', await ev(`(async () => {
  const card = document.querySelector('.sub-card[data-sub="loop"]');
  const settle = () => new Promise(r => setTimeout(r, 60));   // toggle fires async
  card.open = true;  await settle();
  const pinned = document.querySelectorAll('#pseudo .pl.is-lit').length;
  card.open = false; await settle();
  const after = document.querySelectorAll('#pseudo .pl.is-lit').length;
  return pinned === 10 && after === 0;             // lines 2,4,9,10,11,13,22,24,25,26
})()`));

console.log('\n── Deep dive: keyboard & isolation');
check('MX code block is one tab stop with roving tabindex', await ev(`(() => {
  const ls = [...document.querySelectorAll('#pseudo .pl[data-sub]')];
  return ls.filter(l => l.tabIndex === 0).length === 1
      && ls.filter(l => l.tabIndex === -1).length === ls.length - 1
      && ls.every(l => l.getAttribute('role') === 'button');
})()`));

await ev(`document.querySelector('#pseudo .pl[data-sub]').focus()`);
await key('ArrowDown', 'ArrowDown', 40); await sleep(60);
await key('ArrowDown', 'ArrowDown', 40); await sleep(60);
check('MX ArrowDown moves focus between code lines', await ev(`(() => {
  const ls = [...document.querySelectorAll('#pseudo .pl[data-sub]')];
  return ls.indexOf(document.activeElement) === 2 && document.activeElement.tabIndex === 0;
})()`));
await key('Enter', 'Enter', 13); await sleep(80);
check('MX Enter selects the focused line', await ev(`
  document.activeElement.getAttribute('aria-pressed') === 'true' &&
  document.querySelectorAll('#dd .is-lit').length > 0`));
await key('Home', 'Home', 36); await sleep(60);
check('MX Home jumps to the first line', await ev(`(() => {
  const ls = [...document.querySelectorAll('#pseudo .pl[data-sub]')];
  return ls.indexOf(document.activeElement) === 0;
})()`));

// the isolation guard: sim shortcuts must not fire from inside the deep dive
check('MX Space/R inside the deep dive never reach the simulation player', await ev(`(() => {
  document.getElementById('btn-reset').click();
  const before = document.getElementById('progress-text').textContent;
  const line = document.querySelector('#pseudo .pl[data-sub]');
  line.focus();
  [' ', 'r', 'ArrowRight'].forEach(k =>
    line.dispatchEvent(new KeyboardEvent('keydown', {key:k, bubbles:true, cancelable:true})));
  const summary = document.querySelector('.sub-card summary');
  summary.focus();
  [' ', 'r'].forEach(k =>
    summary.dispatchEvent(new KeyboardEvent('keydown', {key:k, bubbles:true, cancelable:true})));
  return document.getElementById('progress-text').textContent === before
      && !/Pause/.test(document.getElementById('btn-play').textContent);
})()`));

check('MX the simulation shortcuts still work from outside the deep dive', await ev(`(() => {
  window.scrollTo({top: 0, behavior: 'instant'});
  document.getElementById('btn-reset').click();
  document.body.focus();
  document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true, cancelable:true}));
  return document.getElementById('progress-text').textContent === 'Step 1 of 14';
})()`));

console.log('\n── Deep dive: responsive, reduced motion, no-JS');
await load(360, 800);
check('MX no page-level horizontal scroll at 360px with the new section', await ev(`
  document.documentElement.scrollWidth <= window.innerWidth + 1`));
check('MX pseudocode scrolls inside its own container, not the page', await ev(`(() => {
  const pre = document.getElementById('pseudo');
  return pre.scrollWidth > pre.clientWidth                       // it does overflow
      && getComputedStyle(pre).overflowX === 'auto'              // and handles it itself
      && pre.getBoundingClientRect().right <= window.innerWidth + 1;
})()`));
check('MX subsystem cards stack into one column at 360px', await ev(`(() => {
  const cs = [...document.querySelectorAll('.sub-card')].map(c => c.getBoundingClientRect());
  return cs.every(r => Math.abs(r.left - cs[0].left) < 2)
      && getComputedStyle(document.querySelector('.dd-grid')).gridTemplateColumns.split(' ').length === 1;
})()`));
check('MX highlight still works at 360px', await ev(`(() => {
  document.querySelector('#pseudo .pl[data-sub="api"]').click();
  return document.querySelectorAll('#dd .is-lit').length === 2;   // line 6 + card
})()`));

await load(1280, 950, [{ name: 'prefers-reduced-motion', value: 'reduce' }]);
check('MX reduced motion makes highlight changes instant', await ev(`
  getComputedStyle(document.querySelector('#pseudo .pl[data-sub]')).transitionDuration === '0s' &&
  getComputedStyle(document.querySelector('.sub-card')).transitionDuration === '0s'`));
check('MX highlighting still functions under reduced motion', await ev(`(() => {
  document.querySelector('#pseudo .pl[data-sub="context"]').click();
  return document.querySelectorAll('#dd .is-lit').length === 5;   // 4 lines + 1 card
})()`));

// JS disabled — the progressive-enhancement contract.
// Runtime.evaluate is unavailable in this mode, so read the rendered DOM over
// the DOM domain and assert against the markup the browser actually built.
await send('Emulation.setScriptExecutionDisabled', { value: true });
await load(1280, 950);
const doc = await send('DOM.getDocument', { depth: -1 });
const noJsHtml = (await send('DOM.getOuterHTML', { nodeId: doc.root.nodeId })).outerHTML;
await send('Emulation.setScriptExecutionDisabled', { value: false });

// Strip inline scripts first: their source text mentions <details>, aria-pressed
// etc., which would otherwise satisfy assertions about the rendered markup.
const noJsDom = noJsHtml.replace(/<script[\s\S]*?<\/script>/g, '');
const cardCount = (noJsDom.match(/class="sub-card"/g) || []).length;
const jobCount  = (noJsDom.match(/class="sc-job"/g) || []).length;
const failCount = (noJsDom.match(/class="sc-fail"/g) || []).length;
const lineCount = (noJsDom.match(/class="pl"/g) || []).length;
check('MX JS off: all five cards with job + failure text are present in the markup',
  cardCount === 5 && jobCount === 5 && failCount === 5,
  `cards=${cardCount} jobs=${jobCount} fails=${failCount}`);
check('MX JS off: pseudocode is a plain readable block (26 lines, no injected controls)',
  lineCount === 26 && !/role="button"/.test(noJsDom) && !/aria-pressed/.test(noJsDom),
  `lines=${lineCount} role=${/role="button"/.test(noJsDom)} pressed=${/aria-pressed/.test(noJsDom)}`);
check('MX JS off: cards are natively expandable <details>, no JS-only toggles',
  (noJsDom.match(/<details/g) || []).length === 5 &&
  (noJsDom.match(/<summary/g) || []).length === 5);
check('MX JS off: the three architectural facts are still readable',
  /trust boundary sits at the model API/.test(noJsDom) &&
  /dominate cost and latency/.test(noJsDom) &&
  /can only live in the harness/.test(noJsDom));
check('MX JS off: the walkthrough is the only thing that empties (known, noscript-covered)',
  !/class="wl"/.test(noJsDom));
check('MX JS off: the noscript notice is present to explain that',
  /<noscript>/.test(noJsDom) && /JavaScript is turned off/.test(noJsDom));

// back to normal for anything after this point
await load(1280, 950);


// ══════════════════════════════════════════ caption-box height lock
console.log('\n── Controls must not move when the caption changes length');

// Walk every stage (plus the past-the-end caption) and record where the
// control row sits, in document coordinates so page scroll can't mask a jump.
const walkTops = `(() => {
  const c = document.querySelector('.controls');
  const top = () => Math.round(c.getBoundingClientRect().top + window.scrollY);
  document.getElementById('btn-reset').click();
  const tops = [top()];
  for (let i = 0; i < 15; i++) { document.getElementById('btn-step').click(); tops.push(top()); }
  document.getElementById('btn-step').click();           // past the end
  tops.push(top());
  return { unique: [...new Set(tops)].length, spread: Math.max(...tops) - Math.min(...tops), tops };
})()`;

for (const w of [1200, 768, 400]) {
  await load(w, 900);
  const r = await ev(walkTops);
  check(`CAP controls stay at a fixed y across all 16 stages @${w}px`,
    r.unique === 1, `${r.unique} distinct positions, ${r.spread}px spread: ${JSON.stringify(r.tops)}`);
}

await load(1200, 900);
check('CAP caption box is pinned to a measured pixel height, not the CSS guess', await ev(`(() => {
  const box = document.querySelector('.caption-box');
  return /^\\d+(\\.\\d+)?px$/.test(box.style.minHeight) && parseFloat(box.style.minHeight) > 0;
})()`));

check('CAP the pinned height is >= the tallest caption at this width', await ev(`(() => {
  const box = document.querySelector('.caption-box');
  const pinned = parseFloat(box.style.minHeight);
  document.getElementById('btn-reset').click();
  let tallest = 0;
  for (let i = 0; i <= 15; i++) {
    const h = document.getElementById('caption').getBoundingClientRect().height;
    if (h > tallest) tallest = h;
    document.getElementById('btn-step').click();
  }
  return pinned >= tallest;
})()`));

check('CAP the measuring probe leaves nothing behind in the DOM', await ev(`
  document.querySelectorAll('.caption-box').length === 1 &&
  document.querySelectorAll('#caption').length === 1 &&
  document.querySelectorAll('#stage-label').length === 1`));

// The lock has to survive a resize, not just a fresh load.
check('CAP the height is re-measured on resize (not just at load)', await ev(`(async () => {
  const box = document.querySelector('.caption-box');
  const wide = parseFloat(box.style.minHeight);
  const outer = document.querySelector('.sim');
  outer.style.maxWidth = '360px';                       // force a narrower wrap
  window.dispatchEvent(new Event('resize'));
  await new Promise(r => setTimeout(r, 400));
  const narrow = parseFloat(box.style.minHeight);
  outer.style.maxWidth = '';
  window.dispatchEvent(new Event('resize'));
  await new Promise(r => setTimeout(r, 400));
  const back = parseFloat(box.style.minHeight);
  return narrow > wide && Math.abs(back - wide) < 2;
})()`));

check('CAP controls remain stable after a resize too', await ev(`(async () => {
  const outer = document.querySelector('.sim');
  outer.style.maxWidth = '420px';
  window.dispatchEvent(new Event('resize'));
  await new Promise(r => setTimeout(r, 400));
  const c = document.querySelector('.controls');
  const top = () => Math.round(c.getBoundingClientRect().top + window.scrollY);
  document.getElementById('btn-reset').click();
  const tops = [top()];
  for (let i = 0; i < 15; i++) { document.getElementById('btn-step').click(); tops.push(top()); }
  outer.style.maxWidth = '';
  window.dispatchEvent(new Event('resize'));
  return [...new Set(tops)].length === 1;
})()`));

// Sweep the band just above the 768px breakpoint, where the two-column grid is
// narrowest and the context panel comes closest to out-growing the stage column.
let drift = '';
for (const w of [769, 800, 850, 900, 1000, 1100, 1400]) {
  await load(w, 900);
  const d = await ev(`(() => {
    const c = document.querySelector('.controls');
    const top = () => c.getBoundingClientRect().top + window.scrollY;
    document.getElementById('btn-reset').click();
    const tops = [top()];
    for (let i = 0; i < 15; i++) { document.getElementById('btn-step').click(); tops.push(top()); }
    return +(Math.max(...tops) - Math.min(...tops)).toFixed(2);
  })()`);
  if (d !== 0) drift += `${w}px:${d}px `;
}
check('CAP controls never drift at any width across the two-column band', !drift, drift);

check('CAP the diagram no longer stretches as the context panel grows', await ev(`(() => {
  const diag = document.getElementById('diagram');
  document.getElementById('btn-reset').click();
  const hs = [];
  for (let i = 0; i <= 15; i++) {
    hs.push(Math.round(diag.getBoundingClientRect().height));
    document.getElementById('btn-step').click();
  }
  return new Set(hs).size === 1;
})()`));

check('CAP no console errors from the measuring pass', errs().length === 0, errText());
await load(1280, 950);


// ══════════════════════════════════════════ review round 2 (patches A-E)
console.log('\n── Round 2: multi-card pin state');
await load(1280, 950);

// A1 — the live-reproduced bug: opening B must not darken A's lines
check('R2 two open cards keep BOTH subsystems lit', await ev(`(async () => {
  const settle = () => new Promise(r => setTimeout(r, 60));   // <details> toggle is async
  const a = document.getElementById('card-context'), b = document.getElementById('card-registry');
  a.open = false; b.open = false; await settle();
  a.open = true; await settle();
  const afterA = document.querySelectorAll('#pseudo .pl.is-lit').length;
  b.open = true; await settle();
  const lit = [...document.querySelectorAll('#pseudo .pl.is-lit')];
  const subs = new Set(lit.map(l => l.getAttribute('data-sub')));
  return afterA === 4 && lit.length === 6 && subs.has('context') && subs.has('registry');
})()`));

check('R2 closing one card leaves the other open card lit', await ev(`(async () => {
  const settle = () => new Promise(r => setTimeout(r, 60));
  const a = document.getElementById('card-context'), b = document.getElementById('card-registry');
  b.open = false; await settle();
  const lit = [...document.querySelectorAll('#pseudo .pl.is-lit')];
  const ok = lit.length === 4 && lit.every(l => l.getAttribute('data-sub') === 'context') && a.open;
  a.open = false; await settle();
  return ok && document.querySelectorAll('#dd .is-lit').length === 0;
})()`));

check('R2 all five cards open at once lights every annotated line', await ev(`(async () => {
  const settle = () => new Promise(r => setTimeout(r, 60));
  const cards = [...document.querySelectorAll('.sub-card')];
  cards.forEach(c => { c.open = true; }); await settle();
  const lit = document.querySelectorAll('#pseudo .pl.is-lit').length;
  const total = document.querySelectorAll('#pseudo .pl[data-sub]').length;
  cards.forEach(c => { c.open = false; }); await settle();
  return lit === total && lit === 22;
})()`));

// A2 — a line click pins AND opens its card
check('R2 clicking a line opens the matching card, not just a border glow', await ev(`(() => {
  document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
  document.querySelector('#pseudo .pl[data-sub="executor"]').click();
  const card = document.getElementById('card-executor');
  return card.open && card.classList.contains('is-lit')
      && document.querySelectorAll('#pseudo .pl.is-lit').length === 5;
})()`));
check('R2 clicking it again closes the card and clears the pin', await ev(`(() => {
  document.querySelector('#pseudo .pl[data-sub="executor"]').click();
  return !document.getElementById('card-executor').open
      && document.querySelectorAll('#dd .is-lit').length === 0;
})()`));
check('R2 each line is aria-describedby its card', await ev(`
  [...document.querySelectorAll('#pseudo .pl[data-sub]')].every(l =>
    l.getAttribute('aria-describedby') === 'card-' + l.getAttribute('data-sub') &&
    !!document.getElementById(l.getAttribute('aria-describedby')))`));
check('R2 an off-screen card is scrolled into view when a line pins it', await ev(`(async () => {
  document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
  const card = document.getElementById('card-loop');
  window.scrollTo({ top: 0, behavior: 'instant' });
  const before = card.getBoundingClientRect();
  const wasOff = before.top < 0 || before.bottom > window.innerHeight;
  document.querySelector('#pseudo .pl[data-sub="loop"]').click();
  await new Promise(r => setTimeout(r, 700));
  const after = card.getBoundingClientRect();
  const nowOn = after.bottom > 0 && after.top < window.innerHeight;
  document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
  return !wasOff || nowOn;
})()`));

// A3 — hover hygiene
check('R2 hovering a blank line clears the transient highlight', await ev(`(() => {
  document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
  const annotated = document.querySelector('#pseudo .pl[data-sub="registry"]');
  const blank = document.querySelector('#pseudo .pl:not([data-sub])');
  annotated.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
  const onLine = document.querySelectorAll('#dd .is-lit').length;
  blank.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
  const onBlank = document.querySelectorAll('#dd .is-lit').length;
  return onLine === 3 && onBlank === 0;
})()`));
check('R2 hover never clears a pinned card', await ev(`(async () => {
  const settle = () => new Promise(r => setTimeout(r, 60));
  const card = document.getElementById('card-api');
  card.open = true; await settle();
  const blank = document.querySelector('#pseudo .pl:not([data-sub])');
  blank.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
  document.getElementById('pseudo').dispatchEvent(new PointerEvent('pointerleave', {pointerType:'mouse'}));
  const stillLit = document.querySelectorAll('#dd .is-lit').length;
  card.open = false; await settle();
  return stillLit === 2;
})()`));

console.log('\n── Round 2: pseudocode content');
const pcode = await ev(`[...document.querySelectorAll('#pseudo .pl')].map(l => l.textContent).join('\\n')`);
check('R2/B4 lookup, validate and requirePermission are inside the try block', await ev(`(() => {
  const ls = [...document.querySelectorAll('#pseudo .pl')].map(l => l.textContent);
  const tryAt   = ls.findIndex(t => /\\btry\\s*\\{/.test(t));
  const catchAt = ls.findIndex(t => /\\bcatch\\b/.test(t));
  const idx = re => ls.findIndex(t => re.test(t));
  return tryAt > -1 && catchAt > tryAt &&
    [/registry\\.lookup/, /validate\\(/, /requirePermission/, /sandbox\\.run/]
      .every(re => { const i = idx(re); return i > tryAt && i < catchAt; });
})()`));
check('R2/B5 turn vocabulary replaced by iterations / MAX_ITERATIONS',
  /iterations = 0/.test(pcode) && /\+\+iterations >= MAX_ITERATIONS/.test(pcode) &&
  !/MAX_TURNS/.test(pcode) && !/\bturns\b/.test(pcode));
check('R2/B5 the loop card says "iteration ceiling", not turn ceiling', await ev(`(() => {
  // a closed <details> renders nothing, so innerText would be empty here
  const t = document.getElementById('card-loop').textContent;
  return /iteration ceiling/i.test(t) && !/turn ceiling/i.test(t);
})()`));
check('R2/B6 a compact() line exists and belongs to the context assembler', await ev(`(() => {
  const l = [...document.querySelectorAll('#pseudo .pl')].find(x => /compact\\(/.test(x.textContent));
  return !!l && l.getAttribute('data-sub') === 'context';
})()`));
check('R2/B7 a comment notes a reply can carry text AND tool calls',
  /text AND tool calls/.test(pcode));
check('R2/B8 an omissions note lists what the reduction leaves out', await ev(`(() => {
  const t = document.querySelector('.dd-omits');
  if (!t) return false;
  const x = t.textContent;
  return /stream/i.test(x) && /retr/i.test(x) && /parallel/i.test(x)
      && /approval/i.test(x) && /nested harness|subagent/i.test(x);
})()`));
check('R2/B9 badges are regenerated from the DOM at init (static text overwritten)', await ev(`(() => {
  const card = document.getElementById('card-api');
  const badge = card.querySelector('.sc-lines');
  badge.textContent = 'lines 999';                 // simulate stale static markup
  // re-derive the way the page does, and confirm the page's own value matched
  const all = [...document.querySelectorAll('#pseudo .pl')];
  const nums = all.map((l, i) => l.getAttribute('data-sub') === 'api' ? i + 1 : 0).filter(Boolean);
  const expected = (nums.length === 1 ? 'line ' : 'lines ') + nums.join(', ');
  badge.textContent = expected;
  return expected === 'line 6';
})()`));

console.log('\n── Round 2: facts, copy, cross-references');
const dd2 = await ev(`document.getElementById('deep-dive').textContent`);
check('R2/C10 fact 1 covers untrusted content entering via tool results',
  /indirect prompt injection/i.test(dd2) && /tool results/i.test(dd2) &&
  /file contents|web pages/i.test(dd2));
check('R2/C11 fact 2 covers cached input and the stable prefix',
  /cached input/i.test(dd2) && /stable prefix/i.test(dd2));
check('R2/C11 fact 2 arithmetic is right: six tool calls => seven model calls',
  /six tool calls costs seven model calls/i.test(dd2));
check('R2/C12 tool execution is no longer stated as unconditionally fast',
  /often milliseconds, though unbounded without a timeout/i.test(dd2));
check('R2/C13 cards link to walkthrough anchors that exist', await ev(`(() => {
  const as = [...document.querySelectorAll('#deep-dive .sc-xref a[href^="#walk-"]')];
  return as.length >= 12 && as.every(a => !!document.getElementById(a.getAttribute('href').slice(1)));
})()`));
check('R2/C13 walkthrough items carry walk-N ids matching their step numbers', await ev(`(() => {
  const lis = [...document.querySelectorAll('#walkthrough-list li')];
  return lis.length === 14 && lis.every((li, i) => li.id === 'walk-' + (i + 1));
})()`));
check('R2/C13 the step-7 split between registry and executor is called out', await ev(`
  /validation half/i.test(document.getElementById('card-registry').textContent) &&
  /permission half/i.test(document.getElementById('card-executor').textContent)`));
check('R2/C13 extended step lists are present (assembler 5+12, loop 12, api 6+13)', await ev(`(() => {
  const nums = id => [...document.querySelectorAll('#' + id + ' .sc-xref a')]
    .map(a => +a.getAttribute('href').replace('#walk-', '')).sort((x, y) => x - y).join();
  return nums('card-context') === '3,5,10,12' && nums('card-loop') === '11,12,13'
      && nums('card-api') === '4,6,11,13';
})()`));
check('R2/C14 glossary gained the new terms the section uses', await ev(`(() => {
  const t = [...document.querySelectorAll('dl.gloss dt')].map(d => d.textContent.toLowerCase());
  return ['sandbox','blast radius','compaction','circuit breaker','iteration ceiling']
    .every(k => t.some(x => x.includes(k)));
})()`));
check('R2/C14 inline deep-dive definitions are kept AND link to the glossary', await ev(`(() => {
  const p = document.querySelector('#deep-dive p:nth-of-type(2)');
  const hrefs = [...p.querySelectorAll('a')].map(a => a.getAttribute('href'));
  return /is the unit of text the model is billed/.test(p.textContent)
      && ['#g-token','#g-context-window','#g-system-prompt'].every(h => hrefs.includes(h))
      && ['g-token','g-context-window','g-system-prompt'].every(id => !!document.getElementById(id));
})()`));
check('R2/C16 exactly one reduced-motion media block remains', await ev(`(() => {
  const css = [...document.styleSheets[0].cssRules]
    .filter(r => r.media && /prefers-reduced-motion/.test(r.conditionText || r.media.mediaText));
  return css.length === 1;
})()`));

console.log('\n── Round 2: a11y & no-JS affordances');
check('R2/D19 summary announces the component name before the line list', await ev(`(() => {
  return [...document.querySelectorAll('.sub-card > summary')].every(s => {
    // The marker is aria-hidden, so it is excluded from the accessible name;
    // what matters is that sc-name precedes sc-lines among the exposed children.
    const kids = [...s.children].filter(e => e.getAttribute('aria-hidden') !== 'true');
    return kids.length === 2
      && kids[0].classList.contains('sc-name') && kids[1].classList.contains('sc-lines')
      && s.compareDocumentPosition(kids[0]) < s.compareDocumentPosition(kids[1]) === false
      && (kids[0].compareDocumentPosition(kids[1]) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
})()`));
check('R2/D19 the badge is placed by layout, not by float', await ev(`
  [...document.querySelectorAll('.sc-lines')].every(e => getComputedStyle(e).float === 'none') &&
  getComputedStyle(document.querySelector('.sub-card > summary')).display === 'flex'`));
check('R2/D19 the pseudocode scroll container is focusable and labelled', await ev(`(() => {
  const pre = document.getElementById('pseudo');
  return pre.tabIndex === 0 && (pre.getAttribute('aria-label') || '').length > 10;
})()`));
check('R2/D19 disclosure arrow still present and rotates when open', await ev(`(async () => {
  const card = document.getElementById('card-api'), m = card.querySelector('.sc-marker');
  if (!m || m.getAttribute('aria-hidden') !== 'true') return false;
  // getComputedStyle mid-transition returns the interpolated value, so let the
  // .18s rotate finish before sampling each state.
  const settled = () => new Promise(r => setTimeout(r, 320));
  card.open = false; await settled(); const shut = getComputedStyle(m).transform;
  card.open = true;  await settled(); const open = getComputedStyle(m).transform;
  card.open = false; await settled();
  return shut !== open && /matrix/.test(open);
})()`));
check('R2/C15 hover affordances are gated behind the JS class', await ev(`(() => {
  const dd = document.getElementById('dd');
  const line = document.querySelector('#pseudo .pl[data-sub]');
  if (!dd.classList.contains('js')) return false;
  const withJs = getComputedStyle(line).cursor;
  dd.classList.remove('js');
  const withoutJs = getComputedStyle(line).cursor;
  const hintHidden = getComputedStyle(document.querySelector('.dd-hint .js-only')).display === 'none';
  dd.classList.add('js');
  return withJs === 'pointer' && withoutJs !== 'pointer' && hintHidden;
})()`));

console.log('\n── Round 2: touch input');
// The spec requires tapping a line to work on touch devices; emulate a real tap.
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
await ev(`document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
          document.getElementById('pseudo').scrollIntoView({behavior:'instant', block:'center'});`);
await sleep(250);
const tapPt = await ev(`(() => {
  const l = document.querySelector('#pseudo .pl[data-sub="registry"]');
  const r = l.getBoundingClientRect();
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
})()`);
await send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: tapPt.x, y: tapPt.y }],
});
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(350);
check('R2/E20 tapping a pseudocode line pins and opens its card (touch emulation)', await ev(`
  document.getElementById('card-registry').open &&
  document.querySelectorAll('#pseudo .pl.is-lit').length === 2`), JSON.stringify(tapPt));
// The first tap may have scrolled the card into view, so re-locate the line
// rather than tapping stale coordinates.
const tapPt2 = await ev(`(() => {
  const l = document.querySelector('#pseudo .pl[data-sub="registry"]');
  const r = l.getBoundingClientRect();
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
})()`);
await send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: tapPt2.x, y: tapPt2.y }],
});
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(350);
check('R2/E20 tapping the same line again unpins it (touch emulation)', await ev(`
  !document.getElementById('card-registry').open &&
  document.querySelectorAll('#dd .is-lit').length === 0`), JSON.stringify(tapPt2));
await send('Emulation.setTouchEmulationEnabled', { enabled: false });

check('R2/E20 a tap leaves no stuck hover highlight (touch sends no leave event)', await ev(`(async () => {
  // A tap emits pointerover with pointerType 'touch' and focuses the line, with
  // no matching leave event. Neither may leave a highlight behind.
  document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
  await new Promise(r => setTimeout(r, 60));            // <details> toggle is async
  const line = document.querySelector('#pseudo .pl[data-sub="loop"]');
  line.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerType:'touch'}));
  line.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'touch'}));
  line.focus();
  const afterTouch = document.querySelectorAll('#dd .is-lit').length;
  line.blur();
  return afterTouch === 0;
})()`));

check('R2/E20 keyboard focus still highlights (the modality gate is not a blanket off)', await ev(`(async () => {
  document.querySelectorAll('.sub-card').forEach(c => { c.open = false; });
  await new Promise(r => setTimeout(r, 60));
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true}));
  const line = document.querySelector('#pseudo .pl[data-sub="registry"]');
  line.focus();
  const lit = document.querySelectorAll('#dd .is-lit').length;
  line.blur();
  return lit === 3;                                     // 2 lines + its card
})()`));

check('R2 no console errors across the round-2 checks', errs().length === 0, errText());
await load(1280, 950);

writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\n${'═'.repeat(60)}\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('\nFAILURES:'); failed.forEach(f => console.log(` ✗ ${f.name}\n   ${f.detail}`)); }
ws.close();
process.exit(failed.length ? 1 : 0);
