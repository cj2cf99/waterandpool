// 无头截图：node tools/capture.mjs [场景名 ...]。输出到 out/。
// 用法示例：node tools/capture.mjs smoke calm breeze
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');   // 全局安装的 playwright（云端预装）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out'); fs.mkdirSync(outDir, { recursive: true });
const PORT = 8791;
const server = spawn('node', [path.join(root, 'tools/dev-server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

// 场景：风速、风向、预热秒数、相机 {yaw,pitch,dist,target}，输出文件
const CAMS = {
  overview: { yaw: 3.45, pitch: 0.21, dist: 21, target: [19.5, 9.6, 0.1] },
  glint:    { yaw: 3.25, pitch: 0.10, dist: 16, target: [17, 9.5, 0.0] },
  boat:     { yaw: 4.0, pitch: 0.22, dist: 5.2, target: [13.6, 9.2, 0.05] },
  shore:    { yaw: 3.7, pitch: 0.20, dist: 7.5, target: [22.5, 5.0, 0.05] },
  rocks:    { yaw: 3.55, pitch: 0.22, dist: 6.5, target: [20.2, 14.2, 0.2] },
  top:      { yaw: 3.14, pitch: 1.3, dist: 24, target: [15, 9.6, 0.0] },
};
export const SCENES = {
  smoke:  { U: 4, dir: 15, warm: 0.5, file: 'smoke.png', w: 960, h: 540, ssaa: 1 },
  calm:   { U: 0.5, dir: 15, warm: 25, file: 'wind00_calm.png' },
  breeze: { U: 4, dir: 15, warm: 40, file: 'wind04_breeze.png' },
  moderate: { U: 8, dir: 15, warm: 50, file: 'wind08_moderate.png' },
  strong: { U: 13, dir: 15, warm: 60, file: 'wind13_strong.png' },
  storm:  { U: 19, dir: 15, warm: 70, file: 'wind19_storm.png' },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
let failed = 0;
for (const name of names) {
  const sc = SCENES[name]; if (!sc) { console.log('未知场景', name); continue; }
  const page = await browser.newPage({ viewport: { width: sc.w || 1280, height: sc.h || 720 } });
  const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(String(e)));
  const url = `http://127.0.0.1:${PORT}/?capture&w=${sc.w || 1280}&h=${sc.h || 720}&ssaa=${sc.ssaa ?? 1.5}&U=${sc.U}&dir=${sc.dir}`;
  await page.goto(url);
  try { await page.waitForFunction('window.__ready === true', null, { timeout: 60000 }); } catch (e) { console.log(name, '页面未就绪', errs.join('\n').slice(0, 3000)); failed++; await page.close(); continue; }
  const t0 = Date.now();
  await page.evaluate(({ U, dir, warm, cam }) => { const w = window.__water; w.setWind(U, dir); w.advance(warm); if (cam) Object.assign(w.cam, cam); if (cam && cam.target) w.cam.target = cam.target; }, sc);
  await page.evaluate(() => window.__water.draw());
  const dataUrl = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
  fs.writeFileSync(path.join(outDir, sc.file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`${name} -> out/${sc.file} (${((Date.now() - t0) / 1000).toFixed(1)}s)${errs.length ? '\n  JS错误: ' + errs.join('\n  ').slice(0, 1500) : ''}`);
  if (errs.length) failed++;
  await page.close();
}
await browser.close(); server.kill();
process.exit(failed ? 1 : 0);
