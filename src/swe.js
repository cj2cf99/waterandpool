// 二维浅水方程求解器（纯 JS，无 DOM 依赖，可在 Node 和 Worker 中运行）
// 方法：有限体积 + 静水重构(Audusse 2004，保证静水平衡与干湿边界水深非负) + HLL 通量
//       + MUSCL 二阶（minmod 限制器，干湿前沿处退化为一阶）+ Heun(SSP-RK2) 时间积分
// 变量：h 水深(m)，q=h·u，r=h·v（m²/s），b 床面高程（海平面为 0，水下为负）。
// 坐标：i 沿 x（向东，岸在东侧），j 沿 y。
export const G = 9.81;
const PAD = 2;

const minmod3 = (a, b, c) => {
  if (a > 0 && b > 0 && c > 0) return Math.min(a, b, c);
  if (a < 0 && b < 0 && c < 0) return Math.max(a, b, c);
  return 0;
};

// HLL 通量：法向速度 u，切向速度 v。输出写入 out[0..2]
function hll(hL, uL, vL, hR, uR, vR, g, out) {
  if (hL <= 0 && hR <= 0) { out[0] = out[1] = out[2] = 0; return; }
  const cL = Math.sqrt(g * hL), cR = Math.sqrt(g * hR);
  let sL, sR;
  if (hL <= 0) { sL = uR - 2 * cR; sR = uR + cR; }
  else if (hR <= 0) { sL = uL - cL; sR = uL + 2 * cL; }
  else {
    const sq = Math.sqrt(hL), sr = Math.sqrt(hR);
    const ub = (sq * uL + sr * uR) / (sq + sr);
    const cb = Math.sqrt(0.5 * g * (hL + hR));
    sL = Math.min(uL - cL, ub - cb);
    sR = Math.max(uR + cR, ub + cb);
  }
  const f0L = hL * uL, f1L = hL * uL * uL + 0.5 * g * hL * hL, f2L = hL * uL * vL;
  const f0R = hR * uR, f1R = hR * uR * uR + 0.5 * g * hR * hR, f2R = hR * uR * vR;
  if (sL >= 0) { out[0] = f0L; out[1] = f1L; out[2] = f2L; return; }
  if (sR <= 0) { out[0] = f0R; out[1] = f1R; out[2] = f2R; return; }
  const inv = 1 / (sR - sL), ss = sL * sR;
  out[0] = (sR * f0L - sL * f0R + ss * (hR - hL)) * inv;
  out[1] = (sR * f1L - sL * f1R + ss * (hR * uR - hL * uL)) * inv;
  out[2] = (sR * f2L - sL * f2R + ss * (hR * vR - hL * vL)) * inv;
}

export class SWE {
  /**
   * @param {object} o
   * @param {number} o.nx @param {number} o.ny @param {number} o.dx 网格间距(m)
   * @param {Float64Array|Float32Array} o.bed 床面高程，nx*ny，行优先
   */
  constructor(o) {
    this.nx = o.nx; this.ny = o.ny; this.dx = o.dx; this.dy = o.dx;
    this.g = o.g ?? G;
    this.cfl = o.cfl ?? 0.4;
    this.manning = o.manning ?? 0.025;
    this.hdry = o.hdry ?? 1e-4;       // 小于此水深视为干
    this.hslope = o.hslope ?? 0.01;   // 小于此水深处斜率置零（一阶）
    this.epsH = o.epsH ?? 0.004;      // 速度去奇异化尺度
    this.theta = o.theta ?? 1.3;
    this.W = this.nx + 2 * PAD; this.H = this.ny + 2 * PAD; this.N = this.W * this.H;
    const N = this.N;
    const F = () => new Float64Array(N);
    this.b = F(); this.h = F(); this.q = F(); this.r = F();
    this.h1 = F(); this.q1 = F(); this.r1 = F();
    this.dh = F(); this.dq = F(); this.dr = F();
    this.u = F(); this.v = F(); this.eta = F();
    this.sex = F(); this.sey = F(); this.sux = F(); this.suy = F(); this.svx = F(); this.svy = F();
    this.fxh = F(); this.fxqL = F(); this.fxqR = F(); this.fxr = F();
    this.fyh = F(); this.fyrL = F(); this.fyrR = F(); this.fyq = F();
    this.press = F();        // 外加压力（以水柱高度 m 表示 P/(ρg)），船体等使用
    this.sponge = F();       // 海绵层阻尼系数 σ (1/s)
    this.wind = { ax: 0, ay: 0 };   // 风对水体的剪应力加速度 τ/ρw (m²/s²)
    this.west = null;        // 西边界造浪：{ eta:(t)=>m }；null 则为固壁
    this.t = 0;
    this.clippedVolume = 0;  // 因正性修正累计移除/增加的体积
    this._o = new Float64Array(3);
    this._o2 = new Float64Array(3);
    // 床面（含幽灵层，取最近内部值）
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) this.b[this.id(i, j)] = o.bed[j * this.nx + i];
    this.fillGhostBed();
    // 初始静水：海平面 0
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) { const k = this.id(i, j); this.h[k] = Math.max(0, -this.b[k]); }
    this.applyBC(this.h, this.q, this.r, 0);
  }
  id(i, j) { return (j + PAD) * this.W + (i + PAD); }

  fillGhostBed() {
    const { nx, ny, b } = this;
    for (let j = 0; j < ny; j++) for (let k = 1; k <= PAD; k++) {
      b[this.id(-k, j)] = b[this.id(k - 1, j)];
      b[this.id(nx - 1 + k, j)] = b[this.id(nx - k, j)];
    }
    for (let i = -PAD; i < nx + PAD; i++) for (let k = 1; k <= PAD; k++) {
      b[this.id(i, -k)] = b[this.id(i, k - 1)];
      b[this.id(i, ny - 1 + k)] = b[this.id(i, ny - k)];
    }
  }

  // 边界条件：东/南/北为固壁（镜像），西为 Flather 造浪/开边界或固壁
  applyBC(h, q, r, t) {
    const { nx, ny, b, g } = this;
    const id = (i, j) => this.id(i, j);
    // 西
    for (let j = 0; j < ny; j++) {
      const k0 = id(0, j);
      if (this.west) {
        const eta = this.west.eta(t, (j + 0.5) * this.dy);
        const h0 = Math.max(h[k0], 1e-3);
        const c = Math.sqrt(g / h0);
        const eta0 = h[k0] + b[k0];
        const ub = eta * c - c * (eta0 - eta);          // Flather：u_b = u_ext − √(g/h)(η − η_ext)
        for (let k = 1; k <= PAD; k++) {
          const kg = id(-k, j);
          const hg = Math.max(0, eta - b[kg]);
          h[kg] = hg; q[kg] = hg * ub; r[kg] = hg > 0 ? r[k0] : 0;
        }
      } else {
        for (let k = 1; k <= PAD; k++) { const kg = id(-k, j), ki = id(k - 1, j); h[kg] = h[ki]; q[kg] = -q[ki]; r[kg] = r[ki]; }
      }
      for (let k = 1; k <= PAD; k++) { const kg = id(nx - 1 + k, j), ki = id(nx - k, j); h[kg] = h[ki]; q[kg] = -q[ki]; r[kg] = r[ki]; }
    }
    for (let i = -PAD; i < nx + PAD; i++) for (let k = 1; k <= PAD; k++) {
      let kg = id(i, -k), ki = id(i, k - 1); h[kg] = h[ki]; q[kg] = q[ki]; r[kg] = -r[ki];
      kg = id(i, ny - 1 + k); ki = id(i, ny - k); h[kg] = h[ki]; q[kg] = q[ki]; r[kg] = -r[ki];
    }
  }

  // 计算 RHS：dh,dq,dr（仅内部单元）。输入 h,q,r 必须已施加边界条件。
  rhs(h, q, r, dh, dq, dr) {
    const { nx, ny, W, g, b, u, v, eta, epsH, hdry, hslope, theta, dx, dy } = this;
    const { sex, sey, sux, suy, svx, svy } = this;
    const e2 = epsH * epsH;
    // 1) 原始变量（含一圈外的幽灵层）
    for (let j = -PAD; j < ny + PAD; j++) {
      let k = this.id(-PAD, j);
      for (let i = -PAD; i < nx + PAD; i++, k++) {
        const hh = h[k];
        eta[k] = hh + b[k];
        if (hh > hdry) { const f = 2 * hh / (hh * hh + Math.max(hh * hh, e2)); u[k] = q[k] * f; v[k] = r[k] * f; }
        else { u[k] = 0; v[k] = 0; }
      }
    }
    // 2) 限制斜率（-1..n 范围，需要 ±1 邻居）
    for (let j = -1; j <= ny; j++) {
      let k = this.id(-1, j);
      for (let i = -1; i <= nx; i++, k++) {
        const hc = h[k];
        if (hc < hslope) { sex[k] = sey[k] = sux[k] = suy[k] = svx[k] = svy[k] = 0; continue; }
        // x
        if (h[k - 1] < hslope || h[k + 1] < hslope) { sex[k] = 0; sux[k] = 0; svx[k] = 0; }
        else {
          let a = eta[k] - eta[k - 1], c = eta[k + 1] - eta[k];
          sex[k] = minmod3(theta * a, 0.5 * (a + c), theta * c);
          a = u[k] - u[k - 1]; c = u[k + 1] - u[k];
          sux[k] = minmod3(theta * a, 0.5 * (a + c), theta * c);
          a = v[k] - v[k - 1]; c = v[k + 1] - v[k];
          svx[k] = minmod3(theta * a, 0.5 * (a + c), theta * c);
        }
        // y
        if (h[k - W] < hslope || h[k + W] < hslope) { sey[k] = 0; suy[k] = 0; svy[k] = 0; }
        else {
          let a = eta[k] - eta[k - W], c = eta[k + W] - eta[k];
          sey[k] = minmod3(theta * a, 0.5 * (a + c), theta * c);
          a = u[k] - u[k - W]; c = u[k + W] - u[k];
          suy[k] = minmod3(theta * a, 0.5 * (a + c), theta * c);
          a = v[k] - v[k - W]; c = v[k + W] - v[k];
          svy[k] = minmod3(theta * a, 0.5 * (a + c), theta * c);
        }
      }
    }
    // 3) x 方向界面通量：界面 (i+1/2, j)，左单元 k，右单元 k+1
    const o = this._o;
    for (let j = 0; j < ny; j++) {
      let k = this.id(-1, j);
      for (let i = -1; i < nx; i++, k++) {
        const kr = k + 1;
        const bL = b[k], bR = b[kr];
        let etaL = eta[k] + 0.5 * sex[k], etaR = eta[kr] - 0.5 * sex[kr];
        let hL = etaL - bL; if (hL < 0) hL = 0;
        let hR = etaR - bR; if (hR < 0) hR = 0;
        const uL = u[k] + 0.5 * sux[k], vL = v[k] + 0.5 * svx[k];
        const uR = u[kr] - 0.5 * sux[kr], vR = v[kr] - 0.5 * svx[kr];
        const zmax = bL > bR ? bL : bR;
        let hLs = hL + bL - zmax; if (hLs < 0) hLs = 0;
        let hRs = hR + bR - zmax; if (hRs < 0) hRs = 0;
        hll(hLs, uL, vL, hRs, uR, vR, g, o);
        this.fxh[k] = o[0];
        this.fxqL[k] = o[1] + 0.5 * g * (hL * hL - hLs * hLs);
        this.fxqR[k] = o[1] + 0.5 * g * (hR * hR - hRs * hRs);
        this.fxr[k] = o[2];
      }
    }
    // 4) y 方向界面通量：界面 (i, j+1/2)，下单元 k，上单元 k+W；法向速度为 v，切向为 u
    for (let j = -1; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) {
        const kr = k + W;
        const bL = b[k], bR = b[kr];
        let etaL = eta[k] + 0.5 * sey[k], etaR = eta[kr] - 0.5 * sey[kr];
        let hL = etaL - bL; if (hL < 0) hL = 0;
        let hR = etaR - bR; if (hR < 0) hR = 0;
        const vL = v[k] + 0.5 * svy[k], uL = u[k] + 0.5 * suy[k];
        const vR = v[kr] - 0.5 * svy[kr], uR = u[kr] - 0.5 * suy[kr];
        const zmax = bL > bR ? bL : bR;
        let hLs = hL + bL - zmax; if (hLs < 0) hLs = 0;
        let hRs = hR + bR - zmax; if (hRs < 0) hRs = 0;
        hll(hLs, vL, uL, hRs, vR, uR, g, o);
        this.fyh[k] = o[0];
        this.fyrL[k] = o[1] + 0.5 * g * (hL * hL - hLs * hLs);
        this.fyrR[k] = o[1] + 0.5 * g * (hR * hR - hRs * hRs);
        this.fyq[k] = o[2];
      }
    }
    // 5) 汇总 + 外压力梯度源项
    const { fxh, fxqL, fxqR, fxr, fyh, fyrL, fyrR, fyq, press } = this;
    const idx = 1 / dx, idy = 1 / dy;
    for (let j = 0; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) {
        dh[k] = -(fxh[k] - fxh[k - 1]) * idx - (fyh[k] - fyh[k - W]) * idy;
        let sq = -(fxqL[k] - fxqR[k - 1]) * idx - (fyq[k] - fyq[k - W]) * idy;
        let sr = -(fxr[k] - fxr[k - 1]) * idx - (fyrL[k] - fyrR[k - W]) * idy;
        const hh = h[k];
        if (hh > hdry) {
          sq -= g * hh * (press[k + 1] - press[k - 1]) * 0.5 * idx;
          sr -= g * hh * (press[k + W] - press[k - W]) * 0.5 * idy;
        }
        dq[k] = sq; dr[k] = sr;
      }
    }
  }

  maxSpeed() {
    const { nx, ny, h, q, r, g, hdry, epsH } = this;
    let m = 1e-6;
    for (let j = 0; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) {
        const hh = h[k];
        if (hh > hdry) {
          const f = 2 * hh / (hh * hh + Math.max(hh * hh, epsH * epsH));
          const s = Math.max(Math.abs(q[k]), Math.abs(r[k])) * f + Math.sqrt(g * hh);
          if (s > m) m = s;
        }
      }
    }
    return m;
  }

  stableDt() { return this.cfl * this.dx / this.maxSpeed(); }

  // 正性修正：负水深置零，薄水层动量置零
  fixPositivity(h, q, r) {
    const { nx, ny, hdry } = this;
    for (let j = 0; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) {
        if (h[k] < 0) { this.clippedVolume -= h[k] * this.dx * this.dy; h[k] = 0; }
        if (h[k] < hdry) { q[k] = 0; r[k] = 0; }
      }
    }
  }

  // 前进一个时间步 dt（≤ 稳定步长，由调用者保证）
  stepOnce(dt) {
    const { nx, ny, h, q, r, h1, q1, r1, dh, dq, dr } = this;
    const t = this.t;
    this.applyBC(h, q, r, t);
    this.rhs(h, q, r, dh, dq, dr);
    for (let j = 0; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) { h1[k] = h[k] + dt * dh[k]; q1[k] = q[k] + dt * dq[k]; r1[k] = r[k] + dt * dr[k]; }
    }
    this.fixPositivity(h1, q1, r1);
    this.applyBC(h1, q1, r1, t + dt);
    this.rhs(h1, q1, r1, dh, dq, dr);
    for (let j = 0; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) {
        h[k] = 0.5 * h[k] + 0.5 * (h1[k] + dt * dh[k]);
        q[k] = 0.5 * q[k] + 0.5 * (q1[k] + dt * dq[k]);
        r[k] = 0.5 * r[k] + 0.5 * (r1[k] + dt * dr[k]);
      }
    }
    this.fixPositivity(h, q, r);
    this.postSource(dt);
    this.t += dt;
  }

  // 算子分裂：底摩擦(Manning，隐式)、风应力、海绵层
  postSource(dt) {
    const { nx, ny, h, q, r, hdry, manning, g, wind, sponge, b } = this;
    const n2g = manning * manning * g;
    const wx = wind.ax * dt, wy = wind.ay * dt;
    for (let j = 0; j < ny; j++) {
      let k = this.id(0, j);
      for (let i = 0; i < nx; i++, k++) {
        const hh = h[k];
        if (hh <= hdry) continue;
        // 风应力：水很浅（< 2cm）时逐渐不作用
        const wf = hh < 0.02 ? hh / 0.02 : 1;
        let qq = q[k] + wx * wf, rr = r[k] + wy * wf;
        const sp = sponge[k];
        if (sp > 0) {
          const dmp = Math.exp(-sp * dt); qq *= dmp; rr *= dmp;
          const ht = Math.max(0, -b[k]);
          h[k] += (ht - hh) * (1 - dmp);
        }
        const sp2 = Math.sqrt(qq * qq + rr * rr);
        const hh43 = Math.pow(Math.max(hh, 0.002), 4 / 3);
        const fr = 1 / (1 + dt * n2g * (sp2 / hh) / hh43);
        q[k] = qq * fr; r[k] = rr * fr;
      }
    }
  }

  // 前进 T 秒（自动分步），返回步数
  advance(T, maxSteps = 100000) {
    let rem = T, n = 0;
    while (rem > 1e-9 && n < maxSteps) {
      this.applyBC(this.h, this.q, this.r, this.t);
      let dt = this.stableDt();
      if (dt > rem) dt = rem;
      this.stepOnce(dt);
      rem -= dt; n++;
    }
    return n;
  }

  totalVolume() {
    let s = 0;
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) s += this.h[this.id(i, j)];
    return s * this.dx * this.dy;
  }
  etaAt(i, j) { const k = this.id(i, j); return this.h[k] > this.hdry ? this.h[k] + this.b[k] : NaN; }
  setWind(Ux, Uy, cdFn) {
    const sp = Math.hypot(Ux, Uy);
    const cd = cdFn ? cdFn(sp) : windDrag(sp);
    const k = (1.225 / 1000) * cd * sp; // τ/ρw = (ρa/ρw) Cd |U| U
    this.wind.ax = k * Ux; this.wind.ay = k * Uy;
  }
}

// 风阻系数（Wu 1982 的简化形式：Cd = (0.8 + 0.065 U10)×1e-3，限幅）
export function windDrag(U) { return Math.min(2.6e-3, (0.8 + 0.065 * U) * 1e-3); }
