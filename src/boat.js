// 小木船：刚体 + 浮力柱采样 + 水流阻力 + 船底触地 + 锚绳。
// 注意：这里没有任何"风对船"的作用力——船只受水（水面高度、水流速度、水压）影响，风只通过水起作用。
import { G } from './swe.js';

export const RHO = 1000;

// ───────── 船体几何（体坐标：+x 船首，+y 左舷，+z 向上）─────────
export const HULL = { L: 3.0, B: 0.65, mass: 105 };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function halfBeam(t) {           // t∈[-1,1]，-1 船尾，+1 船首
  if (t >= 0) return HULL.B * Math.pow(Math.max(0, 1 - Math.pow(t, 2.2)), 0.62);
  return 0.40 + 0.25 * Math.pow(Math.max(0, 1 - t * t), 0.7);
}
export function keelZ(t) { return -0.27 + 0.20 * Math.pow(Math.max(t, 0), 2.2) + 0.06 * t * t * (t < 0 ? 1 : 0); }
export function gunwaleZ(t) { return 0.16 + 0.19 * t * t; }

// 船底高度：横向偏移 y 处（|y| ≤ B(t)），超出舷则返回舷顶
export function bottomZ(x, y) {
  const t = Math.max(-1, Math.min(1, 2 * x / HULL.L));
  const B = halfBeam(t); if (B < 1e-3) return gunwaleZ(t);
  const f = Math.min(1, Math.abs(y) / B);
  const phi = Math.asin(Math.pow(f, 1 / 0.8));
  const zk = keelZ(t), zg = gunwaleZ(t);
  return zg - (zg - zk) * Math.pow(Math.cos(phi), 1.6);
}

// ───────── 四元数 / 向量小工具 ─────────
const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2], a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qnorm = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]); return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
export function qrot(q, v) {       // 用单位四元数旋转向量
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];

export class Boat {
  /**
   * @param {object} o
   * @param {(x,y)=>number} o.bedAt 床面高程
   * @param {number[]} o.pos 初始位置
   */
  constructor(o) {
    this.bedAt = o.bedAt;
    this.m = o.mass ?? HULL.mass;
    this.pos = o.pos ? [...o.pos] : [0, 0, 0];
    this.q = [1, 0, 0, 0];
    if (o.yaw) this.q = [Math.cos(o.yaw / 2), 0, 0, Math.sin(o.yaw / 2)];
    this.vel = [0, 0, 0]; this.omega = [0, 0, 0];
    const L = HULL.L, B2 = 2 * HULL.B, H = 0.5;
    // 惯量（体坐标对角，含附加质量系数）
    this.I = [this.m * (B2 * B2 + H * H) / 12 * 1.5, this.m * (L * L + H * H) / 12 * 1.4, this.m * (L * L + B2 * B2) / 12 * 1.4];
    this.I = this.I.map((v, i) => v * (i < 2 ? 3.0 : 1.5));   // 含附加转动惯量
    this.cgZ = -0.04;   // 重心（体坐标）
    // 附加质量（相对船质量的倍数）：浅吃水小艇垂荡/纵摇附加质量显著，使垂荡周期落在 ≈0.9 s（真实小艇量级）
    this.ma = { x: 0.15, y: 0.9, z: 2.2, rot: 2.0 };
    // 浮力柱
    this.cols = [];
    const NX = 16, NY = 7;
    for (let i = 0; i < NX; i++) {
      const xb = (-0.5 + (i + 0.5) / NX) * L, t = 2 * xb / L, B = halfBeam(t);
      if (B < 0.02) continue;
      const dxs = L / NX;
      for (let j = 0; j < NY; j++) {
        const f = -1 + (2 * j + 1) / NY, yb = f * B, dys = 2 * B / NY;
        this.cols.push({ xb, yb, A: dxs * dys, dxs, dys, zbot: bottomZ(xb, yb), hgt: gunwaleZ(t) - bottomZ(xb, yb) });
      }
    }
    this.Awp = this.cols.reduce((s, c) => s + c.A, 0);     // 最大水线面积（满吃水）
    this.rope = o.anchor ? { ax: o.anchor[0], ay: o.anchor[1], len: o.anchor[2] ?? 6, k: 2500, c: 500, on: true } : null;
    this.bowLocal = [HULL.L / 2 * 0.92, 0, 0.12];
    this.forces = [];       // 每步缓存：[{x,y,F}] 浮力（供水体压强反馈）
    this.lastRopeTension = 0;
    this.drift = 0;
  }

  setPose(pos, yaw = 0) { this.pos = [...pos]; this.q = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]; this.vel = [0, 0, 0]; this.omega = [0, 0, 0]; }
  worldPoint(p) { const r = qrot(this.q, p); return [this.pos[0] + r[0], this.pos[1] + r[1], this.pos[2] + r[2]]; }
  euler() {            // 返回 [roll, pitch, yaw]（弧度）
    const [w, x, y, z] = this.q;
    return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)), Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))), Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))];
  }

  /**
   * @param {number} dt
   * @param {object} water 采样器：eta(x,y)=压强修正后的水面高度；vel(x,y)=[u,v]；w(x,y)=水面垂向速度
   */
  step(dt, water) {
    const nsub = Math.max(1, Math.ceil(dt / 0.004)), h = dt / nsub;
    for (let s = 0; s < nsub; s++) this._sub(h, water, s === nsub - 1);
  }

  _sub(dt, water, record) {
    const m = this.m, g = G;
    let F = [0, 0, -m * g], T = [0, 0, 0];
    const forces = record ? [] : null;
    const Rq = this.q;
    // 阻尼系数：目标垂荡阻尼比 ζ≈0.22
    const kz = RHO * g * this.Awp, bz = 2 * 0.22 * Math.sqrt(kz * m);
    let wetCols = 0;
    for (const c of this.cols) {
      const pb = qrot(Rq, [c.xb, c.yb, c.zbot]);            // 柱底世界相对位置
      const bx = this.pos[0] + pb[0], by = this.pos[1] + pb[1], bz0 = this.pos[2] + pb[2];
      const eta = water.eta(bx, by);
      let d = eta - bz0;                                      // 浸没深度
      // 柱点速度
      const rr = qrot(Rq, [c.xb, c.yb, c.zbot - this.cgZ]);
      const vp = [this.vel[0] + this.omega[1] * rr[2] - this.omega[2] * rr[1], this.vel[1] + this.omega[2] * rr[0] - this.omega[0] * rr[2], this.vel[2] + this.omega[0] * rr[1] - this.omega[1] * rr[0]];
      const fx = [0, 0, 0];
      if (d > 0) {
        d = Math.min(d, c.hgt * 1.05);
        wetCols++;
        const up = Math.cos(0) ;   // 竖直柱
        const Fb = RHO * g * c.A * d;
        fx[2] += Fb;
        if (forces) forces.push({ x: bx, y: by, F: Fb });
        const wv = water.vel(bx, by), ww = water.w(bx, by);
        // 垂向阻尼（线性分配 + 少量二次）
        const wrel = vp[2] - ww;
        fx[2] += -bz * (c.A / this.Awp) * wrel - RHO * 0.8 * c.A * Math.abs(wrel) * wrel * 0.05;
        // 水平阻力：体坐标分解（纵向流线型小阻力，横向大阻力）
        const vrelW = [vp[0] - wv[0], vp[1] - wv[1], 0];
        const vb = qrot(qconj(Rq), vrelW);
        const Fbx = -0.5 * RHO * 0.25 * (d * c.dys + 0.1 * c.A) * Math.abs(vb[0]) * vb[0];
        const Fby = -0.5 * RHO * 1.1 * (d * c.dxs) * Math.abs(vb[1]) * vb[1];
        const Fh = qrot(Rq, [Fbx, Fby, 0]);
        fx[0] += Fh[0] - 45 * (c.A / this.Awp) * vrelW[0]; fx[1] += Fh[1] - 45 * (c.A / this.Awp) * vrelW[1];   // 线性项：水的黏性阻尼
      }
      // 触地（船底低于床面）：弹簧阻尼 + 摩擦
      const bed = this.bedAt(bx, by);
      const pen = bed - bz0;
      if (pen > 0) {
        const Fn = c.A * 3.0e4 * Math.min(pen, 0.15) - 0.4 * c.A * 1.0e4 * Math.min(0, vp[2]) * 0 + (-vp[2] * c.A * 4000 * (vp[2] < 0 ? 1 : 0.2));
        fx[2] += Math.max(0, Fn);
        const sp = Math.hypot(vp[0], vp[1]);
        const mu = 0.45 * Math.max(0, Fn) * Math.tanh(sp / 0.05) / (sp + 1e-9);
        fx[0] -= mu * vp[0]; fx[1] -= mu * vp[1];
      }
      // 累计力与力矩
      F[0] += fx[0]; F[1] += fx[1]; F[2] += fx[2];
      T[0] += rr[1] * fx[2] - rr[2] * fx[1]; T[1] += rr[2] * fx[0] - rr[0] * fx[2]; T[2] += rr[0] * fx[1] - rr[1] * fx[0];
    }
    // 锚绳（仅受拉）
    this.lastRopeTension = 0;
    if (this.rope && this.rope.on) {
      const bp = this.worldPoint(this.bowLocal);
      const ax = this.rope.ax, ay = this.rope.ay, az = this.bedAt(ax, ay);
      const dx = bp[0] - ax, dy = bp[1] - ay, dz = bp[2] - az, dist = Math.hypot(dx, dy, dz);
      if (dist > this.rope.len) {
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;
        const rr = qrot(Rq, [this.bowLocal[0], this.bowLocal[1], this.bowLocal[2] - this.cgZ]);
        const vp = [this.vel[0] + this.omega[1] * rr[2] - this.omega[2] * rr[1], this.vel[1] + this.omega[2] * rr[0] - this.omega[0] * rr[2], this.vel[2] + this.omega[0] * rr[1] - this.omega[1] * rr[0]];
        const vn = vp[0] * nx + vp[1] * ny + vp[2] * nz;
        let Ft = this.rope.k * (dist - this.rope.len) + this.rope.c * Math.max(0, vn);
        Ft = Math.min(Math.max(0, Ft), 4000);
        const f = [-Ft * nx, -Ft * ny, -Ft * nz];
        F[0] += f[0]; F[1] += f[1]; F[2] += f[2];
        T[0] += rr[1] * f[2] - rr[2] * f[1]; T[1] += rr[2] * f[0] - rr[0] * f[2]; T[2] += rr[0] * f[1] - rr[1] * f[0];
        this.lastRopeTension = Ft;
      }
    }
    // 积分：平动
    // 平动：水平力在"船首向"坐标系（仅偏航）内分解，纵向/横向用各自的有效质量；垂向单独处理
    const yaw = this.euler()[2], cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fL = F[0] * cy + F[1] * sy, fT = -F[0] * sy + F[1] * cy;
    const aL = fL / (m * (1 + this.ma.x)), aT = fT / (m * (1 + this.ma.y));
    this.vel[0] += (aL * cy - aT * sy) * dt; this.vel[1] += (aL * sy + aT * cy) * dt;
    this.vel[2] += (F[2] / (m * (1 + this.ma.z))) * dt;
    for (let k = 0; k < 3; k++) this.pos[k] += this.vel[k] * dt;
    // 转动：体坐标欧拉方程
    const Tb = qrot(qconj(Rq), T);
    const wb = qrot(qconj(Rq), this.omega);
    const I = this.I;
    const dwb = [(Tb[0] - (I[2] - I[1]) * wb[1] * wb[2]) / I[0], (Tb[1] - (I[0] - I[2]) * wb[2] * wb[0]) / I[1], (Tb[2] - (I[1] - I[0]) * wb[0] * wb[1]) / I[2]];
    const wb2 = [wb[0] + dwb[0] * dt, wb[1] + dwb[1] * dt, wb[2] + dwb[2] * dt];
    // 额外的转动阻尼（空气和附加质量引起的小阻尼，避免数值抖动）
    const damp = Math.exp(-0.15 * dt);
    this.omega = qrot(Rq, [wb2[0] * damp, wb2[1] * damp, wb2[2] * damp]);
    const dq = qmul([0, this.omega[0], this.omega[1], this.omega[2]], this.q);
    this.q = qnorm([this.q[0] + 0.5 * dt * dq[0], this.q[1] + 0.5 * dt * dq[1], this.q[2] + 0.5 * dt * dq[2], this.q[3] + 0.5 * dt * dq[3]]);
    if (record) { this.forces = forces; this.wetCols = wetCols; }
  }
}

// ───────── 渲染用网格（体坐标）─────────
// 返回 { pos:Float32Array, nrm:Float32Array, uv:Float32Array, mat:Float32Array, idx:Uint32Array }
export function buildHullMesh(NS = 48, NP = 14) {
  const pos = [], uv = [], mat = [], idx = [];
  const addV = (x, y, z, u, v, m) => { pos.push(x, y, z); uv.push(u, v); mat.push(m); return pos.length / 3 - 1; };
  const wall = 0.028;
  const sec = (t, off) => {   // 半截面点（y≥0），从龙骨到舷顶；off>0 为向内偏移
    const B = Math.max(0, halfBeam(t) - off), zk = keelZ(t) + off, zg = gunwaleZ(t);
    const pts = [];
    for (let j = 0; j <= NP; j++) {
      const phi = (j / NP) * Math.PI / 2;
      pts.push([B * Math.pow(Math.sin(phi), 0.8), zg - (zg - zk) * Math.pow(Math.cos(phi), 1.6)]);
    }
    return pts;
  };
  const strip = (off, matId, flip, uvScale) => {
    // 两侧各一张网格
    for (const side of [1, -1]) {
      const base = [];
      for (let i = 0; i <= NS; i++) {
        const t = -1 + 2 * i / NS, x = t * HULL.L / 2, pts = sec(t, off), row = [];
        for (let j = 0; j <= NP; j++) row.push(addV(x, side * pts[j][0], pts[j][1], (x / HULL.L + 0.5) * uvScale, j / NP, matId));
        base.push(row);
      }
      for (let i = 0; i < NS; i++) for (let j = 0; j < NP; j++) {
        const a = base[i][j], b = base[i + 1][j], c = base[i + 1][j + 1], d = base[i][j + 1];
        const f = (side > 0) !== flip;
        if (f) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c);
      }
    }
  };
  strip(0, 0, false, 1);          // 外壳
  strip(wall, 1, true, 1);        // 内壳
  // 舷边（顶面）
  for (const side of [1, -1]) {
    const rowO = [], rowI = [];
    for (let i = 0; i <= NS; i++) {
      const t = -1 + 2 * i / NS, x = t * HULL.L / 2, zg = gunwaleZ(t), B = halfBeam(t);
      rowO.push(addV(x, side * B, zg, i / NS * 4, 0, 3)); rowI.push(addV(x, side * Math.max(0, B - wall), zg - 0.0, i / NS * 4, 1, 3));
    }
    for (let i = 0; i < NS; i++) {
      const a = rowO[i], b = rowO[i + 1], c = rowI[i + 1], d = rowI[i];
      if (side > 0) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c);
    }
  }
  // 船尾板（外）：逐级连接左右
  {
    const t = -1, x = t * HULL.L / 2, pts = sec(t, 0), ptsI = sec(t, wall);
    for (let j = 0; j < NP; j++) {
      const a = addV(x, pts[j][0], pts[j][1], 0, j / NP, 0), b = addV(x, -pts[j][0], pts[j][1], 1, j / NP, 0);
      const c = addV(x, -pts[j + 1][0], pts[j + 1][1], 1, (j + 1) / NP, 0), d = addV(x, pts[j + 1][0], pts[j + 1][1], 0, (j + 1) / NP, 0);
      idx.push(a, d, c, a, c, b);
    }
  }
  // 横坐板（3 块）
  for (const t of [-0.42, 0.02, 0.44]) {
    const x = t * HULL.L / 2, B = halfBeam(t) - 0.02, z = gunwaleZ(t) - 0.075, w = 0.16, th = 0.03;
    const v = (xx, yy, zz) => addV(xx, yy, zz, 0, 0, 2);
    const p = [[x - w, -B, z + th], [x + w, -B, z + th], [x + w, B, z + th], [x - w, B, z + th], [x - w, -B, z], [x + w, -B, z], [x + w, B, z], [x - w, B, z]];
    const id = p.map((q) => v(q[0], q[1], q[2]));
    const quad = (a, b, c, d) => idx.push(id[a], id[b], id[c], id[a], id[c], id[d]);
    quad(0, 1, 2, 3); quad(4, 7, 6, 5); quad(0, 4, 5, 1); quad(3, 2, 6, 7); quad(1, 5, 6, 2); quad(0, 3, 7, 4);
  }
  // 法线（顶点平均）
  const P = new Float32Array(pos), nrm = new Float32Array(pos.length);
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { nrm[q] += nx; nrm[q + 1] += ny; nrm[q + 2] += nz; }
  }
  for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
  return { pos: P, nrm, uv: new Float32Array(uv), mat: new Float32Array(mat), idx: new Uint32Array(idx) };
}
