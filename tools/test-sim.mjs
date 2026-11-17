// A7 船、A8 综合稳定与交互、C1 性能。用法：node tools/test-sim.mjs [A7 A8 C1]
import fs from 'node:fs';
import { Simulation } from '../src/sim.js';
import { Boat, HULL, bottomZ, gunwaleZ, qrot, RHO } from '../src/boat.js';
import { G } from '../src/swe.js';
import { bedHeight } from '../src/terrain.js';

const want = new Set(process.argv.slice(2));
const run = (id) => want.size === 0 || want.has(id);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lin = (m, full, zero) => clamp01((zero - m) / (zero - full));      // 越小越好 → 0..1
const results = {};
const log = (id, name, sc, max, text) => { results[id] = { name, score: +sc.toFixed(2), max }; console.log(`${id} ${name}\n    ${text}\n    得分 ${sc.toFixed(2)} / ${max}`); };

// ───────── A7 船 ─────────
if (run('A7')) {
  const flat = { eta: () => 0, vel: () => [0, 0], w: () => 0 };
  const b = new Boat({ bedAt: () => -5, pos: [0, 0, -0.1] });
  for (let k = 0; k < 6000; k++) b.step(0.005, flat);       // 30 s 稳定
  // (a) 精细积分排水体积（体坐标网格，真实船体几何 + 当前姿态）
  const Nx = 400, Ny = 200; let V = 0, Awp = 0;
  for (let i = 0; i < Nx; i++) for (let j = 0; j < Ny; j++) {
    const xb = (-0.5 + (i + 0.5) / Nx) * HULL.L, yb = (-1 + 2 * (j + 0.5) / Ny) * HULL.B * 1.0;
    const t = 2 * xb / HULL.L; const Bt = (() => { const tt = Math.max(-1, Math.min(1, t)); return tt >= 0 ? HULL.B * Math.pow(Math.max(0, 1 - Math.pow(tt, 2.2)), 0.62) : 0.40 + 0.25 * Math.pow(Math.max(0, 1 - tt * tt), 0.7); })();
    if (Math.abs(yb) > Bt) continue;
    const zb = bottomZ(xb, yb), zg = gunwaleZ(t);
    const pw = qrot(b.q, [xb, yb, zb]); const zWorld = b.pos[2] + pw[2];
    const d = Math.min(Math.max(0, 0 - zWorld), zg - zb);
    const dA = (HULL.L / Nx) * (2 * HULL.B / Ny);
    V += d * dA; if (d > 0) Awp += dA;
  }
  const Vth = b.m / RHO, errV = Math.abs(V - Vth) / Vth;
  const [roll, pitch] = b.euler();
  // (b) 垂荡周期：下压 3cm 释放，测相邻同向过零周期
  const z0 = b.pos[2]; b.pos[2] -= 0.03; b.vel = [0, 0, 0];
  let prev = b.pos[2] - z0, zc = [], tt = 0; const dt = 0.005;
  for (let k = 0; k < 8000; k++) {
    b.step(dt, flat); tt += dt; const cur = b.pos[2] - z0;
    if (prev < 0 && cur >= 0) zc.push(tt - dt * cur / (cur - prev));
    prev = cur;
  }
  const Tmeas = zc.length >= 3 ? (zc[2] - zc[0]) / 2 : NaN;
  const meffz = b.m * (1 + b.ma.z);                       // 含附加质量（系数为设定值，见 DEVELOPMENT.md）
  const wn = Math.sqrt(RHO * G * Awp / meffz), zeta = 0.22 * Math.sqrt(b.m / meffz);
  const Tth = 2 * Math.PI / (wn * Math.sqrt(1 - zeta * zeta));
  const errT = Math.abs(Tmeas - Tth) / Tth;
  // (c) 风不直接作用于船：源码无风项 + 强风静水 20s 位移
  const src = fs.readFileSync(new URL('../src/boat.js', import.meta.url), 'utf8');
  const noWindTerm = !/wind|Wind/.test(src.replace(/\/\/.*$/gm, ''));
  const sim = new Simulation({ U: 20, dirDeg: 0, windOnWater: false, windMode: 'steady' });
  sim.maker.HsTarget = 0; sim.maker.Hs = 0; sim.maker.setTarget(0, 3);
  const p0 = [...sim.boat.pos];
  sim.step(20);
  const disp = Math.hypot(sim.boat.pos[0] - p0[0], sim.boat.pos[1] - p0[1]);
  const scA = 1.7 * lin(errV, 0.03, 0.15) * (Math.abs(pitch) < 0.05 && Math.abs(roll) < 0.05 ? 1 : 0.5);
  const scB = 1.7 * lin(errT, 0.10, 0.40);
  const scC = 1.6 * (noWindTerm ? 1 : 0) * lin(disp, 0.03, 0.30);
  log('A7', '船：吃水、垂荡周期、风不直接作用', scA + scB + scC, 5,
    `排水体积 ${V.toFixed(4)} m³ vs 阿基米德 ${Vth.toFixed(4)}（误差 ${(errV * 100).toFixed(2)}%），平衡姿态 横摇 ${(roll * 57.3).toFixed(2)}° 纵倾 ${(pitch * 57.3).toFixed(2)}°；垂荡周期 ${Tmeas.toFixed(3)}s vs 理论 ${Tth.toFixed(3)}s（误差 ${(errT * 100).toFixed(1)}%，水线面积 ${Awp.toFixed(2)} m²）；源码无风项=${noWindTerm}，风速 20 m/s 静水 20s 位移 ${(disp * 100).toFixed(2)} cm`);
}

// ───────── A8 综合稳定与交互 ─────────
if (run('A8')) {
  let sc = 0; const notes = [];
  // (1) 风暴 10 分钟稳定性（低分辨率档以节省时间）
  {
    const sim = new Simulation({ U: 20, dirDeg: 10, scale: 0.67 });
    let bad = false, minH = 0;
    const t0 = Date.now();
    for (let t = 0; t < 600; t += 1) {
      sim.step(1);
      if (t % 5 === 0) {
        const s = sim.swe;
        for (let j = 0; j < sim.ny && !bad; j++) for (let i = 0; i < sim.nx; i++) { const hh = s.h[s.id(i, j)]; if (!Number.isFinite(hh) || !Number.isFinite(s.q[s.id(i, j)])) { bad = true; break; } if (hh < minH) minH = hh; }
        if (!sim.boat.pos.every(Number.isFinite)) bad = true;
      }
      if (bad) break;
    }
    const ok = !bad && minH >= 0;
    sc += ok ? 2 : 0; notes.push(`风暴(20 m/s)10 分钟：${ok ? '无 NaN，h≥0' : '失败'}，最小水深 ${minH}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，船位 (${sim.boat.pos.map((v) => v.toFixed(2)).join(', ')})`);
  }
  // (2) 浪撞石头 → 水花；静水无
  {
    const still = new Simulation({ U: 0, windMode: 'steady' });
    still.maker.HsTarget = 0; still.maker.Hs = 0;
    still.step(40);
    const sim = new Simulation({ U: 12, dirDeg: 0, windMode: 'steady' });
    sim.step(110);
    const nStill = still.stats.rockSprayEmitted, nWave = sim.stats.rockSprayEmitted;
    sc += (nWave > 300 ? 1 : nWave > 50 ? 0.5 : 0) + (nStill === 0 ? 0.5 : 0);
    notes.push(`石头水花事件：浪(U=12) ${nWave} 个，静水 ${nStill} 个`);
    // (3) 岸边上冲/回流与湿沙记忆（沿 y=5 的一行追踪水边位置，观测 40 秒）
    const jrow = Math.round(5 / sim.dx), s = sim.swe;
    const front = () => { for (let i = sim.nx - 1; i >= 0; i--) if (s.h[s.id(i, jrow)] > 0.004) return (i + 0.5) * sim.dx; return 0; };
    let fmin = 1e9, fmax = 0;
    for (let t = 0; t < 40; t += 0.1) { sim.step(0.1); const f = front(); fmin = Math.min(fmin, f); fmax = Math.max(fmax, f); }
    const swashRange = fmax - fmin;
    let wetMem = 0, wetCells = 0;
    for (let c = 0; c < sim.nx * sim.ny; c++) { const k = s.id(c % sim.nx, Math.floor(c / sim.nx)); if (s.h[k] < 0.002 && sim.wet[c] > 0.4) wetMem++; if (s.h[k] < 0.002) wetCells++; }
    sc += (swashRange > 0.5 ? 1 : swashRange > 0.2 ? 0.5 : 0) + (wetMem > 200 ? 0.5 : 0);
    notes.push(`水边在 ${fmin.toFixed(2)}–${fmax.toFixed(2)} m 间往复（幅度 ${swashRange.toFixed(2)} m），湿沙记忆单元 ${wetMem}`);
  }
  log('A8', '综合稳定与交互', sc, 5, notes.join('\n    '));
}

// ───────── C1 性能 ─────────
if (run('C1')) {
  const sim = new Simulation({ U: 10, dirDeg: 0 }); sim.step(20);
  const n = 240, t0 = process.hrtime.bigint();
  for (let k = 0; k < n; k++) sim.step(1 / 60);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  const sc = 4 * lin(ms, 12, 25);
  log('C1', '性能（默认网格，每 1/60s 仿真）', sc, 4, `平均 ${ms.toFixed(2)} ms/帧（网格 ${sim.nx}×${sim.ny}，Node ${process.version}）`);
}

fs.mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const f = new URL('../out/sim-scores.json', import.meta.url);
const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {};
fs.writeFileSync(f, JSON.stringify({ ...prev, ...results }, null, 1));
