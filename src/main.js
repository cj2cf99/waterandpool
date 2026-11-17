// 应用入口：渲染 + UI。正常模式仿真跑在 Worker；?capture 模式仿真在主线程、手动步进（供无头截图脚本使用）。
import { Renderer } from './render/renderer.js';
import { Simulation } from './sim.js';
import { mat4 } from './render/mat.js';
import { WIDTH, LENGTH } from './terrain.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const capture = qs.has('capture');
const canvas = $('c');
let renderer, worker = null, sim = null, snap = null, speed = 1, paused = false;
const state = { U: Number(qs.get('U') ?? 4), dir: Number(qs.get('dir') ?? 15), gust: true };

function showErr(e) { const d = $('err'); d.style.display = 'flex'; d.textContent = '出错：' + (e && e.stack ? e.stack : e); console.error(e); }
window.addEventListener('error', (e) => showErr(e.error || e.message));

function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  const w = capture ? Number(qs.get('w') || 1280) : Math.round(innerWidth * dpr), h = capture ? Number(qs.get('h') || 720) : Math.round(innerHeight * dpr);
  canvas.width = w; canvas.height = h;
  if (capture) { canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; }
  if (renderer) renderer.resize(w, h);
}

function dirLabel(d) { const c = Math.cos(d * Math.PI / 180), s = Math.sin(d * Math.PI / 180); if (c > 0.7) return '朝岸'; if (c < -0.7) return '离岸'; return s > 0 ? '沿岸向北' : '沿岸向南'; }
function updateLabels() {
  $('windv').textContent = state.U.toFixed(1) + ' m/s';
  $('dirv').textContent = `${state.dir}° ${dirLabel(state.dir)}`;
  $('speedv').textContent = speed.toFixed(2) + '×';
}
function pushWind() {
  if (worker) worker.postMessage({ type: 'wind', U: state.U, dir: state.dir }); else if (sim) sim.setWind(state.U, state.dir);
  updateLabels();
}

function initUI() {
  $('wind').value = state.U; $('dir').value = state.dir;
  $('wind').oninput = (e) => { state.U = Number(e.target.value); pushWind(); };
  $('dir').oninput = (e) => { state.dir = Number(e.target.value); pushWind(); };
  document.querySelectorAll('#presets button').forEach((b) => (b.onclick = () => { state.U = Number(b.dataset.u); $('wind').value = state.U; pushWind(); }));
  $('gust').onclick = (e) => { state.gust = !state.gust; e.target.textContent = state.gust ? '开' : '关'; e.target.classList.toggle('on', state.gust); worker ? worker.postMessage({ type: 'gust', on: state.gust }) : (sim.windMode = state.gust ? 'gusty' : 'steady'); };
  let ropeOn = true;
  $('rope').onclick = (e) => { ropeOn = !ropeOn; e.target.textContent = ropeOn ? '开' : '关'; e.target.classList.toggle('on', ropeOn); worker ? worker.postMessage({ type: 'rope', on: ropeOn }) : (sim.boat.rope && (sim.boat.rope.on = ropeOn)); };
  $('ssaa').onchange = (e) => renderer.setSSAA(Number(e.target.value));
  $('grid').onchange = (e) => restartSim(Number(e.target.value));
  $('speed').oninput = (e) => { speed = Number(e.target.value); worker && worker.postMessage({ type: 'speed', v: speed }); updateLabels(); };
  $('pause').onclick = (e) => { paused = !paused; e.target.textContent = paused ? '继续' : '暂停'; worker && worker.postMessage({ type: 'pause', v: paused }); };
  updateLabels();
}

function restartSim(scale) {
  const o = { scale, U: state.U, dirDeg: state.dir, warm: 0 };
  if (worker) worker.postMessage({ type: 'init', opts: o }); else { sim = new Simulation(o); }
}

// —— 相机交互 ——
function initCamera() {
  const cam = renderer.cam; let mode = 0, lx = 0, ly = 0, moved = 0, downX = 0, downY = 0;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { mode = e.button === 2 ? 2 : 1; lx = downX = e.clientX; ly = downY = e.clientY; moved = 0; canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag'); });
  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return; const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (mode === 1) { cam.yaw -= dx * 0.005; cam.pitch += dy * 0.004; }
    else { const s = cam.dist * 0.0016; cam.target[0] += (Math.sin(cam.yaw) * dx - Math.cos(cam.yaw) * dy) * s; cam.target[1] += (-Math.cos(cam.yaw) * dx - Math.sin(cam.yaw) * dy) * s; }
  });
  canvas.addEventListener('pointerup', (e) => { if (mode === 1 && moved < 5) pick(e.clientX, e.clientY); mode = 0; canvas.classList.remove('drag'); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist *= Math.exp(e.deltaY * 0.0012); }, { passive: false });
}
function pick(px, py) {
  const cam = renderer.cam, r = canvas.getBoundingClientRect();
  const nx = ((px - r.left) / r.width) * 2 - 1, ny = -(((py - r.top) / r.height) * 2 - 1);
  const proj = mat4.perspective(cam.fov, canvas.width / canvas.height, 0.08, 900), view = mat4.lookAt(cam.eye(), cam.target, [0, 0, 1]);
  const inv = mat4.invert(mat4.mul(proj, view));
  const un = (z) => { const v = [inv[0] * nx + inv[4] * ny + inv[8] * z + inv[12], inv[1] * nx + inv[5] * ny + inv[9] * z + inv[13], inv[2] * nx + inv[6] * ny + inv[10] * z + inv[14], inv[3] * nx + inv[7] * ny + inv[11] * z + inv[15]]; return [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; };
  const a = un(-1), b = un(1), t = (0 - a[2]) / (b[2] - a[2]); const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
  if (t > 0 && x > 0.3 && x < WIDTH - 0.3 && y > 0.3 && y < LENGTH - 0.3) { if (worker) worker.postMessage({ type: 'drop', x, y }); else sim.drop(x, y); }
}

let frames = 0, fpsT = performance.now(), fps = 0;
function updateStats() {
  if (!snap) return; const b = snap.boat;
  const st = snap.stat || {};
  const q = b.q, roll = Math.atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * 57.3, pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) * 57.3;
  $('stats').innerHTML = `有效风速 ${snap.wind.U.toFixed(1)} m/s · 入射涌浪 Hs ${snap.Hs.toFixed(2)} m / T ${snap.Tp.toFixed(1)} s<br>船：横摇 ${roll.toFixed(1)}° 纵摇 ${pitch.toFixed(1)}°${b.rope && b.rope.tension > 1 ? ' · 绳张力 ' + b.rope.tension.toFixed(0) + ' N' : ''}<br>${fps.toFixed(0)} fps · 仿真 ${(st.simRate ?? 1).toFixed(2)}× · ${(st.ms ?? 0).toFixed(1)} ms/步 · 水花 ${snap.nSpray}`;
}

async function start() {
  try {
    renderer = new Renderer(canvas, { ssaa: Number(qs.get('ssaa') ?? (capture ? 1.5 : 1.5)) });
    fit(); window.addEventListener('resize', fit); initUI(); initCamera();
    const o = { scale: 1, U: state.U, dirDeg: state.dir };
    if (capture) {
      sim = new Simulation({ ...o, windMode: qs.get('gust') === '0' ? 'steady' : 'gusty' });
      const adv = (sec) => { sim.step(sec); };
      window.__water = { sim, renderer, advance: adv, setWind(U, d) { state.U = U; state.dir = d; sim.setWind(U, d); }, snap: () => (snap = sim.snapshot()), draw() { snap = sim.snapshot(); renderer.render(snap); }, cam: renderer.cam };
      window.__ready = true;
      return;
    }
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => { if (e.data.type === 'snap') snap = e.data.snap; };
      worker.onerror = (e) => { console.warn('Worker 失败，改用主线程仿真', e.message); worker = null; sim = new Simulation(o); };
      worker.postMessage({ type: 'init', opts: o });
    } catch (err) { console.warn('Worker 不可用，改用主线程仿真', err); sim = new Simulation(o); }
    let last = performance.now();
    const loop = (t) => {
      requestAnimationFrame(loop);
      if (!worker && sim && !paused) { const dt = Math.min(0.05, (t - last) / 1000 * speed); sim.step(dt); }
      last = t;
      if (!worker && sim) snap = sim.snapshot();
      if (snap) renderer.render(snap);
      frames++; if (t - fpsT > 500) { fps = frames * 1000 / (t - fpsT); frames = 0; fpsT = t; updateStats(); }
    };
    requestAnimationFrame(loop);
  } catch (e) { showErr(e); }
}
start();
