// 风 → 波浪：入射涌浪（来自开阔水面，交给浅水求解器）+ 风生短波（局地风区，交给渲染/船的高频抖动）
import { G } from './swe.js';

// SMB 风区限制公式（Hs, Tp），F 为有效风区(m)
export function windSea(U, F) {
  if (U < 0.3) return { Hs: 0, Tp: 1 };
  const gF = G * F / (U * U);
  const Hs = 0.0016 * Math.sqrt(gF) * U * U / G;
  const Tp = 0.286 * Math.pow(gF, 1 / 3) * U / G;
  return { Hs, Tp };
}

// 入射涌浪（来自开阔大水面的长波，交给浅水方程）：周期取 2.4–3.7 s，保证 kh ≲ 0.7，
// 浅水方程的无色散假设误差约 6%。波高随风速经验增长，上限取破碎极限（≈0.55 倍水深）。
export function swellParams(U, depth = 0.9) {
  const Hs = Math.min(0.0062 * Math.pow(Math.max(U, 0), 1.6) + 0.012, 0.55 * depth);
  const Tp = 2.3 + 0.07 * U;
  return { Hs, Tp };
}

// 线性色散关系（给定频率求波数），水深 h
export function waveNumber(omega, h) {
  let k = omega * omega / G;
  for (let i = 0; i < 40; i++) {
    const t = Math.tanh(k * h);
    const f = G * k * t - omega * omega;
    const df = G * (t + k * h * (1 - t * t));
    const dk = f / df; k -= dk; if (Math.abs(dk) < 1e-12) break;
  }
  return k;
}

function jonswap(f, fp, gamma = 3.3) {
  const sigma = f <= fp ? 0.07 : 0.09;
  const r = Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp));
  return Math.pow(f, -5) * Math.exp(-1.25 * Math.pow(fp / f, 4)) * Math.pow(gamma, r);
}

// 西边界造浪器：多分量、略有入射角、频率相位积分（风变化时无相位跳变）
export class WaveMaker {
  constructor({ depth = 0.9, ny, dx, N = 12, seed = 7 }) {
    this.depth = depth; this.dx = dx; this.N = N;
    this.Hs = 0.02; this.Tp = 3.0; this.HsTarget = 0.02; this.TpTarget = 3.0;
    this.phase = new Float64Array(N); this.omega = new Float64Array(N); this.amp = new Float64Array(N);
    this.ky = new Float64Array(N); this.theta = new Float64Array(N);
    let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    this.phi0 = Array.from({ length: N }, () => rnd() * 2 * Math.PI);
    for (let i = 0; i < N; i++) { this.theta[i] = (22 * Math.PI / 180) * Math.sin(i * 2.399 + 0.7) * (0.4 + 0.6 * (i % 3) / 2); this.phase[i] = this.phi0[i]; }
    this._recompute();
    this.ramp = 1;
  }
  setTarget(Hs, Tp) { this.HsTarget = Hs; this.TpTarget = Math.max(1.2, Tp); }
  _recompute() {
    const { N } = this; const fp = 1 / this.Tp;
    const fs = [], S = [];
    for (let i = 0; i < N; i++) { const f = fp * Math.exp(Math.log(0.7) + (Math.log(2.2) - Math.log(0.7)) * (i + 0.5) / N); fs.push(f); }
    const df = (i) => fs[i] * (Math.log(2.2) - Math.log(0.7)) / N;
    let m0 = 0;
    for (let i = 0; i < N; i++) { S.push(jonswap(fs[i], fp) * df(i)); m0 += S[i]; }
    const target = (this.Hs / 4) ** 2;
    for (let i = 0; i < N; i++) {
      const a = Math.sqrt(2 * target * S[i] / m0);
      this.amp[i] = a;
      this.omega[i] = 2 * Math.PI * fs[i];
      const k = waveNumber(this.omega[i], this.depth);
      this.ky[i] = k * Math.sin(this.theta[i]);
    }
  }
  update(dt) {
    // 平滑跟随目标：Hs 时间常数 ~6 s，Tp ~8 s
    const a1 = 1 - Math.exp(-dt / 6), a2 = 1 - Math.exp(-dt / 8);
    this.Hs += (this.HsTarget - this.Hs) * a1; this.Tp += (this.TpTarget - this.Tp) * a2;
    this._recompute();
    for (let i = 0; i < this.N; i++) this.phase[i] += this.omega[i] * dt;
  }
  // 西边界在北向位置 y 处的入射水面高度
  eta(t, y) {
    let e = 0;
    for (let i = 0; i < this.N; i++) e += this.amp[i] * Math.sin(this.phase[i] - this.ky[i] * y);
    return e;
  }
}

// 风生短波（Gerstner 分量）：JONSWAP + 重力-毛细色散，方向在风向附近 cos^(2s) 分布
export function chopSpectrum(U, windDirRad, M = 28, Floc = 45) {
  const { Hs } = windSea(U, Floc);
  const out = { k: new Float32Array(M), dx: new Float32Array(M), dy: new Float32Array(M), amp: new Float32Array(M), omega: new Float32Array(M) };
  if (Hs < 1e-4) return out;
  const gF = G * Floc / (U * U);
  const fp = Math.max(1.0, 3.5 * (G / U) * Math.pow(gF, -0.33));         // Hz
  const sigT = 7.4e-5;
  const fs = [], S = []; let m0 = 0;
  const f0 = 0.55 * fp, f1 = 5.5 * fp;
  for (let i = 0; i < M; i++) {
    const f = f0 * Math.pow(f1 / f0, (i + 0.5) / M);
    const df = f * Math.log(f1 / f0) / M;
    // 尾部用 f^-5 → 饱和谱（k^-3 对应 f^-5 量级），JONSWAP 已含
    fs.push(f); S.push(jonswap(f, fp) * df); m0 += S[S.length - 1];
  }
  const target = (Hs / 4) ** 2;
  for (let i = 0; i < M; i++) {
    const omega = 2 * Math.PI * fs[i];
    // ω² = g k + σ k³ 求 k（牛顿）
    let k = omega * omega / G;
    for (let it = 0; it < 30; it++) { const f = G * k + sigT * k * k * k - omega * omega, df = G + 3 * sigT * k * k; k -= f / df; }
    // 方向：风向 ± 随分量变化的偏角（确定性伪随机）
    const spread = 60 * Math.PI / 180;
    const u = (((i * 0.6180339887) % 1) * 2 - 1);
    const ang = windDirRad + Math.sign(u) * spread * (1 - Math.cos(Math.abs(u) * Math.PI / 2)) * 1.0;
    out.k[i] = k; out.dx[i] = Math.cos(ang); out.dy[i] = Math.sin(ang);
    let a = Math.sqrt(2 * target * S[i] / m0);
    a = Math.min(a, 0.45 / k);                                              // 陡度限制 a k ≤ 0.45
    out.amp[i] = a; out.omega[i] = omega;
  }
  return out;
}

// 风向约定：dirDeg 为"风吹向"的方向，0°=向东(+x)，90°=向北(+y)。
export function windVector(U, dirDeg) { const a = dirDeg * Math.PI / 180; return [U * Math.cos(a), U * Math.sin(a)]; }
// 朝岸（+x）方向风 → 涌浪全强；离岸风 → 仅保留 25% 背景涌浪
export function swellDirFactor(dirDeg) { const c = Math.cos(dirDeg * Math.PI / 180); return 0.25 + 0.75 * Math.pow(Math.max(0, c), 1.5); }
