// 地形：一个朝西敞开的小水域，东侧是沙滩，东北侧岸边有一组石头，近岸有一道沙洲。
// 坐标：x 向东（离岸 → 岸），y 向北，z 向上；静水面 z = 0。
export const DOMAIN = { nx: 192, ny: 128, dx: 0.15 };
export const WIDTH = DOMAIN.nx * DOMAIN.dx;   // 28.8 m
export const LENGTH = DOMAIN.ny * DOMAIN.dx;  // 19.2 m

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const softplus = (s, w) => w * Math.log(1 + Math.exp(s / w));

// 石头：{x,y 位置, R 半径, H 高度(相对当地床面), p 边缘陡度}
export const ROCKS = [
  { x: 19.9, y: 14.6, R: 0.80, H: 1.05, p: 3.2 },
  { x: 20.7, y: 13.7, R: 0.55, H: 0.80, p: 3.0 },
  { x: 19.3, y: 13.5, R: 0.46, H: 0.62, p: 3.0 },
  { x: 21.0, y: 15.3, R: 0.50, H: 0.70, p: 3.0 },
  { x: 18.1, y: 15.0, R: 0.62, H: 0.50, p: 3.0 },   // 半没入水中的石头
  { x: 15.4, y: 12.4, R: 0.40, H: 0.34, p: 2.8 },   // 水下石头，水浅时露头
  { x: 13.6, y: 6.2, R: 0.30, H: 0.24, p: 2.6 },
  { x: 17.0, y: 4.2, R: 0.34, H: 0.20, p: 2.6 },
];

function baseBed(x, y) {
  const Ly = LENGTH;
  // 海岸线弯曲（岬角/海湾），让浪舌形态不单调
  const xs = x - 1.6 * Math.sin(2 * Math.PI * y / Ly * 1.15 + 0.6) - 0.55 * Math.sin(2 * Math.PI * y / Ly * 2.9 + 1.9);
  let b = -0.9 + 0.072 * softplus(xs - 8.8, 0.9);                    // 平底 → 缓坡（约 1:14）
  b += 0.16 * Math.exp(-((xs - 12.3) ** 2) / 1.5);                   // 沙洲
  b += 0.022 * Math.max(0, xs - 22.2) ** 2;                          // 沙丘
  return b;
}

export function bedHeight(x, y) {
  let b = baseBed(x, y);
  for (const r of ROCKS) {
    const d = Math.hypot(x - r.x, y - r.y) / r.R;
    if (d < 1.6) {
      const base = Math.max(baseBed(r.x, r.y), -0.55);
      b = Math.max(b, base - 0.25 + (r.H + 0.25) * Math.exp(-Math.pow(d, r.p) * 1.4));
    }
  }
  return b;
}

// 石头权重 0..1（用于着色）：该点高度明显由石头抬起
export function rockMask(x, y) {
  let m = 0;
  for (const r of ROCKS) {
    const d = Math.hypot(x - r.x, y - r.y) / r.R;
    if (d < 1.6) {
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
