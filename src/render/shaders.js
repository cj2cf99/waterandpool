// GLSL ES 3.00 着色器源码（WebGL2）。线性空间计算，最后统一色调映射 + gamma。
const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
`;

// ───────── 公共：噪声、天空、风浪 ─────────
export const COMMON = `
uniform vec3 uSun;          // 指向太阳的单位向量
uniform float uTime;
uniform vec2 uWind;         // 风矢量 m/s（吹向）
uniform float uWindSpeed;
uniform vec2 uCloudOff;
const float PI = 3.14159265;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= .5; } return s; }
float fbm3(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= .5; } return s; }

vec3 skyColor(vec3 d, bool disc){
  float h = clamp(d.z, 0., 1.);
  vec3 zen = vec3(0.075, 0.20, 0.58), hor = vec3(0.50, 0.66, 0.86);
  vec3 col = mix(hor, zen, pow(h, 0.55));
  float sd = max(dot(d, uSun), 0.);
  col += vec3(1.0, 0.80, 0.52) * pow(sd, 6.) * 0.30 + vec3(1.0, 0.88, 0.66) * pow(sd, 40.) * 0.55;
  if (disc) col += vec3(1.0, 0.95, 0.85) * smoothstep(0.99955, 0.99985, sd) * 60.;
  if (d.z > 0.0) {
    vec2 uv = d.xy / (d.z + 0.22) * 0.85 + uCloudOff;
    float c = fbm(uv * 1.5);
    float cov = smoothstep(0.50, 0.82, c) * smoothstep(0.0, 0.22, d.z);
    float lit = 0.75 + 0.25 * clamp(fbm(uv * 1.5 + uSun.xy * 0.15) - c + 0.5, 0., 1.);
    vec3 cc = mix(vec3(0.62, 0.66, 0.74), vec3(1.0, 0.99, 0.97), lit) ;
    col = mix(col, cc, cov * 0.88);
  }
  if (d.z < 0.) col = mix(col, hor * 0.85, smoothstep(0., -0.15, d.z));
  return col;
}

// 风生短波（Gerstner 分量）
#define NCH 28
uniform float uChopK[NCH]; uniform vec2 uChopD[NCH]; uniform float uChopA[NCH]; uniform float uChopP[NCH];
float gustField(vec2 p){
  vec2 q = p * 0.10 - uWind * uTime * 0.05;
  float g = fbm3(q) * 0.7 + fbm3(q * 2.7 + 5.1) * 0.3;
  return smoothstep(0.36, 0.64, g);
}
void chopEval(vec2 p, float ampMul, float footprint, out float z, out vec2 grad, out float jac, out vec2 disp){
  z = 0.; grad = vec2(0.); disp = vec2(0.); float jxx = 0., jyy = 0., jxy = 0.;
  for (int i = 0; i < NCH; i++) {
    float k = uChopK[i];
    float lam = 6.2831853 / k;
    float fade = clamp((lam / footprint - 1.5) / 2.0, 0., 1.);
    float a = uChopA[i] * ampMul * fade; if (a < 1e-6) continue;
    vec2 d = uChopD[i];
    float th = k * dot(d, p) - uChopP[i];
    float s = sin(th), c = cos(th);
    z += a * c; grad += -a * k * s * d;
    const float Q = 0.85;
    disp += -Q * a * s * d;
    jxx += Q * a * k * c * d.x * d.x; jyy += Q * a * k * c * d.y * d.y; jxy += Q * a * k * c * d.x * d.y;
  }
  jac = (1. - jxx) * (1. - jyy) - jxy * jxy;
}

uniform sampler2D uShadow; uniform mat4 uLightVP; uniform float uShadowOn;
float shadowAt(vec3 wp, vec3 n){
  if (uShadowOn < 0.5) return 1.0;
  vec4 lp = uLightVP * vec4(wp + n * 0.02, 1.);
  vec3 sc = lp.xyz / lp.w * 0.5 + 0.5;
  if (sc.x < 0. || sc.x > 1. || sc.y < 0. || sc.y > 1. || sc.z > 1.) return 1.0;
  float bias = 0.0016;
  float sum = 0.; vec2 texel = vec2(1. / 2048.);
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float d = texture(uShadow, sc.xy + vec2(float(i), float(j)) * texel * 1.5).r;
    sum += (sc.z - bias > d) ? 0.0 : 1.0;
  }
  return sum / 9.0;
}
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
`;

// ───────── 全屏三角形 ─────────
export const FS_VERT = HEAD + `
out vec2 vUv;
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

export const SKY_FRAG = HEAD + COMMON + `
uniform mat4 uInvVP; uniform vec3 uCam;
in vec2 vUv; out vec4 o;
void main(){
  vec4 w = uInvVP * vec4(vUv * 2. - 1., 1., 1.); vec3 d = normalize(w.xyz / w.w - uCam);
  o = vec4(skyColor(d, true), 1.);
}`;

export const COPY_FRAG = HEAD + `
uniform sampler2D uTex; in vec2 vUv; out vec4 o;
void main(){ o = texture(uTex, vUv); }`;

export const PRESENT_FRAG = HEAD + COMMON + `
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uExposure;
in vec2 vUv; out vec4 o;
void main(){
  vec3 c = (texture(uTex, vUv + uTexel * vec2(-0.35, -0.35)).rgb + texture(uTex, vUv + uTexel * vec2(0.35, -0.35)).rgb
          + texture(uTex, vUv + uTexel * vec2(-0.35, 0.35)).rgb + texture(uTex, vUv + uTexel * vec2(0.35, 0.35)).rgb) * 0.25;
  // 泛光：对 >1.2 的高亮取环形采样，模拟太阳光柱的光晕
  vec3 bl = vec3(0.);
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.3927; float r = (i % 2 == 0) ? 5. : 11.;
    vec3 t = texture(uTex, vUv + uTexel * r * vec2(cos(a), sin(a))).rgb;
    bl += max(t - 1.1, 0.);
  }
  c += bl * 0.045;
  c *= uExposure;
  float vg = 1. - 0.18 * pow(length(vUv - 0.5) * 1.4, 2.0);
  c = aces(c) * vg;
  c = pow(c, vec3(1. / 2.2));
  o = vec4(c, 1.);
}`;

// ───────── 地形 ─────────
export const TERRAIN_VERT = HEAD + `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in float aRock;
uniform mat4 uVP;
out vec3 vPos; out vec3 vNrm; out float vRock;
void main(){ vPos = aPos; vNrm = aNrm; vRock = aRock; gl_Position = uVP * vec4(aPos, 1.); }`;

export const TERRAIN_FRAG = HEAD + COMMON + `
uniform sampler2D uSim; uniform sampler2D uCaust; uniform vec2 uDom; uniform vec3 uCam;
uniform vec3 uSigma;       // 水的吸收系数 (1/m)
uniform float uClipWater;  // 1：反射 pass 只画水面以上
uniform vec2 uBoxMin; uniform vec2 uBoxMax; uniform float uUseBox; // 远处网格：排除近处网格覆盖范围
in vec3 vPos; in vec3 vNrm; in float vRock;
out vec4 o;
void main(){
  if (uClipWater > 0.5 && vPos.z < -0.005) discard;
  if (uUseBox > 0.5 && vPos.x > uBoxMin.x && vPos.x < uBoxMax.x && vPos.y > uBoxMin.y && vPos.y < uBoxMax.y) discard;
  vec3 N = normalize(vNrm);
  vec2 uv = vPos.xy / uDom;
  bool inDom = uv.x >= 0. && uv.x <= 1. && uv.y >= 0. && uv.y <= 1.;
  vec4 sim = inDom ? texture(uSim, uv) : vec4(0.);
  float depthW = inDom ? max(0., sim.r - vPos.z) : 0.; float wet = sim.a;
  float rock = smoothstep(0.35, 0.65, vRock);
  vec2 q = vPos.xy;
  // 细节法线：沙纹/岩石起伏
  float n1 = fbm(q * 7.0), n2 = vnoise(q * 55.0), n3 = vnoise(q * 140.0);
  float rip = sin(dot(q, vec2(0.96, 0.28)) * 22.0 + n1 * 7.0 + vPos.z * 9.0);
  vec2 gradDetail = vec2(0.);
  float eps = 0.02;
  float hC = fbm3(q * 11.0), hX = fbm3((q + vec2(eps, 0.)) * 11.0), hY = fbm3((q + vec2(0., eps)) * 11.0);
  gradDetail = vec2(hX - hC, hY - hC) / eps;
  float fwp = length(fwidth(vPos.xy)); float detFade = 1. - smoothstep(0.012, 0.06, fwp);
  vec2 ripG = detFade * 0.18 * cos(dot(q, vec2(0.96, 0.28)) * 22.0 + n1 * 7.0 + vPos.z * 9.0) * vec2(0.96, 0.28) * 22.0 * 0.012;
  float sandAmp = (1. - rock) * (1. - 0.8 * wet) * 0.06 * detFade;
  float rockAmp = rock * 0.03 * detFade;
  vec3 Nd = normalize(N + vec3(-(gradDetail * (sandAmp + rockAmp) + ripG * (1. - rock)), 0.));
  // 反照率
  vec3 sandBase = mix(vec3(0.66, 0.53, 0.33), vec3(0.86, 0.73, 0.50), n1);
  sandBase *= 0.90 + 0.20 * n2;
  sandBase = mix(sandBase, sandBase * vec3(1.03, 0.97, 0.88), smoothstep(0.4, 0.8, n3));
  float pebble = smoothstep(0.86, 0.93, vnoise(q * 38.0));
  sandBase = mix(sandBase, vec3(0.32, 0.29, 0.26), pebble * 0.55);
  float ridge = 1. - abs(2. * fbm(q * 6.0 + 3.0) - 1.);
  float rn = fbm(q * 4.2 + 9.0), rn2 = fbm(q * 13.0 + 2.0);
  float strata = 0.5 + 0.5 * sin(vPos.z * 38.0 + rn * 5.0 + q.x * 1.5);
  vec3 rockBase = mix(vec3(0.30, 0.27, 0.24), vec3(0.58, 0.52, 0.45), rn);
  rockBase *= 0.78 + 0.34 * rn2;
  rockBase = mix(rockBase, rockBase * vec3(0.78, 0.74, 0.70), strata * 0.45);
  float crack = smoothstep(0.80, 0.97, 1. - abs(2. * fbm(q * 7.0 + 3.0) - 1.));
  rockBase = mix(rockBase, rockBase * 0.35, crack * 0.8);
  // 水线附近：绿藻（暗绿）与藤壶（浅灰白点）
  float tide = smoothstep(0.30, 0.0, vPos.z);
  rockBase = mix(rockBase, vec3(0.13, 0.19, 0.08), tide * smoothstep(0.35, 0.7, rn2) * 0.85);
  rockBase = mix(rockBase, vec3(0.72, 0.70, 0.64), tide * smoothstep(0.82, 0.9, vnoise(q * 60.0)) * 0.7);
  vec3 alb = mix(sandBase, rockBase, rock);
  float grass = smoothstep(1.6, 3.2, vPos.z) * (0.35 + 0.65 * fbm(q * 0.5)) * (1. - rock);
  alb = mix(alb, vec3(0.34, 0.33, 0.14) * (0.8 + 0.4 * n2), grass * 0.7);
  // 湿度：沙变深、变饱和；水下更深
  float wetAmt = clamp(max(wet, step(0.002, depthW)), 0., 1.);
  alb *= mix(1., mix(0.50, 0.40, rock), wetAmt * (1. - 0.3 * rock));
  alb = mix(alb, alb * alb * 1.6, wetAmt * 0.25);
  // 光照
  vec3 V = normalize(uCam - vPos);
  float ndl = max(dot(Nd, uSun), 0.);
  vec3 sunRad = vec3(1.0, 0.89, 0.74) * 2.7;
  vec3 skyAmb = mix(vec3(0.16, 0.18, 0.20), vec3(0.36, 0.50, 0.78), clamp(Nd.z * 0.5 + 0.5, 0., 1.)) * 0.9;
  float cw = 1.0, att = 1.0;
  vec3 attC = vec3(1.0);
  if (depthW > 0.002) {
    float caust = inDom ? texture(uCaust, uv).r : 1.;
    attC = exp(-uSigma * depthW / max(uSun.z, 0.35));
    cw = mix(1.0, caust, smoothstep(0.004, 0.05, depthW));
    skyAmb *= exp(-uSigma * depthW * 1.2);
  }
  // 太阳投影到石头背面等：简易自阴影（法线朝向）
  float sh = shadowAt(vPos, N);
  vec3 col = alb * (sunRad * ndl * sh * cw * attC + skyAmb);
  // 湿沙镜面
  vec3 Hh = normalize(uSun + V);
  float sp = pow(max(dot(Nd, Hh), 0.), 60.) * wetAmt * (1. - rock) * 0.5 * ndl;
  col += vec3(1.0, 0.95, 0.85) * sp * attC * sh;
  // 水线上方的湿润边缘（水退后一圈更深色已由 wet 体现）
  o = vec4(col, 1.);
}`;

// ───────── 焦散图 ─────────
export const CAUSTIC_VERT = HEAD + COMMON + `
layout(location=0) in vec2 aPos;
uniform sampler2D uSim; uniform sampler2D uBed; uniform vec2 uDom; uniform vec2 uTexel;
out vec3 vOld; out vec3 vNew; out float vValid;
float etaAt(vec2 p){ return texture(uSim, p / uDom).r; }
void main(){
  vec2 p = aPos;
  float dx = uTexel.x * uDom.x * 1.5, dy = uTexel.y * uDom.y * 1.5;
  float e = etaAt(p);
  float ex = (etaAt(p + vec2(dx, 0.)) - etaAt(p - vec2(dx, 0.))) / (2. * dx), ey = (etaAt(p + vec2(0., dy)) - etaAt(p - vec2(0., dy))) / (2. * dy);
  float depth = max(0., e - texture(uBed, p / uDom).r);
  // 低频风浪对焦散的贡献（>0.3m 波长，网格能分辨）
  float cz; vec2 cg, cd; float cj;
  float amp = mix(0.3, 1.5, gustField(p)) * smoothstep(0.03, 0.3, depth);
  chopEval(p, amp, 0.14, cz, cg, cj, cd);
  vec3 N = normalize(vec3(-(ex + cg.x), -(ey + cg.y), 1.));
  vec3 L = -uSun;
  vec3 T = refract(L, N, 1. / 1.33);
  vec3 T0 = refract(L, vec3(0., 0., 1.), 1. / 1.33);
  float bed = texture(uBed, p / uDom).r;
  float d = max(e - bed, 0.);
  vec3 P = vec3(p, e + cz);
  vOld = P + T0 * (d / max(-T0.z, 0.05));
  vNew = P + T * (d / max(-T.z, 0.05));
  vValid = smoothstep(0.02, 0.08, d);
  gl_Position = vec4(vNew.xy / uDom * 2. - 1., 0., 1.);
}`;
export const CAUSTIC_FRAG = HEAD + `
in vec3 vOld; in vec3 vNew; in float vValid; out vec4 o;
void main(){
  float a0 = length(dFdx(vOld)) * length(dFdy(vOld));
  float a1 = length(dFdx(vNew)) * length(dFdy(vNew));
  float I = a0 / max(a1, 1e-7);
  I = min(I, 5.0) * vValid + (1. - vValid) * 1.0;
  o = vec4(I, I, I, 1.);
}`;

// ───────── 水面 ─────────
export const WATER_VERT = HEAD + COMMON + `
layout(location=0) in vec2 aPos;
uniform mat4 uVP; uniform sampler2D uSim; uniform sampler2D uBed; uniform vec2 uDom; uniform float uNear; uniform vec3 uCam;
uniform float uMkA[12]; uniform float uMkPh[12]; uniform float uMkKx[12]; uniform float uMkKy[12];
out vec3 vPos; out vec2 vBase; out float vDepth; out float vEta; out float vGust; out vec2 vDisp;
float farEta(vec2 p){
  float e = 0.;
  for (int i = 0; i < 12; i++) e += uMkA[i] * sin(uMkPh[i] + uMkKx[i] * min(p.x, 0.) - uMkKy[i] * p.y);
  return e;
}
void main(){
  vec2 p = aPos; float eta, depth;
  if (uNear > 0.5) { vec4 s = texture(uSim, p / uDom); eta = s.r; depth = max(0., eta - texture(uBed, p / uDom).r); }
  else { eta = farEta(p); depth = mix(0.9, 3.5, smoothstep(0., 25., -p.x)); }
  float dist = length(uCam.xy - p);
  float g = gustField(p);
  float spacing = (uNear > 0.5) ? 0.09 : (0.27 + 0.075 * max(0., -p.x));   // 网格间距：高频波分量在顶点着色器里按奈奎斯特淡出，避免混叠条纹
  float fp = max(spacing, dist * 0.0022);
  float amp = mix(0.22, 1.6, g) * smoothstep(0.02, 0.22, depth);
  float cz; vec2 cg, cd; float cj;
  chopEval(p, amp, fp, cz, cg, cj, cd);
  vec3 P = vec3(p + cd * 0.6, eta + cz + 0.0006);
  vPos = P; vBase = p; vDepth = depth; vEta = eta; vGust = g; vDisp = cd;
  gl_Position = uVP * vec4(P, 1.);
}`;

export const WATER_FRAG = HEAD + COMMON + `
uniform sampler2D uSim; uniform sampler2D uBed; uniform sampler2D uVel; uniform sampler2D uScene; uniform sampler2D uRefl; uniform sampler2D uCaust;
uniform vec2 uDom; uniform vec2 uSimTexel; uniform float uNear; uniform vec3 uCam; uniform mat4 uVP; uniform vec2 uRes;
uniform vec3 uSigma; uniform vec3 uScatter;
in vec3 vPos; in vec2 vBase; in float vDepth; in float vEta; in float vGust; in vec2 vDisp;
out vec4 o;
float foamNoise(vec2 p){ return fbm3(p * 9.0) * 0.6 + vnoise(p * 33.) * 0.4; }
void main(){
  vec2 p = vBase; vec3 P = vPos;
  float depth = vDepth, foam = 0., wetNear = 0.;
  vec2 vel = vec2(0.);
  vec3 Nsim = vec3(0., 0., 1.);
  if (uNear > 0.5) {
    vec2 uv = p / uDom; vec4 s = texture(uSim, uv);
    depth = max(0., s.r - texture(uBed, uv).r); foam = s.b;
    vel = texture(uVel, uv).rg;
    float dx = uSimTexel.x * uDom.x, dy = uSimTexel.y * uDom.y;
    float ex = (texture(uSim, uv + vec2(uSimTexel.x, 0.)).r - texture(uSim, uv - vec2(uSimTexel.x, 0.)).r) / (2. * dx);
    float ey = (texture(uSim, uv + vec2(0., uSimTexel.y)).r - texture(uSim, uv - vec2(0., uSimTexel.y)).r) / (2. * dy);
    Nsim = normalize(vec3(-ex, -ey, 1.));
  }
  float alpha = smoothstep(0.0008, 0.020, depth);
  if (depth < 0.0004 && uNear > 0.5) discard;
  vec3 Vv = uCam - P; float dist = length(Vv); vec3 V = Vv / dist;
  // 风浪法线
  float fpx = max(0.02, length(fwidth(P.xy)) * 1.0);
  float amp = mix(0.45, 1.35, vGust) * smoothstep(0.02, 0.22, depth);
  float cz; vec2 cg, cd; float cj;
  chopEval(p, amp, fpx, cz, cg, cj, cd);
  // 细小涟漪：在风向坐标系里取噪声（沿风向波长短、横向较长），风速越大越粗糙
  vec2 wd = normalize(uWind + vec2(1e-4, 0.)); vec2 wp = vec2(-wd.y, wd.x);
  vec2 pa = vec2(dot(p, wd), dot(p, wp));
  vec2 rq = vec2(pa.x * 16. - uTime * 0.9 - uWindSpeed * uTime * 0.25, pa.y * 6.5);
  float r0 = vnoise(rq), rx = vnoise(rq + vec2(0.06, 0.)), ry = vnoise(rq + vec2(0., 0.06));
  vec2 rgl = vec2(rx - r0, ry - r0) / 0.06;
  vec2 rq2 = vec2(pa.x * 33. - uTime * 1.3 - uWindSpeed * uTime * 0.3, pa.y * 13.);
  float s0 = vnoise(rq2), sx = vnoise(rq2 + vec2(0.05, 0.)), sy = vnoise(rq2 + vec2(0., 0.05));
  vec2 sgl = vec2(sx - s0, sy - s0) / 0.05;
  vec2 rg = rgl.x * wd * 1.0 + rgl.y * wp * 0.45; vec2 sg = sgl.x * wd + sgl.y * wp * 0.45;
  float rippleAmp = (0.0012 + 0.0009 * uWindSpeed) * mix(0.35, 1.5, vGust) * smoothstep(0.02, 0.2, depth) * (1. - smoothstep(30., 90., dist)) * smoothstep(0.3, 1.2, uWindSpeed + 0.3);
  vec2 ripple = (rg * 0.65 + sg * 0.35) * rippleAmp * 0.0;   // 噪声涟漪关闭：风生短波谱已覆盖到厘米级
  vec3 N = normalize(vec3(Nsim.xy - cg - ripple, Nsim.z));
  float cosv = clamp(dot(N, V), 0.0015, 1.);
  // 菲涅尔
  float F = 0.02 + 0.98 * pow(1. - cosv, 5.);
  // 反射：天空（解析）+ 平面反射（石头、船、岸）
  vec3 R = reflect(-V, N); R.z = abs(R.z);
  vec3 skyR = skyColor(R, false);
  vec2 sUV = gl_FragCoord.xy / uRes;
  // 平面反射：反射 pass 用"z 镜像"的同一相机渲染，水面点与反射图同屏幕位置；按法线做小扰动
  vec2 rUV = sUV + N.xy * 0.05;
  vec4 rf = texture(uRefl, rUV);
  vec3 refl = mix(skyR, rf.rgb, rf.a);
  // 折射 + 按光程吸收（Beer–Lambert）
  vec3 T = refract(-V, N, 1. / 1.33);
  float pathLen = depth / max(0.16, -T.z);
  vec3 hit = P + T * pathLen;
  vec4 clip = uVP * vec4(hit, 1.); vec2 rfUV = clip.xy / clip.w * 0.5 + 0.5;
  vec2 offs = rfUV - sUV; float mo = length(offs); if (mo > 0.06) offs *= 0.06 / mo;     // 限制折射偏移，避免远处撕裂
  offs *= clamp(min(min(sUV.x, 1. - sUV.x), min(sUV.y, 1. - sUV.y)) / 0.07, 0., 1.);   // 靠近屏幕边缘时淡出偏移，避免采样出界后的拉伸条纹
  vec3 under = texture(uScene, sUV + offs).rgb;
  vec3 atten = exp(-uSigma * pathLen);
  vec3 skyAmbW = vec3(0.30, 0.46, 0.70);
  vec3 trans = under * atten + uScatter * (vec3(1.) - atten) * (0.35 + 0.65 * uSun.z) * skyAmbW;
  vec3 col = mix(trans, refl, F);
  // 太阳高光（GGX，粗糙度随风速增大）
  vec3 L = uSun; vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.), ndl = max(dot(N, L), 0.);
  float rough = 0.025 + 0.0035 * uWindSpeed; float a2 = rough * rough;
  float Dg = a2 / (PI * pow(ndh * ndh * (a2 - 1.) + 1., 2.));
  vec3 sunRad = vec3(1.0, 0.89, 0.74) * 2.7;
  float vis = 1.0 / (4. * max(ndl, 0.02) * max(cosv, 0.05)) * min(ndl, 1.);
  float Hspec = 0.02 + 0.98 * pow(1. - max(dot(V, H), 0.), 5.);
  vec3 spec = sunRad * Dg * Hspec * vis * ndl * 0.25;
  spec = min(spec, vec3(60.));
  col += spec * (1. - 0.7 * clamp(foam, 0., 1.)) ;
  // 泡沫：浪花/岸边花边/白浪
  float fn = foamNoise(p * 1.7 + vel * (-0.15)) ;
  float fn2 = foamNoise(p * 4.1 + 7.3);
  float F0 = clamp(foam, 0., 1.2);
  float pat = fn * 0.62 + fn2 * 0.38;
  float foamMask = smoothstep(0.52, 0.82, F0 * 0.85 + (pat - 0.5) * 0.9) * smoothstep(0.0004, 0.012, depth);
  float lace = smoothstep(0.55, 0.75, fn2) * (1. - smoothstep(0.0, 0.05, depth)) * smoothstep(0.0003, 0.003, depth) * clamp(F0 * 1.3, 0., 1.);
  foamMask = max(foamMask * 0.92, lace * 0.5);
  // 白浪（Jacobian 小处 + 风速）
  float wcMask = smoothstep(0.62, 0.05, cj) * smoothstep(5.0, 9.5, uWindSpeed * mix(0.8, 1.25, vGust)) * smoothstep(0.1, 0.35, depth) * smoothstep(0.4, 0.7, fn2);
  foamMask = clamp(max(foamMask, wcMask * 0.8), 0., 0.97);
  vec3 foamCol = vec3(0.94, 0.97, 0.99) * (0.30 * skyAmbW * 1.4 + sunRad * max(N.z * 0.55 + 0.45 * ndl, 0.15) * 0.42) ;
  col = mix(col, foamCol, foamMask);
  // 浪舌薄水层边缘：亮边
  float rim = (1. - smoothstep(0.0004, 0.010, depth)) * smoothstep(0.0, 0.0005, depth);
  col += vec3(0.8, 0.85, 0.9) * rim * 0.12 * (0.5 + 0.5 * fn);
  alpha = max(alpha, foamMask * step(0.0004, depth)) ;
  // 空气透视（远处雾化到地平线颜色）
  float fog = 1. - exp(-dist * 0.0030);
  vec3 hz = skyColor(normalize(vec3(-V.xy, 0.02)), false);
  col = mix(col, hz, fog * 0.85);
  o = vec4(col, alpha);
}`;

// ───────── 船 ─────────
export const BOAT_VERT = HEAD + `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec2 aUv; layout(location=3) in float aMat;
uniform mat4 uVP; uniform mat4 uModel;
out vec3 vPos; out vec3 vNrm; out vec2 vUv; out float vMat; out vec3 vLocal;
void main(){ vec4 w = uModel * vec4(aPos, 1.); vPos = w.xyz; vNrm = mat3(uModel) * aNrm; vUv = aUv; vMat = aMat; vLocal = aPos; gl_Position = uVP * w; }`;
export const BOAT_FRAG = HEAD + COMMON + `
uniform vec3 uCam; uniform vec3 uSigma; uniform sampler2D uCaust; uniform vec2 uDom; uniform float uClipWater; uniform float uWaterZ;
in vec3 vPos; in vec3 vNrm; in vec2 vUv; in float vMat; in vec3 vLocal;
out vec4 o;
void main(){
  if (uClipWater > 0.5 && vPos.z < -0.005) discard;
  vec3 N = normalize(vNrm); if (!gl_FrontFacing) N = -N;
  float m = floor(vMat + 0.5);
  vec3 alb; float rough = 0.6;
  float grain = fbm3(vec2(vUv.x * 60., vUv.y * 4.)) ;
  float planks = 11.0;
  float pv = vUv.y * planks; float pf = fract(pv); float seam = smoothstep(0.0, 0.05, pf) * smoothstep(1.0, 0.95, pf);
  float pid = floor(pv);
  vec3 woodA = vec3(0.46, 0.27, 0.12), woodB = vec3(0.62, 0.40, 0.20);
  vec3 wood = mix(woodA, woodB, hash12(vec2(pid, 3.1)) * 0.6 + grain * 0.5);
  wood *= 0.85 + 0.3 * vnoise(vec2(vUv.x * 160., pid * 7.));
  wood *= mix(0.55, 1.0, seam);
  if (m < 0.5) {                      // 外壳：下部防污漆红、中部原木、上部蓝漆
    alb = wood;
    if (vUv.y < 0.20) alb = mix(vec3(0.34, 0.07, 0.05), vec3(0.45, 0.10, 0.07), grain) * mix(0.7, 1., seam);
    if (vUv.y > 0.84) alb = mix(vec3(0.07, 0.24, 0.40), vec3(0.10, 0.32, 0.50), grain) * mix(0.8, 1., smoothstep(0., 0.03, fract(vUv.y * 40.)));
    rough = 0.45;
  } else if (m < 1.5) { alb = wood * vec3(1.15, 1.10, 1.0); rough = 0.7; }       // 内壳
  else if (m < 2.5) { alb = mix(woodB, woodA, grain) * 1.05; rough = 0.6; }       // 坐板
  else { alb = vec3(0.10, 0.07, 0.05); rough = 0.7; }                          // 舷边深色木
  // 水线以下：被水浸湿、颜色更深
  float below = smoothstep(0.02, -0.02, vPos.z);
  alb *= mix(1., 0.6, below);
  float ndl = max(dot(N, uSun), 0.);
  vec3 skyAmb = mix(vec3(0.16, 0.18, 0.20), vec3(0.36, 0.50, 0.78), clamp(N.z * 0.5 + 0.5, 0., 1.)) * 0.95;
  vec3 sunRad = vec3(1.0, 0.89, 0.74) * 2.6;
  vec3 attC = vec3(1.0); float cw = 1.;
  if (vPos.z < 0.0) { float d = -vPos.z; attC = exp(-uSigma * d / max(uSun.z, 0.35)); cw = texture(uCaust, vPos.xy / uDom).r; skyAmb *= exp(-uSigma * d * 1.2); }
  vec3 V = normalize(uCam - vPos); vec3 H = normalize(uSun + V);
  float spec = pow(max(dot(N, H), 0.), mix(90., 20., rough)) * (1. - rough) * 0.6;
  float sh = shadowAt(vPos, N);
  vec3 col = alb * (sunRad * ndl * sh * cw * attC + skyAmb) + sunRad * spec * ndl * sh * attC * 0.35;
  o = vec4(col, 1.);
}`;

// ───────── 锚绳（实色带法线）─────────
export const ROPE_FRAG = HEAD + COMMON + `
uniform vec3 uCam; uniform float uClipWater;
in vec3 vPos; in vec3 vNrm; in vec2 vUv; in float vMat; in vec3 vLocal; out vec4 o;
void main(){
  if (uClipWater > 0.5 && vPos.z < -0.005) discard;
  vec3 N = normalize(vNrm);
  float twist = 0.8 + 0.2 * sin(vUv.x * 120. + vUv.y * 6.);
  vec3 alb = vec3(0.55, 0.45, 0.28) * twist;
  float ndl = max(dot(N, uSun), 0.);
  vec3 col = alb * (vec3(1.0, 0.89, 0.74) * 2.6 * ndl + vec3(0.25, 0.32, 0.45));
  o = vec4(col, 1.);
}`;

// ───────── 水花粒子 ─────────
export const SPRAY_VERT = HEAD + `
layout(location=0) in vec3 aPos; layout(location=1) in float aSize; layout(location=2) in float aA;
uniform mat4 uVP; uniform vec3 uCam; uniform float uPx;
out float vA;
void main(){ vec4 c = uVP * vec4(aPos, 1.); gl_Position = c; float d = max(c.w, 0.2); gl_PointSize = clamp(aSize * 2. * uPx / d, 1.6, 16.); vA = aA; }`;
export const SPRAY_FRAG = HEAD + COMMON + `
in float vA; out vec4 o;
void main(){
  vec2 c = gl_PointCoord * 2. - 1.; float r2 = dot(c, c); if (r2 > 1.) discard;
  float soft = smoothstep(1., 0.15, r2);
  vec3 col = vec3(0.95, 0.97, 1.0) * (0.55 + 0.9 * uSun.z) + vec3(0.3, 0.4, 0.55) * 0.15;
  o = vec4(col, soft * clamp(vA * 1.4, 0., 1.) * 0.62);
}`;

export const SHADOW_VERT = HEAD + `
layout(location=0) in vec3 aPos; uniform mat4 uLightVP; uniform mat4 uModel;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos, 1.); }`;
export const SHADOW_FRAG = HEAD + `
out vec4 o; void main(){ o = vec4(1.); }`;
