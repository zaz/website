// Run against a local preview: node tools/check-plank-landing.mjs http://127.0.0.1:8841/
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

const url = process.argv[2];
assert(url, 'Provide the landing-page preview URL');
const profile = await mkdtemp(join(homedir(), '.cache/plank-browser-'));
const browser = spawn(process.env.CHROMIUM_BIN || 'chromium', [
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-test-session-bus'}});
let socket, send;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(Error('Browser startup timed out')), 15000);
    browser.once('exit', code => { clearTimeout(timer); reject(Error(`Browser exited ${code}: ${stderr}`)); });
    browser.stderr.on('data', data => {
      stderr += data;
      const found = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
  });
  assert.equal(await readFile(`/proc/${browser.pid}/cgroup`, 'utf8'), await readFile('/proc/self/cgroup', 'utf8'), 'Browser stays inside the worker memory scope');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map(), errors = [];
  socket.onmessage = ({data}) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const call = pending.get(message.id);
    if (call) { pending.delete(message.id); message.error ? call.reject(message.error) : call.resolve(message.result); }
  };
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params, sessionId}));
  });
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settle = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(50); }
    throw Error('Timed out: ' + expression);
  };
  const root = 'document.querySelector(".landing-planks")';
  const widget = `${root}.introPlanks`;
  const q = () => evaluate(`${widget}.model.q.slice()`);
  const mouse = (type, point, buttons = 0) => page('Input.dispatchMouseEvent', {
    type, ...point, ...(type === 'mouseMoved' ? {buttons, button: buttons ? 'left' : 'none'} : {button: 'left', clickCount: 1}),
  });
  const at = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const click = async selector => { const p = await at(selector); await mouse('mouseMoved', p); await mouse('mousePressed', p); await mouse('mouseReleased', p); await settle(); };
  const key = async (key, code, keyCode) => {
    await page('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode});
    await page('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode});
    await settle();
  };
  const screenshots = process.env.PLANK_CHECK_SCREENSHOTS;
  const screenshot = async name => {
    if (!screenshots) return;
    await mkdir(screenshots, {recursive: true});
    const {data} = await page('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    await writeFile(join(screenshots, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const points = async (kind, side, index) => {
    await evaluate(`${widget}.diagram.host.scrollIntoView({block:'center'})`);
    await settle();
    return evaluate(`(()=>{const {diagram:d,model:m}=${widget},h=d.handles.find(h=>h.i===0&&h.kind==='${kind}'&&h.side===${side}),p=m.plank(0),a=h.pos,b=${index === 2 ? '[a[0]*Math.cos(.1)-a[1]*Math.sin(.1),a[0]*Math.sin(.1)+a[1]*Math.cos(.1)]' : '[a[0]+p.nx*18,a[1]+p.ny*18]'};return [a,b].map(p=>{const q=new DOMPoint(...p).matrixTransform(d.scene.getScreenCTM());return {x:q.x,y:q.y};});})()`);
  };

  await page('Runtime.enable'); await page('Page.enable'); await page('Network.enable');
  await page('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'light'}, {name: 'prefers-reduced-motion', value: 'reduce'}]});
  await page('Page.navigate', {url});
  await waitFor(`Boolean(${root}?.introPlanks)`);
  const initial = await q();
  assert.equal(await evaluate(`${widget}.diagram.handles.length`), 15);
  assert(await evaluate(`${widget}.model.pristine&&!${widget}.model.playing&&!${widget}.model.changed`));
  assert(await evaluate(`${root}.querySelector('.intro-plank-reset').hidden`));
  assert(await evaluate(`${widget}.diagram.svg.hasAttribute('aria-labelledby')`));
  assert(await evaluate(`${widget}.diagram.svg.getAttribute('aria-labelledby').split(/\\s+/).every(id=>document.getElementById(id))`));
  assert(await evaluate(`[...document.querySelectorAll('a')].filter(a=>a.textContent==='interactive presentation').every(a=>a.hash==='')`));
  const presentationUrl = await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent==='interactive presentation').href`);
  await screenshot('initial-light');

  for (const [kind, side, index] of [['move', 0, 0], ['resize', 1, 1], ['rotate', 1, 2]]) {
    await mouse('mouseMoved', await at(`[data-plank-hint="${kind}"]`));
    assert.equal(await evaluate(`${widget}.diagram.handles.filter(h=>h.group.classList.contains('revealed')).length`), kind === 'move' ? 3 : 6);
    const [a, b] = await points(kind, side, index), before = await q();
    await mouse('mouseMoved', a);
    assert.equal(await evaluate(`getComputedStyle(document.elementFromPoint(${a.x},${a.y})).cursor`), 'grab');
    await mouse('mousePressed', a);
    assert.equal(await evaluate(`${widget}.diagram.drag?.kind`), kind);
    await mouse('mouseMoved', b, 1); await mouse('mouseReleased', b); await settle();
    const after = await q();
    assert(Math.abs(after[index] - before[index]) > .005, `${kind} changes its parameter`);
    after.forEach((value, i) => { if (i !== index) assert.equal(value, before[i], `${kind} preserves parameter ${i}`); });
    assert(!(await evaluate(`${root}.querySelector('.intro-plank-reset').hidden`)));
  }
  assert.notEqual(await evaluate(`${root}.querySelector('[data-width-sum]').textContent`), '116');
  const beforeCancel = await q(), [a, b] = await points('move', 0, 0);
  await mouse('mousePressed', a); await mouse('mouseMoved', b, 1); await key('Escape', 'Escape', 27); await mouse('mouseReleased', b);
  assert.deepEqual(await q(), beforeCancel);
  await evaluate(`${widget}.diagram.handles.find(h=>h.i===0&&h.kind==='move').group.focus()`);
  const beforeKey = await q(); await key('ArrowRight', 'ArrowRight', 39);
  assert((await q())[0] > beforeKey[0]);
  await evaluate(`${widget}.model.setParameter(1,.01)`);
  assert((await evaluate(`${widget}.diagram.svg.querySelectorAll('[data-cell]').length`)) > 0, 'Uncovered regions update');
  await click('.intro-plank-reset'); assert.deepEqual(await q(), initial);

  await click('.landing-plank-play'); await pause(300);
  assert(await evaluate(`${widget}.model.playing&&${widget}.model.changed`));
  const [hold, target] = await points('move', 0, 0);
  await mouse('mousePressed', hold); await mouse('mouseMoved', target, 1);
  const bounds = await evaluate(`(()=>{const p=${widget}.model.plank(0);return [p.lo,p.hi];})()`);
  await pause(200);
  const later = await evaluate(`(()=>{const p=${widget}.model.plank(0);return [p.lo,p.hi];})()`);
  later.forEach((value, i) => assert(Math.abs(value - bounds[i]) < 1e-7, 'A held plank stays under the pointer during animation'));
  await mouse('mouseReleased', target);
  assert(await evaluate(`${widget}.model.playing`));
  await click('.landing-plank-play'); const paused = await q(); await pause(150); assert.deepEqual(await q(), paused);
  await click('.landing-plank-play');
  await page('Emulation.setDeviceMetricsOverride', {width: 1440, height: 500, deviceScaleFactor: 1, mobile: false});
  await evaluate('window.scrollTo(0,document.documentElement.scrollHeight)'); await pause(150);
  assert(await evaluate(`${widget}.diagram.host.getBoundingClientRect().bottom<0`), 'Diagram is fully outside the viewport');
  const offscreen = await q(); await pause(150); assert.deepEqual(await q(), offscreen, 'Animation sleeps off screen');
  await page('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  await click('.intro-plank-reset'); assert.deepEqual(await q(), initial);
  assert(!(await evaluate(`${widget}.model.playing`)));

  for (const theme of ['light', 'dark']) {
    await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: theme}]});
    for (const width of [1440, 768, 390]) {
      await page('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: false});
      await evaluate(`${widget}.diagram.host.scrollIntoView({block:'center'})`); await settle();
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'), `No overflow at ${width} / ${theme}`);
      const r = await evaluate(`(()=>{const r=${widget}.diagram.host.getBoundingClientRect();return {width:r.width,height:r.height};})()`);
      assert(r.width <= 512); assert(Math.abs(r.width / r.height - 1149 / 1070) < .001);
      await screenshot(`${theme}-${width}`);
    }
  }
  await page('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
  const [touchA, touchB] = await points('move', 0, 0), beforeTouch = await q();
  await page('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [touchA]});
  await page('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [touchB]});
  await page('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  assert.notEqual((await q())[0], beforeTouch[0], 'Touch moves a plank');

  await page('Network.setCacheDisabled', {cacheDisabled: true});
  await page('Network.setBlockedURLs', {urls: ['*/r/plank-viz/core.js']});
  await page('Page.navigate', {url});
  await waitFor(`Boolean(${root}?.querySelector('img')?.complete)`);
  assert(await evaluate(`${root}.querySelector('img').naturalWidth>0&&${root}.querySelector('figcaption').hidden&&!${root}.introPlanks`), 'Static artwork remains usable when the engine cannot load');
  await page('Network.setBlockedURLs', {urls: []});
  await page('Page.navigate', {url: presentationUrl});
  await waitFor('Boolean(window.plankPresentation?.deck.isReady())');
  assert.equal(await evaluate('plankPresentation.deck.getCurrentSlide().id'), 'title', 'Bare presentation URL starts at the title');
  assert.equal(await evaluate('[...document.scripts].filter(s=>s.src.endsWith("/plank-viz/core.js")).length'), 1, 'Presentation uses the shared engine');
  assert.deepEqual(errors, []);
  console.log('Passed: pointer, touch, keyboard, Escape, Reset, live widths/gaps, animation while dragging, idle suspension, light/dark layouts, title links, and image fallback.');
} finally {
  if (send && socket?.readyState === 1) {
    try { await Promise.race([send('Browser.close'), new Promise(r => setTimeout(r, 1000))]); } catch {}
  }
  socket?.close();
  if (browser.exitCode === null) await new Promise(r => { browser.once('exit', r); setTimeout(r, 3000); });
  if (browser.exitCode === null) throw Error('Owned browser did not exit; profile retained');
  await rm(profile, {recursive: true, force: true});
}
