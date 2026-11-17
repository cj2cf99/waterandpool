// 地形：一个朝西敞开的小水域，东侧是沙滩，东北侧岸边有一组石头，近岸有一道沙洲。
// 坐标：x 向东（离岸 → 岸），y 向北，z 向上；静水面 z = 0。
export const DOMAIN = { nx: 192, ny: 128, dx: 0.15 };
export const WIDTH = DOMAIN.nx * DOMAIN.dx;   // 28.8 m
export const LENGTH = DOMAIN.ny * DOMAIN.dx;  // 19.2 m

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const softplus = (s, w) => w * Math.log(1 + Math.exp(s / w));

// 石头：{x,y 位置, R 半径, H 高度(相对当地床面), p 边缘陡度}
export const ROCKS = [
  { x: 19.9, y: 14.7, R: 0.95, H: 0.95, p: 2.3 },
  { x: 20.9, y: 13.6, R: 0.58, H: 0.62, p: 2.4 },
  { x: 19.0, y: 13.6, R: 0.50, H: 0.50, p: 2.4 },
  { x: 21.1, y: 15.5, R: 0.55, H: 0.66, p: 2.3 },
  { x: 18.3, y: 15.1, R: 0.66, H: 0.52, p: 2.4 },   // 半没入水中
  { x: 20.2, y: 12.7, R: 0.34, H: 0.30, p: 2.3 },
  { x: 17.6, y: 13.7, R: 0.30, H: 0.22, p: 2.3 },
  { x: 15.4, y: 12.4, R: 0.42, H: 0.34, p: 2.2 },   // 水下石头，水浅时露头
  { x: 13.6, y: 6.2, R: 0.32, H: 0.24, p: 2.2 },
  { x: 17.0, y: 4.2, R: 0.36, H: 0.20, p: 2.2 },
  { x: 14.8, y: 8.0, R: 0.20, H: 0.12, p: 2.0 },
  { x: 11.8, y: 11.2, R: 0.24, H: 0.14, p: 2.0 },
];
// 石头的不规则外形：半径随方位角扰动
function rockD(r, x, y) {
  const dx = x - r.x, dy = y - r.y, a = Math.atan2(dy, dx);
  const w = 1 + 0.26 * Math.sin(3 * a + r.x * 1.7) + 0.16 * Math.sin(5 * a + r.y * 2.3) + 0.08 * Math.sin(9 * a + r.x * r.y);
  return Math.hypot(dx, dy) / (r.R * w);
}

function baseBed(x, y) {
  const Ly = LENGTH;
  // 海岸线弯曲（岬角/海湾），让浪舌形态不单调
  const xs = x - 2.1 * Math.sin(2 * Math.PI * y / Ly * 1.15 + 0.6) - 0.95 * Math.sin(2 * Math.PI * y / Ly * 2.9 + 1.9) - 0.30 * Math.sin(2 * Math.PI * y / Ly * 7.3 + 0.3);   // 海岸线：岬角、海湾、沙滩尖角
  let b = -0.9 + 0.072 * softplus(xs - 8.8, 0.9);                    // 平底 → 缓坡（约 1:14）
  b += 0.16 * Math.exp(-((xs - 12.3) ** 2) / 1.5);                   // 沙洲
  b += 2.5 * (1 - Math.exp(-Math.pow(Math.max(0, xs - 21.5) / 8.5, 2)));        // 沙丘缓缓升高到 ~2.5m 后趋平
  b += 0.45 * Math.sin(x * 0.31 + 1.7) * Math.sin(y * 0.23 + 0.4) * sstep(24, 34, xs);   // 沙丘起伏
  b += 7 * sstep(48, 120, xs);                                                // 远处丘陵（背景）
  return b;
}

// 近海加深（x<0，仅渲染用）、南北岬角（把水域围成海湾，隐藏模拟域的侧边界）
function sideRise(x, y0) {
  const taper = sstep(-60, -20, x);
  const y = y0 + 0.7 * Math.sin(x * 0.27 + 1.1) + 0.35 * Math.sin(x * 0.71);          // 南北岸线也要弯曲
  const Y0 = y0; 
  const north = 1.05 * sstep(LENGTH - 2.4, LENGTH - 0.2, y) + 3.8 * sstep(LENGTH, LENGTH + 28, y);
  const south = 1.05 * sstep(2.4, 0.2, y) + 3.8 * sstep(0, -28, y);
  return taper * (north + south);
}
export function bedHeight(x, y) {
  let b = baseBed(x, y);
  if (x < 0) b = -0.9 - 2.1 * sstep(0, 25, -x);
  b += sideRise(x, y);
  for (const r of ROCKS) {
    const d = rockD(r, x, y);
    if (d < 1.8) {
      const base = Math.max(baseBed(r.x, r.y), -0.55);
      const top = 0.035 * Math.sin(x * 11.3 + y * 3.1) * Math.sin(y * 9.7 - x * 2.3);       // 顶面起伏
      b = Math.max(b, base - 0.25 + (r.H + 0.25) * Math.exp(-Math.pow(d, r.p) * 1.5) + top * Math.exp(-d * d));
    }
  }
  return b;
}

// 石头权重 0..1（用于着色）：该点高度明显由石头抬起
export function rockMask(x, y) {
  let m = 0;
  for (const r of ROCKS) {
    const d = rockD(r, x, y);
    if (d < 1.8) {
      const lift = bedHeight(x, y) - baseBed(x, y);
      m = Math.max(m, sstep(0.03, 0.18, lift));
    }
  }
  return m;
}

export function makeBed(nx = DOMAIN.nx, ny = DOMAIN.ny, dx = DOMAIN.dx) {
  const bed = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) bed[j * nx + i] = bedHeight((i + 0.5) * dx, (j + 0.5) * dx);
  return bed;
}
