// 物理验证 A1–A6（求解器）。A7/A8 在 test-boat.mjs / test-sim.mjs。
// 用法：node tools/test-physics.mjs [A1 A3 ...]
import { SWE, G, windDrag } from '../src/swe.js';
import fs from 'node:fs';

const want = new Set(process.argv.slice(2));
const run = (id) => want.size === 0 || want.has(id);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
// 越小越好：m ≤ full → 5 分，m ≥ zero → 0 分
const score = (m, full, zero) => 5 * clamp01((zero - m) / (zero - full));
const results = {};
const log = (id, name, metric, text, sc) => {
  results[id] = { name, metric, score: +sc.toFixed(2) };
  console.log(`${id} ${name}\n    ${text}\n    得分 ${sc.toFixed(2)} / 5`);
};

function channel(nx, ny, dx, bedFn, opts = {}) {
  const bed = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) bed[j * nx + i] = bedFn((i + 0.5) * dx, (j + 0.5) * dx);
  return new SWE({ nx, ny, dx, bed, ...opts });
}

// ───────── A1 静水平衡 ─────────
if (run('A1')) {
  const nx = 64, ny = 48, dx = 0.25;
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const noise = new Float64Array(nx * ny).map(() => (rnd() - 0.5) * 0.1);
  const s = channel(nx, ny, dx, (x, y) => {
    const i = Math.floor(x / dx), j = Math.floor(y / dx);
    const island = 1.4 * Math.exp(-((x - 8) ** 2 + (y - 6) ** 2) / 4) - 0.8;           // 露出水面的岛
    const slope = -0.9 + 0.12 * x * (x > 10 ? 1 : 0.3);
    return Math.min(island + 0, 0.6) + 0.5 * slope * 0 + noise[j * nx + i] + (x > 12 ? 0.07 * (x - 12) : 0) - 0.2;
  });
  const v0 = s.totalVolume();
  s.advance(20);
  let maxU = 0, maxDe = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = s.id(i, j);
    if (s.h[k] > 1e-3) { maxU = Math.max(maxU, Math.hypot(s.q[k], s.r[k]) / s.h[k]); maxDe = Math.max(maxDe, Math.abs(s.h[k] + s.b[k])); }
  }
  // 满分 <1e-6，零分 ≥1e-3（对数线性）
  const sc = 5 * clamp01((Math.log10(1e-3) - Math.log10(Math.max(maxU, 1e-12))) / (Math.log10(1e-3) - Math.log10(1e-6)));
  log('A1', '静水平衡', maxU, `20s 后最大流速 ${maxU.toExponential(2)} m/s，最大水面偏差 ${maxDe.toExponential(2)} m，体积变化 ${((s.totalVolume() - v0) / v0).toExponential(2)}`, sc);
}

// ───────── A2 质量守恒（封闭域造浪+上冲）─────────
if (run('A2')) {
  const nx = 200, ny = 6, dx = 0.1;
  const s = channel(nx, ny, dx, (x) => (x < 10 ? -0.8 : -0.8 + (x - 10) * 0.12));
  // 在左部制造一个水丘，让它冲上斜坡
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = (i + 0.5) * dx; const k = s.id(i, j); s.h[k] = Math.max(0, -s.b[k] + 0.3 * Math.exp(-((x - 4) ** 2) / 1.5)); }
  const v0 = s.totalVolume();
  s.advance(30);
  const dv = s.totalVolume() - v0;
  const rel = Math.abs(dv) / v0, relClip = Math.abs(dv + s.clippedVolume) / v0;
  // 正性修正导致的体积变化已累计在 clippedVolume，用"修正后"误差评分；同时报告原始误差
  const sc = 5 * clamp01((Math.log10(1e-4) - Math.log10(Math.max(rel, 1e-16))) / (Math.log10(1e-4) - Math.log10(1e-9)));
  log('A2', '质量守恒', rel, `体积相对变化 ${rel.toExponential(2)}（其中正性修正累计 ${(s.clippedVolume / v0).toExponential(2)}，扣除后 ${relClip.toExponential(2)}）`, sc);
}

// ───────── A3 长波波速 ─────────
if (run('A3')) {
  const h0 = 0.8, nx = 600, dx = 0.05;
  const s = channel(nx, 3, dx, () => -h0);
  const x0 = 10, a = 0.004;
  for (let j = 0; j < 3; j++) for (let i = 0; i < nx; i++) { const x = (i + 0.5) * dx; s.h[s.id(i, j)] = h0 + a * Math.exp(-((x - x0) ** 2) / 0.18); }
  const T = 4; s.advance(T);
  let best = -1, xp = 0;
  for (let i = Math.floor(x0 / dx) + 5; i < nx; i++) { const e = s.h[s.id(i, 1)] - h0; if (e > best) { best = e; xp = (i + 0.5) * dx; } }
  const c = (xp - x0) / T, ce = Math.sqrt(G * h0);
  const err = Math.abs(c - ce) / ce;
  log('A3', '长波波速', err, `测得 c=${c.toFixed(3)} m/s，理论 √(gh)=${ce.toFixed(3)}，误差 ${(err * 100).toFixed(2)}%，波峰幅值 ${(best * 1000).toFixed(2)} mm`, score(err, 0.03, 0.10));
}

// ───────── A4 Synolakis 上冲 ─────────
// 理论解为无摩擦解，所以对比时 manning=0；同时给出生产配置(n=0.025)的上冲作信息。
if (run('A4')) {
  const runup = (manning) => {
    const d = 1, H = 0.0185, cot = 19.85, xToe = 25, L = 50, dx = 0.1, nx = Math.round(L / dx);
    const s = channel(nx, 3, dx, (x) => (x < xToe ? -d : -d + (x - xToe) / cot), { manning });
    const kappa = Math.sqrt(3 * H / (4 * d * d * d)), c0 = Math.sqrt(G * (d + H)), xc = 6;
    for (let j = 0; j < 3; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx, k = s.id(i, j), flat = s.b[k] < -d + 1e-9;
      const sech = 1 / Math.cosh(kappa * (x - xc)); const eta = flat ? H * sech * sech : 0;
      s.h[k] = Math.max(0, -s.b[k] + eta); s.q[k] = s.h[k] * (flat ? c0 * eta / (d + eta) : 0);
    }
    let R = -1, tR = 0;
    for (let t = 0; t < 60; t += 0.25) {
      s.advance(0.25);
      for (let i = Math.floor(xToe / dx); i < nx; i++) {
        const k = s.id(i, 1);
        if (s.h[k] > 5e-4) { const e = s.h[k] + s.b[k]; if (e > R) { R = e; tR = s.t; } } else if (i > Math.floor(xToe / dx) + 2) break;
      }
    }
    return { R, tR };
  };
  const { R, tR } = runup(0), fr = runup(0.025);
  const Ra = 2.831 * Math.sqrt(19.85) * Math.pow(0.0185, 1.25);
  const err = Math.abs(R - Ra) / Ra;
  log('A4', 'Synolakis 上冲', err, `无摩擦：R=${(R * 100).toFixed(2)} cm（t=${tR.toFixed(1)}s），理论 ${(Ra * 100).toFixed(2)} cm，误差 ${(err * 100).toFixed(1)}%；（信息）Manning n=0.025 时 R=${(fr.R * 100).toFixed(2)} cm`, score(err, 0.15, 0.5));
}

// ───────── A5 风应力壅水 ─────────
if (run('A5')) {
  const h0 = 0.5, L = 20, dx = 0.1, nx = Math.round(L / dx);
  const s = channel(nx, 3, dx, () => -h0, { manning: 0.06 });
  const U = 15; s.setWind(U, 0);
  const ax = s.wind.ax, Sth = ax / (G * h0);
  // 先积分到阻尼稳定，再在若干个振荡周期上取时间平均
  const Tseiche = 2 * L / Math.sqrt(G * h0);
  s.advance(8 * Tseiche);
  let acc = 0, nacc = 0;
  const win = 3 * Tseiche, dt = 0.05;
  for (let t = 0; t < win; t += dt) {
    s.advance(dt);
    const e1 = s.h[s.id(Math.round(3 / dx), 1)] + s.b[s.id(Math.round(3 / dx), 1)];
    const e2 = s.h[s.id(Math.round(17 / dx), 1)] + s.b[s.id(Math.round(17 / dx), 1)];
    acc += (e2 - e1) / (14); nacc++;
  }
  const Sm = acc / nacc, err = Math.abs(Sm - Sth) / Sth;
  log('A5', '风应力壅水', err, `U10=${U} m/s：τ/ρw=${ax.toExponential(2)} m²/s²，理论坡度 ${Sth.toExponential(3)}，测得 ${Sm.toExponential(3)}，误差 ${(err * 100).toFixed(2)}%（Cd=${windDrag(U).toExponential(2)}）`, score(err, 0.10, 0.50));
}

// ───────── A6 造浪精度与开边界反射 ─────────
if (run('A6')) {
  const h0 = 0.6, L = 40, dx = 0.1, nx = Math.round(L / dx), a = 0.03, T = 3.0, om = 2 * Math.PI / T;
  const s = channel(nx, 3, dx, () => -h0);
  s.west = { eta: (t) => a * Math.sin(om * t) * Math.min(1, t / (2 * T)) };
  for (let j = 0; j < 3; j++) for (let i = Math.round(28 / dx); i < nx; i++) s.sponge[s.id(i, j)] = 6 * ((i * dx - 28) / 12) ** 2;
  s.advance(45);
  // 沿程取一个周期内的最大振幅
  const xs = [], amp = [];
  const probes = []; for (let x = 8; x <= 24; x += 0.5) probes.push(Math.round(x / dx));
  const mx = probes.map(() => 0), mn = probes.map(() => 0);
  for (let t = 0; t < T; t += 0.05) {
    s.advance(0.05);
    probes.forEach((i, n) => { const e = s.h[s.id(i, 1)] - h0; if (e > mx[n]) mx[n] = e; if (e < mn[n]) mn[n] = e; });
  }
  const A = mx.map((m, n) => 0.5 * (m - mn[n]));
  const Amax = Math.max(...A), Amin = Math.min(...A);
  const R = (Amax - Amin) / (Amax + Amin);
  const Ainc = 0.5 * (Amax + Amin);
  const errA = Math.abs(Ainc - a) / a;
  const sc = 0.5 * score(errA, 0.10, 0.40) + 0.5 * score(R, 0.10, 0.40);
  log('A6', '造浪精度与开边界反射', Math.max(errA, R), `目标振幅 ${(a * 1000).toFixed(1)} mm，测得入射 ${(Ainc * 1000).toFixed(2)} mm（误差 ${(errA * 100).toFixed(1)}%），反射系数 R=${R.toFixed(3)}`, sc);
}

fs.mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const prev = fs.existsSync(new URL('../out/physics-scores.json', import.meta.url)) ? JSON.parse(fs.readFileSync(new URL('../out/physics-scores.json', import.meta.url))) : {};
fs.writeFileSync(new URL('../out/physics-scores.json', import.meta.url), JSON.stringify({ ...prev, ...results }, null, 1));
