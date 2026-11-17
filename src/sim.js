// 仿真主类：浅水求解器 + 风/造浪 + 小木船 + 泡沫/湿沙/水花粒子。纯 JS，Worker 与 Node 通用。
import { SWE, G } from './swe.js';
import { DOMAIN, makeBed, bedHeight, rockMask, ROCKS } from './terrain.js';
import { WaveMaker, swellParams, swellDirFactor, chopSpectrum, windVector } from './waves.js';
import { Boat, RHO } from './boat.js';

const MAX_SPRAY = 24000;

export class Simulation {
  constructor(o = {}) {
    const scale = o.scale ?? 1;                       // 网格缩放（画质档）：1=192×128, 0.67≈128×86, 1.33≈256×171
    this.nx = Math.round(DOMAIN.nx * scale); this.ny = Math.round(DOMAIN.ny * scale);
    this.dx = DOMAIN.dx / scale;
    const { nx, ny, dx } = this;
    this.swe = new SWE({ nx, ny, dx, bed: makeBed(nx, ny, dx), cfl: o.cfl ?? 0.5, manning: 0.025 });
    const s = this.swe;
    // 南北海绵层
    const sw = Math.round(8 * scale);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const dj = Math.min(j, ny - 1 - j);
      s.sponge[s.id(i, j)] = dj < sw ? 3.0 * Math.pow(1 - dj / sw, 2) : 0;
    }
    // 造浪器（西边界）
    this.maker = new WaveMaker({ depth: 0.9, ny, dx });
    s.west = { eta: (t, y) => this.maker.eta(t, y) };
    // 风
    this.U = 0; this.dirDeg = 0; this.Ugust = 0; this.gust = 0; this.rng = 12345;
    this.windMode = o.windMode ?? 'gusty';
    this.windOnWater = o.windOnWater ?? true;
    this.setWind(o.U ?? 4, o.dirDeg ?? 15);
    // 船
    this.boat = new Boat({ bedAt: bedHeight, pos: [13.6, 9.2, -0.1], yaw: Math.PI * 0.85, anchor: [10.2, 8.2, 4.8] });
    this.rope = this.boat.rope;
    this.settleBoat();
    // 场
    const N = nx * ny;
    this.foam = new Float32Array(N); this.foam2 = new Float32Array(N);
    this.wet = new Float32Array(N);
    this.rock = new Float32Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) this.rock[j * nx + i] = rockMask((i + 0.5) * dx, (j + 0.5) * dx);
    // 水花粒子
    this.sp = { n: 0, x: new Float32Array(MAX_SPRAY), y: new Float32Array(MAX_SPRAY), z: new Float32Array(MAX_SPRAY), vx: new Float32Array(MAX_SPRAY), vy: new Float32Array(MAX_SPRAY), vz: new Float32Array(MAX_SPRAY), age: new Float32Array(MAX_SPRAY), life: new Float32Array(MAX_SPRAY), size: new Float32Array(MAX_SPRAY) };
    this.stats = { sprayEmitted: 0, rockSprayEmitted: 0, steps: 0, maxRunupX: 0, time: 0 };
    this.rockCells = []; // 供检测使用：被识别为"岩石"的单元
    this.time = 0;
    this.chop = chopSpectrum(0.5, 0);
    this.chopPhase = new Float32Array(28);
    this.updateChop(0);
    // 用 24 秒预热，让初始波场已建立（可选）
    if (o.warm) this.step(o.warm);
  }

  rnd() { this.rng = (this.rng * 1664525 + 1013904223) >>> 0; return this.rng / 4294967296; }

  setWind(U, dirDeg) {
    this.Ubase = U; this.dirDeg = dirDeg;
    const sw = swellParams(U);
    const f = swellDirFactor(dirDeg);
    this.maker.setTarget(sw.Hs * f + 0.008, sw.Tp);
    this._applyWindStress(U);
  }
  _applyWindStress(Ueff) {
    this.U = Ueff;
    if (this.windOnWater) { const [wx, wy] = windVector(Ueff, this.dirDeg); this.swe.setWind(wx, wy); } else this.swe.setWind(0, 0);
  }
  updateChop(dt) {
    const c = chopSpectrum(Math.max(this.U, 0.4), this.dirDeg * Math.PI / 180);
    this.chop = c;
    for (let i = 0; i < 28; i++) this.chopPhase[i] = (this.chopPhase[i] + c.omega[i] * dt) % (2 * Math.PI * 1000);
  }

  settleBoat() {
    // 把船放到静水平衡位置附近（先用质心高度找浮力平衡）
    const b = this.boat;
    const water = { eta: () => 0, vel: () => [0, 0], w: () => 0 };
    for (let k = 0; k < 4000; k++) b.step(0.005, water);
  }

  // —— 采样器（船用）——
  _bil(arr, x, y, pad = true) {
    const { nx, ny, dx, swe } = this;
    let fx = x / dx - 0.5, fy = y / dx - 0.5;
    fx = Math.max(0, Math.min(nx - 1.001, fx)); fy = Math.max(0, Math.min(ny - 1.001, fy));
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const k = swe.id(i, j), W = swe.W;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + W] * (1 - tx) + arr[k + W + 1] * tx) * ty;
  }
  etaAt(x, y) {
    const { swe } = this; const { nx, ny, dx } = this;
    let fx = x / dx - 0.5, fy = y / dx - 0.5;
    fx = Math.max(0, Math.min(nx - 1.001, fx)); fy = Math.max(0, Math.min(ny - 1.001, fy));
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const k = swe.id(i, j), W = swe.W;
    const e = (kk) => (swe.h[kk] > swe.hdry ? swe.h[kk] + swe.b[kk] : swe.b[kk]);
    return (e(k) * (1 - tx) + e(k + 1) * tx) * (1 - ty) + (e(k + W) * (1 - tx) + e(k + W + 1) * tx) * ty;
  }
  velAt(x, y) {
    const { swe } = this; const { nx, ny, dx } = this;
    let fx = x / dx - 0.5, fy = y / dx - 0.5;
    fx = Math.max(0, Math.min(nx - 1.001, fx)); fy = Math.max(0, Math.min(ny - 1.001, fy));
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const k = swe.id(i, j), W = swe.W;
    const uu = (kk) => (swe.h[kk] > 0.01 ? swe.q[kk] / swe.h[kk] : 0), vv = (kk) => (swe.h[kk] > 0.01 ? swe.r[kk] / swe.h[kk] : 0);
    const bl = (f) => (f(k) * (1 - tx) + f(k + 1) * tx) * (1 - ty) + (f(k + W) * (1 - tx) + f(k + W + 1) * tx) * ty;
    return [bl(uu), bl(vv)];
  }
  _sampler() {
    if (this._smp) return this._smp;
    this._smp = {
      eta: (x, y) => this.etaAt(x, y) + this._bil(this.swe.press, x, y),     // 测压水位 = 水面 + 压强水头
      vel: (x, y) => this.velAt(x, y),
      w: (x, y) => this._bil(this.swe.dh, x, y),
    };
    return this._smp;
  }
  _pressFromBoat(dt) {
    const { swe, dx } = this; swe.press.fill(0);
    const f = this.boat.forces; if (!f) return;
    // 低通：只让静重量与慢变化反馈给水体（τ=0.5 s），避免高频耦合振荡
    const a = 1 - Math.exp(-dt / 0.5);
    if (!this._pf) this._pf = new Float64Array(f.length);
    if (this._pf.length !== f.length) this._pf = new Float64Array(f.length);
    for (let n = 0; n < f.length; n++) { this._pf[n] += (f[n].F - this._pf[n]) * a; }
    const cell = dx * dx * RHO * G / Math.min(1, this.time / 3 + 0.0);   // 开头 3 s 缓升，避免启动瞬态（水面按静压准静态调整）
    if (this.time <= 0) return;
    for (let n = 0; n < f.length; n++) {
      const c = { x: f[n].x, y: f[n].y, F: this._pf[n] };
      let fx = c.x / dx - 0.5, fy = c.y / dx - 0.5;
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      if (i < 0 || j < 0 || i >= this.nx - 1 || j >= this.ny - 1) continue;
      const w = c.F / cell, k = swe.id(i, j), W = swe.W;
      swe.press[k] += w * (1 - tx) * (1 - ty); swe.press[k + 1] += w * tx * (1 - ty); swe.press[k + W] += w * (1 - tx) * ty; swe.press[k + W + 1] += w * tx * ty;
    }
  }

  // —— 主步进：dtFrame 秒 ——
  step(dtFrame) {
    if (dtFrame > 1 / 30 + 1e-9) {          // 大步长拆成 ≤1/30 s 的帧，保证泡沫/水花/阵风按帧更新
      let r = dtFrame; while (r > 1e-9) { const d = Math.min(r, 1 / 30); this._stepFrame(d); r -= d; } return;
    }
    this._stepFrame(dtFrame);
  }
  _stepFrame(dtFrame) {
    const s = this.swe; let rem = dtFrame, n = 0;
    // 阵风（OU 过程，时间常数 4 s，幅度 ~22%）
    if (this.windMode === 'gusty') {
      const a = Math.exp(-dtFrame / 4);
      this.gust = this.gust * a + Math.sqrt(1 - a * a) * (this.rnd() + this.rnd() + this.rnd() - 1.5) * 1.2;
    } else this.gust = 0;
    this._applyWindStress(Math.max(0, this.Ubase * (1 + 0.22 * this.gust)));
    const smp = this._sampler();
    while (rem > 1e-9) {
      s.applyBC(s.h, s.q, s.r, s.t);
      s.updateActive();
      let dt = Math.min(s.stableDt(), rem, 0.02);
      this.maker.update(dt);
      this._pressFromBoat(dt);
      this.boat.step(dt, smp);
      s.stepOnce(dt);
      rem -= dt; n++;
    }
    this.stats.steps += n;
    this.time += dtFrame; this.stats.time = this.time;
    this.updateChop(dtFrame);
    this._fields(dtFrame);
    this._sprayStep(dtFrame);
  }

  // —— 泡沫 / 湿沙 ——
  _fields(dt) {
    const { nx, ny, dx, swe: s } = this; const g = G, W = s.W;
    const foam = this.foam, out = this.foam2, wet = this.wet, rock = this.rock;
    const h = s.h, b = s.b, q = s.q, r = s.r;
    const dryDecay = Math.exp(-dt / 45);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = s.id(i, j), c = j * nx + i, hh = h[k];
        if (hh > 0.003) wet[c] = 1; else wet[c] *= dryDecay;
        let src = 0;
        if (hh > 0.012) {
          const u = q[k] / Math.max(hh, 0.012), v = r[k] / Math.max(hh, 0.012);
          const sp = Math.hypot(u, v), Fr = sp / Math.sqrt(g * hh);
          const ex = (h[k + 1] + b[k + 1] - h[k - 1] - b[k - 1]) / (2 * dx), ey = (h[k + W] + b[k + W] - h[k - W] - b[k - W]) / (2 * dx);
          const slope = Math.hypot(ex, ey);
          if (hh < 0.7 && slope > 0.17) src += (slope - 0.17) * 3.2;
          if (Fr > 0.7 && hh < 0.7) src += (Fr - 0.7) * 3.0;
          // 浪舌与回流边缘（薄水层 + 邻近干点 + 有流速）
          if (hh < 0.06 && sp > 0.18 && (h[k + 1] < 0.002 || h[k - 1] < 0.002 || h[k + W] < 0.002 || h[k - W] < 0.002)) src += 0.9 * sp;
          // 石头周围
          if (sp > 0.35 && (rock[c] > 0.3 || (i > 0 && rock[c - 1] > 0.5) || (i < nx - 1 && rock[c + 1] > 0.5) || (j > 0 && rock[c - nx] > 0.5) || (j < ny - 1 && rock[c + nx] > 0.5))) src += 1.6 * sp;
          // 船体周围
          if (s.press[k] > 0.001 && sp > 0.15) src += 0.8 * sp;
        }
        let f = foam[c] + src * dt;
        // 半拉格朗日平流
        if (hh > 0.01 && f > 0.001) {
          // 用上一时刻值做回溯（简化：直接在 out 中累积）
        }
        out[c] = f;
      }
    }
    // 平流 + 衰减
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = s.id(i, j), c = j * nx + i, hh = h[k];
        if (hh < 0.004) { foam[c] = out[c] * Math.exp(-dt / 0.35); continue; }
        const u = q[k] / Math.max(hh, 0.02), v = r[k] / Math.max(hh, 0.02);
        const sx = Math.max(0, Math.min(nx - 1.001, i - u * dt / dx)), sy = Math.max(0, Math.min(ny - 1.001, j - v * dt / dx));
        const i0 = Math.floor(sx), j0 = Math.floor(sy), tx = sx - i0, ty = sy - j0, c0 = j0 * nx + i0;
        let f = (out[c0] * (1 - tx) + out[c0 + 1] * tx) * (1 - ty) + (out[c0 + nx] * (1 - tx) + out[c0 + nx + 1] * tx) * ty;
        const tau = hh > 0.2 ? 3.2 : (hh > 0.05 ? 4.5 : 5.5);
        f *= Math.exp(-dt / tau);
        foam[c] = Math.min(1.6, f);
      }
    }
  }

  // —— 水花粒子 ——
  _emit(x, y, z, vx, vy, vz, size, life) {
    const p = this.sp; if (p.n >= MAX_SPRAY) return;
    const n = p.n++;
    p.x[n] = x; p.y[n] = y; p.z[n] = z; p.vx[n] = vx; p.vy[n] = vy; p.vz[n] = vz; p.age[n] = 0; p.life[n] = life; p.size[n] = size;
    this.stats.sprayEmitted++;
  }
  _sprayStep(dt) {
    const { nx, ny, dx, swe: s } = this; const g = G, W = s.W;
    const rock = this.rock;
    // 发射：石头撞击 + 破碎浪尖
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = s.id(i, j), c = j * nx + i, hh = s.h[k];
        if (hh < 0.02) continue;
        const u = s.q[k] / hh, v = s.r[k] / hh, sp = Math.hypot(u, v);
        if (sp < 0.5) continue;
        // 邻近岩石：法线（指向岩石）
        let nxo = 0, nyo = 0;
        if (rock[c + 1] > 0.5) nxo += 1; if (rock[c - 1] > 0.5) nxo -= 1; if (rock[c + nx] > 0.5) nyo += 1; if (rock[c - nx] > 0.5) nyo -= 1;
        const nl = Math.hypot(nxo, nyo);
        let I = 0;
        if (nl > 0) { nxo /= nl; nyo /= nl; I = Math.max(0, u * nxo + v * nyo); }
        const x0 = (i + 0.5) * dx, y0 = (j + 0.5) * dx, zs = hh + s.b[k];
        if (I > 0.5) {
          const rate = Math.min(1400, 260 * I * I * (0.5 + Math.min(hh, 0.4)));            // 个/秒
          let nEmit = rate * dt; nEmit = Math.floor(nEmit) + (this.rnd() < nEmit % 1 ? 1 : 0);
          for (let m = 0; m < nEmit; m++) {
            const out = 0.15 + 0.5 * this.rnd();
            const vz = (1.1 + 0.9 * this.rnd()) * (0.8 + 0.7 * I) + 0.5;
            this._emit(x0 - nxo * dx * 0.3 + (this.rnd() - 0.5) * dx, y0 - nyo * dx * 0.3 + (this.rnd() - 0.5) * dx, zs + 0.05, -nxo * out * I + (this.rnd() - 0.5) * 0.8 * I + u * 0.15, -nyo * out * I + (this.rnd() - 0.5) * 0.8 * I + v * 0.15, vz, 0.008 + 0.022 * this.rnd(), 1.7);
            this.stats.rockSprayEmitted++;
          }
        }
        // 破碎/浪舌高速处的细小飞沫
        const Fr = sp / Math.sqrt(g * hh);
        if (Fr > 0.95 && hh < 0.5 && this.foam[c] > 0.5) {
          let nEmit = 30 * (Fr - 0.9) * dt; nEmit = Math.floor(nEmit) + (this.rnd() < nEmit % 1 ? 1 : 0);
          for (let m = 0; m < nEmit; m++) this._emit(x0 + (this.rnd() - 0.5) * dx, y0 + (this.rnd() - 0.5) * dx, zs + 0.03, u * 0.4 + (this.rnd() - 0.5) * 0.6, v * 0.4 + (this.rnd() - 0.5) * 0.6, 0.5 + 0.9 * this.rnd(), 0.006 + 0.012 * this.rnd(), 1.0);
        }
      }
    }
    // 积分
    const p = this.sp; let w = 0;
    for (let n = 0; n < p.n; n++) {
      p.age[n] += dt;
      if (p.age[n] > p.life[n]) continue;
      p.vz[n] -= g * dt; const dr = Math.exp(-0.6 * dt); p.vx[n] *= dr; p.vy[n] *= dr; p.vz[n] *= Math.exp(-0.15 * dt);
      p.x[n] += p.vx[n] * dt; p.y[n] += p.vy[n] * dt; p.z[n] += p.vz[n] * dt;
      const x = p.x[n], y = p.y[n];
      if (x < 0 || y < 0 || x > nx * dx || y > ny * dx) continue;
      const zw = this.etaAt(x, y);
      if (p.z[n] < zw && p.vz[n] < 0) {      // 落水：留下少量泡沫
        const c = Math.min(ny - 1, Math.floor(y / dx)) * nx + Math.min(nx - 1, Math.floor(x / dx));
        this.foam[c] = Math.min(1.6, this.foam[c] + 0.035);
        continue;
      }
      if (w !== n) { p.x[w] = p.x[n]; p.y[w] = p.y[n]; p.z[w] = p.z[n]; p.vx[w] = p.vx[n]; p.vy[w] = p.vy[n]; p.vz[w] = p.vz[n]; p.age[w] = p.age[n]; p.life[w] = p.life[n]; p.size[w] = p.size[n]; }
      w++;
    }
    p.n = w;
  }

  // —— 快照（渲染用，Float32）——
  snapshot(out = {}) {
    const { nx, ny, swe: s } = this; const N = nx * ny;
    out.nx = nx; out.ny = ny; out.dx = this.dx; out.time = this.time;
    out.eta = out.eta || new Float32Array(N); out.depth = out.depth || new Float32Array(N);
    out.foam = out.foam || new Float32Array(N); out.wet = out.wet || new Float32Array(N);
    out.vel = out.vel || new Float32Array(N * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = s.id(i, j), c = j * nx + i, hh = s.h[k];
      out.depth[c] = hh;
      out.eta[c] = hh > s.hdry ? hh + s.b[k] : NaN;                 // 干单元先标 NaN，下面外推水面高度
      const iv = hh > 0.02 ? 1 / hh : 0; out.vel[2 * c] = s.q[k] * iv; out.vel[2 * c + 1] = s.r[k] * iv;
    }
    // 水面高度外推：把水位向相邻干单元延伸 2 圈，渲染端用精细床面算水深 → 水边落在地形等高线上（亚格点精度）
    const e = out.eta, tmp = this._etmp || (this._etmp = new Float32Array(N));
    for (let pass = 0; pass < 2; pass++) {
      tmp.set(e);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = j * nx + i; if (!Number.isNaN(tmp[c])) continue;
        let sum = 0, n = 0;
        if (i > 0 && !Number.isNaN(tmp[c - 1])) { sum += tmp[c - 1]; n++; } if (i < nx - 1 && !Number.isNaN(tmp[c + 1])) { sum += tmp[c + 1]; n++; }
        if (j > 0 && !Number.isNaN(tmp[c - nx])) { sum += tmp[c - nx]; n++; } if (j < ny - 1 && !Number.isNaN(tmp[c + nx])) { sum += tmp[c + nx]; n++; }
        if (n) e[c] = sum / n;
      }
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const c = j * nx + i; if (Number.isNaN(e[c])) e[c] = s.b[s.id(i, j)] - 0.03; }
    out.foam.set(this.foam); out.wet.set(this.wet);
    const b = this.boat;
    out.boat = { pos: [...b.pos], q: [...b.q], rope: b.rope ? { ax: b.rope.ax, ay: b.rope.ay, az: bedHeight(b.rope.ax, b.rope.ay), len: b.rope.len, tension: b.lastRopeTension, on: b.rope.on } : null };
    const p = this.sp; out.nSpray = p.n; out.spray = out.spray || new Float32Array(MAX_SPRAY * 5);
    for (let n = 0; n < p.n; n++) { out.spray[5 * n] = p.x[n]; out.spray[5 * n + 1] = p.y[n]; out.spray[5 * n + 2] = p.z[n]; out.spray[5 * n + 3] = p.size[n]; out.spray[5 * n + 4] = 1 - p.age[n] / p.life[n]; }
    out.wind = { U: this.U, dir: this.dirDeg, vec: windVector(this.U, this.dirDeg) };
    out.chop = this.chop; out.chopPhase = this.chopPhase;
    const mk = this.maker, NM = mk.N, c = Math.sqrt(G * mk.depth);
    out.maker = { amp: new Float32Array(NM), phase: new Float32Array(NM), kx: new Float32Array(NM), ky: new Float32Array(NM) };
    for (let i = 0; i < NM; i++) { out.maker.amp[i] = mk.amp[i]; out.maker.phase[i] = mk.phase[i] % (2 * Math.PI); out.maker.ky[i] = mk.ky[i]; const k = mk.omega[i] / c; out.maker.kx[i] = Math.sqrt(Math.max(0, k * k - mk.ky[i] * mk.ky[i])); }
    out.Hs = this.maker.Hs; out.Tp = this.maker.Tp;
    return out;
  }

  // —— 交互：投石 ——
  drop(x, y, strength = 0.06, radius = 0.4) {
    const { nx, ny, dx, swe: s } = this;
    const r2 = radius * radius;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const X = (i + 0.5) * dx, Y = (j + 0.5) * dx, d2 = (X - x) ** 2 + (Y - y) ** 2;
      if (d2 > 9 * r2) continue;
      const k = s.id(i, j); if (s.h[k] < 0.05) continue;
      s.h[k] = Math.max(0, s.h[k] + strength * Math.exp(-d2 / r2));
    }
    // 水花
    for (let m = 0; m < 160; m++) { const a = this.rnd() * Math.PI * 2, sp = 0.4 + this.rnd() * 1.2; this._emit(x + Math.cos(a) * 0.05, y + Math.sin(a) * 0.05, this.etaAt(x, y) + 0.02, Math.cos(a) * sp * 0.5, Math.sin(a) * sp * 0.5, 1.6 + 1.6 * this.rnd(), 0.006 + 0.012 * this.rnd(), 1.2); }
  }
}
