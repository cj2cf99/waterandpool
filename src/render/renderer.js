// WebGL2 渲染器：SSAA 离屏 HDR → 反射 pass → 焦散 pass → 场景 pass → 水面 pass → 水花 → 色调映射呈现
import { mat4 } from './mat.js';
import * as S from './shaders.js';
import { bedHeight, rockMask, DOMAIN, WIDTH, LENGTH } from '../terrain.js';
import { buildHullMesh, HULL } from '../boat.js';

const SUN = (() => { const el = 27 * Math.PI / 180, az = 22 * Math.PI / 180; return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]; })();

export class Camera {
  constructor() { this.target = [19.5, 9.6, 0.1]; this.yaw = (198 * Math.PI) / 180; this.pitch = (12 * Math.PI) / 180; this.dist = 21; this.fov = (46 * Math.PI) / 180; }
  eye() { const cp = Math.cos(this.pitch); return [this.target[0] + this.dist * cp * Math.cos(this.yaw), this.target[1] + this.dist * cp * Math.sin(this.yaw), Math.max(0.25, this.target[2] + this.dist * Math.sin(this.pitch))]; }
  clamp() { this.pitch = Math.max(0.05, Math.min(1.45, this.pitch)); this.dist = Math.max(2.5, Math.min(70, this.dist)); }
}

export class Renderer {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('需要 WebGL2');
    this.gl = gl; this.canvas = canvas;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('需要 EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.ssaa = opts.ssaa ?? 1.5;
    this.exposure = opts.exposure ?? 0.82;
    this.cam = new Camera();
    this.progs = {};
    this._uloc = new Map();
    this._initPrograms();
    this._initGeometry();
    this.simInit = false;
    this.sigma = [0.36, 0.065, 0.040];       // 清水吸收系数 (1/m)：红光先被吸收
    this.scatter = [0.05, 0.25, 0.27];
    this.vaoEmpty = gl.createVertexArray();
    this.cloudT = 0;
    this.resize(canvas.width, canvas.height);
  }

  // ───────── 着色器程序 ─────────
  _prog(name, vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`${name} 着色器编译失败:\n${gl.getShaderInfoLog(sh)}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n').slice(0, 6000)}`); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} 链接失败: ${gl.getProgramInfoLog(p)}`);
    this.progs[name] = p; return p;
  }
  _initPrograms() {
    this._prog('sky', S.FS_VERT, S.SKY_FRAG); this._prog('copy', S.FS_VERT, S.COPY_FRAG); this._prog('present', S.FS_VERT, S.PRESENT_FRAG);
    this._prog('terrain', S.TERRAIN_VERT, S.TERRAIN_FRAG); this._prog('caustic', S.CAUSTIC_VERT, S.CAUSTIC_FRAG);
    this._prog('water', S.WATER_VERT, S.WATER_FRAG); this._prog('boat', S.BOAT_VERT, S.BOAT_FRAG); this._prog('rope', S.BOAT_VERT, S.ROPE_FRAG); this._prog('spray', S.SPRAY_VERT, S.SPRAY_FRAG); this._prog('shadow', S.SHADOW_VERT, S.SHADOW_FRAG);
  }
  _u(prog, name) {
    const key = prog + '|' + name; let l = this._uloc.get(key);
    if (l === undefined) { l = this.gl.getUniformLocation(this.progs[prog], name); this._uloc.set(key, l); }
    return l;
  }
  use(name) { this.cur = name; this.gl.useProgram(this.progs[name]); }
  u1f(n, v) { const l = this._u(this.cur, n); if (l) this.gl.uniform1f(l, v); }
  u1i(n, v) { const l = this._u(this.cur, n); if (l) this.gl.uniform1i(l, v); }
  u2f(n, a, b) { const l = this._u(this.cur, n); if (l) this.gl.uniform2f(l, a, b); }
  u3f(n, a, b, c) { const l = this._u(this.cur, n); if (l) this.gl.uniform3f(l, a, b, c); }
  um4(n, m) { const l = this._u(this.cur, n); if (l) this.gl.uniformMatrix4fv(l, false, m); }
  u1fv(n, v) { const l = this._u(this.cur, n + '[0]') ?? this._u(this.cur, n); if (l) this.gl.uniform1fv(l, v); }
  u2fv(n, v) { const l = this._u(this.cur, n + '[0]') ?? this._u(this.cur, n); if (l) this.gl.uniform2fv(l, v); }
  tex(unit, texture, name) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); this.u1i(name, unit); }

  // ───────── 纹理与 FBO ─────────
  _tex(w, h, internal = this.gl.RGBA16F, filter = this.gl.LINEAR) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _fbo(colorTex, depthRB) {
    const gl = this.gl, f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    if (depthRB) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER); if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO 不完整 0x' + st.toString(16));
    return f;
  }
  _rb(w, h) { const gl = this.gl, r = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, r); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h); return r; }

  resize(cw, ch) {
    const gl = this.gl;
    this.cw = cw; this.ch = ch;
    this.w = Math.max(2, Math.round(cw * this.ssaa)); this.h = Math.max(2, Math.round(ch * this.ssaa));
    const del = (o) => { if (o) { if (o.tex) o.tex.forEach((t) => gl.deleteTexture(t)); if (o.fb) o.fb.forEach((f) => gl.deleteFramebuffer(f)); if (o.rb) o.rb.forEach((r) => gl.deleteRenderbuffer(r)); } };
    del(this.rt);
    const sceneTex = this._tex(this.w, this.h), finalTex = this._tex(this.w, this.h), depth = this._rb(this.w, this.h);
    const rw = Math.max(2, this.w >> 1), rh = Math.max(2, this.h >> 1);
    const reflTex = this._tex(rw, rh), reflDepth = this._rb(rw, rh);
    this.rt = { tex: [sceneTex, finalTex, reflTex], rb: [depth, reflDepth], fb: [], sceneTex, finalTex, reflTex, rw, rh };
    this.rt.sceneFB = this._fbo(sceneTex, depth); this.rt.finalFB = this._fbo(finalTex, depth); this.rt.reflFB = this._fbo(reflTex, reflDepth);
    this.rt.fb.push(this.rt.sceneFB, this.rt.finalFB, this.rt.reflFB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  setSSAA(s) { this.ssaa = s; this.resize(this.cw, this.ch); }

  // ───────── 几何 ─────────
  _buf(data, target = this.gl.ARRAY_BUFFER, usage = this.gl.STATIC_DRAW) { const gl = this.gl, b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); return b; }
  _gridMesh(xs, ys) {
    const gl = this.gl, nx = xs.length, ny = ys.length;
    const v = new Float32Array(nx * ny * 2); for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { v[2 * (j * nx + i)] = xs[i]; v[2 * (j * nx + i) + 1] = ys[j]; }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let n = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx[n++] = a; idx[n++] = b; idx[n++] = d; idx[n++] = a; idx[n++] = d; idx[n++] = c; }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    this._buf(v); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this._buf(idx, gl.ELEMENT_ARRAY_BUFFER);
    gl.bindVertexArray(null);
    return { vao, count: idx.length };
  }
  _terrainMesh(x0, x1, y0, y1, step) {
    const gl = this.gl, nx = Math.ceil((x1 - x0) / step) + 1, ny = Math.ceil((y1 - y0) / step) + 1;
    const H = new Float32Array(nx * ny), R = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = x0 + i * step, y = y0 + j * step; H[j * nx + i] = bedHeight(x, y); R[j * nx + i] = rockMask(x, y); }
    const P = new Float32Array(nx * ny * 3), Nn = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, im = Math.max(i - 1, 0), ip = Math.min(i + 1, nx - 1), jm = Math.max(j - 1, 0), jp = Math.min(j + 1, ny - 1);
      const hx = (H[j * nx + ip] - H[j * nx + im]) / ((ip - im) * step), hy = (H[jp * nx + i] - H[jm * nx + i]) / ((jp - jm) * step);
      const l = Math.hypot(hx, hy, 1);
      P[3 * k] = x0 + i * step; P[3 * k + 1] = y0 + j * step; P[3 * k + 2] = H[k]; Nn[3 * k] = -hx / l; Nn[3 * k + 1] = -hy / l; Nn[3 * k + 2] = 1 / l;
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let n = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx[n++] = a; idx[n++] = b; idx[n++] = d; idx[n++] = a; idx[n++] = d; idx[n++] = c; }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    this._buf(P); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this._buf(Nn); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    this._buf(R); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    this._buf(idx, gl.ELEMENT_ARRAY_BUFFER); gl.bindVertexArray(null);
    return { vao, count: idx.length, box: [x0, y0, x1, y1] };
  }
  _initGeometry() {
    const gl = this.gl;
    // 地形：近处细、远处粗
    this.terrNear = this._terrainMesh(-3, WIDTH + 8, -5, LENGTH + 5, 0.085);
    this.terrFar = this._terrainMesh(-95, WIDTH + 75, -60, LENGTH + 60, 0.7);
    // 近水面网格（覆盖模拟域）
    const nxw = 340, nyw = 227; const xs = [], ys = [];
    for (let i = 0; i <= nxw; i++) xs.push(WIDTH * i / nxw); for (let j = 0; j <= nyw; j++) ys.push(LENGTH * j / nyw);
    this.waterNear = this._gridMesh(xs, ys);
    // 远水面：从域中心向外渐疏
    const gx = [0]; { let x = 0, st = 0.25; while (x > -420) { x -= st; gx.push(x); st *= 1.07; } } gx.reverse();
    const gy = [LENGTH / 2]; { let d = 0, st = 0.3; while (d < 420) { d += st; gy.push(LENGTH / 2 + d); gy.unshift(LENGTH / 2 - d); st *= 1.07; } }
    this.waterFar = this._gridMesh(gx, gy);
    // 船
    const hm = buildHullMesh(); this.boatMesh = hm;
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    this._buf(hm.pos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this._buf(hm.nrm); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    this._buf(hm.uv); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    this._buf(hm.mat); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    this._buf(hm.idx, gl.ELEMENT_ARRAY_BUFFER); gl.bindVertexArray(null);
    this.boatVAO = { vao, count: hm.idx.length };
    // 绳：动态管（三棱）
    const RS = 18; this.ropeSeg = RS;
    this.ropeVAO = gl.createVertexArray(); gl.bindVertexArray(this.ropeVAO);
    this.ropeP = new Float32Array((RS + 1) * 3 * 3); this.ropeN = new Float32Array((RS + 1) * 3 * 3); this.ropeUV = new Float32Array((RS + 1) * 3 * 2); this.ropeM = new Float32Array((RS + 1) * 3);
    this.ropeBufs = [this._buf(this.ropeP, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW), this._buf(this.ropeN, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW), this._buf(this.ropeUV, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW), this._buf(this.ropeM, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW)];
    const comps = [3, 3, 2, 1];
    this.ropeBufs.forEach((b, i) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, comps[i], gl.FLOAT, false, 0, 0); });
    const ri = []; for (let s = 0; s < RS; s++) for (let k = 0; k < 3; k++) { const a = s * 3 + k, b = s * 3 + (k + 1) % 3, c = (s + 1) * 3 + k, d = (s + 1) * 3 + (k + 1) % 3; ri.push(a, b, d, a, d, c); }
    this._buf(new Uint32Array(ri), gl.ELEMENT_ARRAY_BUFFER); this.ropeCount = ri.length; gl.bindVertexArray(null);
    // 水花
    this.sprayVAO = gl.createVertexArray(); gl.bindVertexArray(this.sprayVAO);
    this.sprayBuf = this._buf(new Float32Array(24000 * 5), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 12); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
    gl.bindVertexArray(null);
    // 阴影贴图（太阳方向正交投影，覆盖模拟域及周边）
    this.shW = 2048;
    this.shDepth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.shDepth);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shW, this.shW);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shFB = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shDepth, 0); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('阴影 FBO 不完整');
    {
      const c = [WIDTH / 2 + 2, LENGTH / 2, 0.3], R = 24;
      const eye = [c[0] + SUN[0] * 80, c[1] + SUN[1] * 80, c[2] + SUN[2] * 80];
      const view = mat4.lookAt(eye, c, [0, 0, 1]);
      const o = new Float32Array(16); o[0] = 1 / R; o[5] = 1 / R; o[10] = -2 / (200 - 20); o[14] = -(200 + 20) / (200 - 20); o[15] = 1;   // 正交 ±R，近 20 远 200
      this.lightVP = mat4.mul(o, view);
    }
    // 床面高程纹理（焦散用，R 通道）
    const bw = 384, bh = 256, bd = new Float32Array(bw * bh * 4);
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) bd[4 * (j * bw + i)] = bedHeight((i + 0.5) / bw * WIDTH, (j + 0.5) / bh * LENGTH);
    this.bedTex = this._tex(bw, bh); gl.bindTexture(gl.TEXTURE_2D, this.bedTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, bh, gl.RGBA, gl.FLOAT, bd);
    // 焦散 FBO
    this.caW = 768; this.caH = 512; this.caTex = this._tex(this.caW, this.caH); this.caFB = this._fbo(this.caTex, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _ensureSimTex(nx, ny) {
    if (this.simInit && this.nx === nx && this.ny === ny) return;
    const gl = this.gl; this.nx = nx; this.ny = ny;
    this.simTex = this._tex(nx, ny); this.velTex = this._tex(nx, ny, gl.RG16F);
    this.simBuf = new Float32Array(nx * ny * 4); this.velBuf = new Float32Array(nx * ny * 2); this.simInit = true;
  }

  // ───────── 帧 ─────────
  uploadSim(snap) {
    const gl = this.gl, { nx, ny } = snap; this._ensureSimTex(nx, ny);
    const sb = this.simBuf, vb = this.velBuf, N = nx * ny;
    for (let c = 0; c < N; c++) { sb[4 * c] = snap.eta[c]; sb[4 * c + 1] = snap.depth[c]; sb[4 * c + 2] = snap.foam[c]; sb[4 * c + 3] = snap.wet[c]; vb[2 * c] = snap.vel[2 * c]; vb[2 * c + 1] = snap.vel[2 * c + 1]; }
    gl.bindTexture(gl.TEXTURE_2D, this.simTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nx, ny, gl.RGBA, gl.FLOAT, sb);
    gl.bindTexture(gl.TEXTURE_2D, this.velTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nx, ny, gl.RG, gl.FLOAT, vb);
  }

  _commonUniforms(snap, t) {
    this.u3f('uSun', SUN[0], SUN[1], SUN[2]);
    this.u1f('uTime', t % 5000);
    this.u2f('uWind', snap.wind.vec[0], snap.wind.vec[1]); this.u1f('uWindSpeed', snap.wind.U);
    this.u2f('uCloudOff', (this.cloudT * 0.004) % 100, (this.cloudT * 0.0015) % 100);
    const c = snap.chop; const D = new Float32Array(56);
    for (let i = 0; i < 28; i++) { D[2 * i] = c.dx[i]; D[2 * i + 1] = c.dy[i]; }
    this.u1fv('uChopK', c.k); this.u2fv('uChopD', D); this.u1fv('uChopA', c.amp);
    const ph = new Float32Array(28); for (let i = 0; i < 28; i++) ph[i] = snap.chopPhase[i] % (2 * Math.PI);
    this.u1fv('uChopP', ph);
  }

  render(snap) {
    const gl = this.gl, rt = this.rt;
    this.uploadSim(snap);
    this.cloudT = snap.time;
    const cam = this.cam; cam.clamp();
    if (this.followBoat) { const bp = snap.boat.pos; cam.target[0] += (bp[0] - cam.target[0]) * 0.08; cam.target[1] += (bp[1] - cam.target[1]) * 0.08; cam.target[2] = 0.05; }
    const eye = cam.eye(), aspect = this.cw / this.ch;
    const proj = mat4.perspective(cam.fov, aspect, 0.08, 900), view = mat4.lookAt(eye, cam.target, [0, 0, 1]);
    const vp = mat4.mul(proj, view);
    const mirror = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
    const vpRefl = mat4.mul(vp, mirror);
    const invVP = mat4.invert(vp);
    const boatM = mat4.fromQuatPos(snap.boat.q, snap.boat.pos);
    this._updateRope(snap);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.CULL_FACE);

    // 0) 阴影 pass（太阳视角深度：地形 + 船）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shFB); gl.viewport(0, 0, this.shW, this.shW); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false); gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4);
    this.use('shadow'); this.um4('uLightVP', this.lightVP); this.um4('uModel', mat4.ident());
    gl.bindVertexArray(this.terrNear.vao); gl.drawElements(gl.TRIANGLES, this.terrNear.count, gl.UNSIGNED_INT, 0);
    this.um4('uModel', boatM); gl.bindVertexArray(this.boatVAO.vao); gl.drawElements(gl.TRIANGLES, this.boatVAO.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.colorMask(true, true, true, true);

    // 1) 焦散图
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.caFB); gl.viewport(0, 0, this.caW, this.caH);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    this.use('caustic'); this._commonUniforms(snap, snap.time);
    this.tex(0, this.simTex, 'uSim'); this.tex(1, this.bedTex, 'uBed'); this.u2f('uDom', WIDTH, LENGTH); this.u2f('uTexel', 1 / snap.nx, 1 / snap.ny);
    gl.bindVertexArray(this.waterNear.vao); gl.drawElements(gl.TRIANGLES, this.waterNear.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);

    // 2) 反射 pass（z 镜像，只画水面以上的地形与船）
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.reflFB); gl.viewport(0, 0, rt.rw, rt.rh);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.frontFace(gl.CW);
    this._drawScene(snap, vpRefl, eye, boatM, true);
    gl.frontFace(gl.CCW);

    // 3) 场景 pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.sceneFB); gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); this.use('sky'); this._commonUniforms(snap, snap.time); this.um4('uInvVP', invVP); this.u3f('uCam', eye[0], eye[1], eye[2]);
    gl.bindVertexArray(this.vaoEmpty); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.enable(gl.DEPTH_TEST);
    this._drawScene(snap, vp, eye, boatM, false);

    // 4) 水面 pass：先复制场景到 final，再画水
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rt.sceneFB); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rt.finalFB);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.finalFB); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.use('water'); this._commonUniforms(snap, snap.time);
    this.um4('uVP', vp); this.u3f('uCam', eye[0], eye[1], eye[2]); this.u2f('uDom', WIDTH, LENGTH); this.u2f('uSimTexel', 1 / snap.nx, 1 / snap.ny); this.u2f('uRes', this.w, this.h);
    this.u3f('uSigma', ...this.sigma); this.u3f('uScatter', ...this.scatter);
    this.tex(0, this.simTex, 'uSim'); this.tex(1, this.velTex, 'uVel'); this.tex(2, rt.sceneTex, 'uScene'); this.tex(3, rt.reflTex, 'uRefl'); this.tex(4, this.caTex, 'uCaust'); this.tex(6, this.bedTex, 'uBed');
    const mk = snap.maker, MA = new Float32Array(12), MP = new Float32Array(12), MX = new Float32Array(12), MY = new Float32Array(12);
    for (let i = 0; i < 12; i++) { MA[i] = mk.amp[i]; MP[i] = mk.phase[i] % (2 * Math.PI); MX[i] = mk.kx[i]; MY[i] = mk.ky[i]; }
    this.u1fv('uMkA', MA); this.u1fv('uMkPh', MP); this.u1fv('uMkKx', MX); this.u1fv('uMkKy', MY);
    this.u1f('uNear', 0); gl.bindVertexArray(this.waterFar.vao); gl.drawElements(gl.TRIANGLES, this.waterFar.count, gl.UNSIGNED_INT, 0);
    this.u1f('uNear', 1); gl.bindVertexArray(this.waterNear.vao); gl.drawElements(gl.TRIANGLES, this.waterNear.count, gl.UNSIGNED_INT, 0);
    // 水花
    if (snap.nSpray > 0) {
      gl.depthMask(false); this.use('spray'); this._commonUniforms(snap, snap.time); this.um4('uVP', vp); this.u3f('uCam', eye[0], eye[1], eye[2]);
      this.u1f('uPx', this.h / (2 * Math.tan(cam.fov / 2)));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sprayBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, snap.spray, 0, snap.nSpray * 5);
      gl.bindVertexArray(this.sprayVAO); gl.drawArrays(gl.POINTS, 0, snap.nSpray); gl.depthMask(true);
    }
    gl.disable(gl.BLEND);

    // 5) 呈现
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.cw, this.ch); gl.disable(gl.DEPTH_TEST);
    this.use('present'); this._commonUniforms(snap, snap.time); this.tex(0, rt.finalTex, 'uTex'); this.u2f('uTexel', 1 / this.w, 1 / this.h); this.u1f('uExposure', this.exposure);
    gl.bindVertexArray(this.vaoEmpty); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.enable(gl.DEPTH_TEST);
  }

  _drawScene(snap, vp, eye, boatM, refl) {
    const gl = this.gl;
    const sceneU = () => {
      this._commonUniforms(snap, snap.time); this.um4('uVP', vp); this.u3f('uCam', eye[0], eye[1], eye[2]); this.u3f('uSigma', ...this.sigma);
      this.u2f('uDom', WIDTH, LENGTH); this.u1f('uClipWater', refl ? 1 : 0);
      this.tex(5, this.caTex, 'uCaust'); this.tex(7, this.shDepth, 'uShadow'); this.um4('uLightVP', this.lightVP); this.u1f('uShadowOn', 1);
    };
    // 地形
    this.use('terrain'); sceneU(); this.tex(0, this.simTex, 'uSim');
    this.u1f('uUseBox', 1); this.u2f('uBoxMin', this.terrNear.box[0], this.terrNear.box[1]); this.u2f('uBoxMax', this.terrNear.box[2], this.terrNear.box[3]);
    gl.bindVertexArray(this.terrFar.vao); gl.drawElements(gl.TRIANGLES, this.terrFar.count, gl.UNSIGNED_INT, 0);
    this.u1f('uUseBox', 0);
    gl.bindVertexArray(this.terrNear.vao); gl.drawElements(gl.TRIANGLES, this.terrNear.count, gl.UNSIGNED_INT, 0);
    // 船
    this.use('boat'); sceneU(); this.um4('uModel', boatM);
    gl.bindVertexArray(this.boatVAO.vao); gl.drawElements(gl.TRIANGLES, this.boatVAO.count, gl.UNSIGNED_INT, 0);
    // 绳
    if (snap.boat.rope && snap.boat.rope.on) {
      this.use('rope'); sceneU(); this.um4('uModel', mat4.ident());
      gl.bindVertexArray(this.ropeVAO); gl.drawElements(gl.TRIANGLES, this.ropeCount, gl.UNSIGNED_INT, 0);
    }
  }

  _updateRope(snap) {
    const gl = this.gl, rp = snap.boat.rope; if (!rp || !rp.on) return;
    const M = mat4.fromQuatPos(snap.boat.q, snap.boat.pos);
    const bl = [HULL.L / 2 * 0.92, 0, 0.12];
    const bow = [M[0] * bl[0] + M[4] * bl[1] + M[8] * bl[2] + M[12], M[1] * bl[0] + M[5] * bl[1] + M[9] * bl[2] + M[13], M[2] * bl[0] + M[6] * bl[1] + M[10] * bl[2] + M[14]];
    const an = [rp.ax, rp.ay, rp.az + 0.02];
    const dist = Math.hypot(bow[0] - an[0], bow[1] - an[1], bow[2] - an[2]);
    const slack = Math.max(0, rp.len - dist);
    const sag = Math.min(0.9, Math.sqrt(slack) * 0.55);
    const RS = this.ropeSeg, r = 0.012;
    for (let s = 0; s <= RS; s++) {
      const t = s / RS;
      let x = an[0] + (bow[0] - an[0]) * t, y = an[1] + (bow[1] - an[1]) * t, z = an[2] + (bow[2] - an[2]) * t - sag * 4 * t * (1 - t);
      z = Math.max(z, -0.0 + 0.0);     // 水中的绳段在水下，不裁剪
      // 沿线方向的切向，用 3 个角度做三棱
      const tx = bow[0] - an[0], ty = bow[1] - an[1], tz = bow[2] - an[2], tl = Math.hypot(tx, ty, tz) || 1;
      let ux = -ty / (Math.hypot(tx, ty) || 1), uy = tx / (Math.hypot(tx, ty) || 1), uz = 0;
      const wx = (ty * uz - tz * uy) / tl, wy = (tz * ux - tx * uz) / tl, wz = (tx * uy - ty * ux) / tl;
      for (let k = 0; k < 3; k++) {
        const a = k * 2.0944, cx = Math.cos(a), cy = Math.sin(a), n = (s * 3 + k) * 3;
        const nx = ux * cx + wx * cy, ny = uy * cx + wy * cy, nz = uz * cx + wz * cy;
        this.ropeP[n] = x + nx * r; this.ropeP[n + 1] = y + ny * r; this.ropeP[n + 2] = z + nz * r;
        this.ropeN[n] = nx; this.ropeN[n + 1] = ny; this.ropeN[n + 2] = nz;
        this.ropeUV[(s * 3 + k) * 2] = t * 6; this.ropeUV[(s * 3 + k) * 2 + 1] = k;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ropeBufs[0]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ropeP);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ropeBufs[1]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ropeN);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ropeBufs[2]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ropeUV);
  }
}
