// 独立验收脚本：用 CDP 驱动 headless Edge，按脚本点击并截图。
// 用法: node _verify_levels.mjs <plan.json>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9336;
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// plan.software === true 时强制 SwiftShader 软件渲染；默认走硬件 GPU 路径。
// 每次都换一个全新的 user-data-dir，避免上一轮存下来的相机/缓存影响验收。
const gpuFlags = plan.software
  ? ['--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader']
  : ['--use-angle=default'];
const proc = spawn(EDGE, ['--headless=new','--no-sandbox','--hide-scrollbars','--window-size=1600,900',
  ...gpuFlags,
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '/wv-verify-' + Date.now(), 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function firstTarget() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); const j = await r.json();
      const p = j.find((t) => t.type === 'page'); if (p) return p; } catch (e) {}
    await sleep(500);
  }
  throw new Error('CDP 未就绪');
}

const page = await firstTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; logs.push('EXC: ' + ((d.exception && d.exception.description) || d.text)); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR: ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
});
await new Promise((r) => ws.addEventListener('open', r));
function send(method, params) { return new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }); }
await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: plan.url });
await sleep(plan.warmupMs || 20000);

async function shot(path) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result && s.result.data) { fs.writeFileSync(path, Buffer.from(s.result.data, 'base64')); console.log('shot ' + path + ' (' + Math.round(fs.statSync(path).size/1024) + ' KB)'); }
}
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log('click ' + x + ',' + y);
}
async function typeText(text) {
  for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
}

for (const step of plan.steps) {
  if (step.wait) await sleep(step.wait);
  if (step.wheel) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: step.wheel[0], y: step.wheel[1], deltaX: 0, deltaY: step.wheel[2] }); console.log('wheel ' + step.wheel.join(',')); }
  if (step.move) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.move[0], y: step.move[1], button: 'none', clickCount: 0 }); console.log('move ' + step.move.join(',')); }
  if (step.click) await click(step.click[0], step.click[1]);
  if (step.eval) { const r = await send('Runtime.evaluate', { expression: step.eval, returnByValue: true, awaitPromise: true }); console.log('eval ' + step.eval.slice(0, 60) + ' => ' + JSON.stringify(r.result && r.result.result && r.result.result.value)); }
  if (step.type) await typeText(step.type);
  if (step.shot) await shot(step.shot);
  if (step.text) { const r = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,500)', returnByValue: true }); console.log('TEXT[' + step.text + ']: ' + JSON.stringify(r.result && r.result.result && r.result.result.value)); }
}
console.log('LOGS: ' + JSON.stringify(logs.slice(0, 12)));
ws.close(); proc.kill(); process.exit(0);