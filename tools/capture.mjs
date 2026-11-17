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
  smoke:    { U: 4, dir: 15, warm: 0.5, file: 'smoke.png', w: 960, h: 540, ssaa: 1, cam: CAMS.overview },
  calm:     { U: 0.5, dir: 15, warm: 30, file: 'wind00_calm.png', cam: CAMS.overview },
  breeze:   { U: 4, dir: 15, warm: 45, file: 'wind04_breeze.png', cam: CAMS.overview },
  moderate: { U: 8, dir: 15, warm: 55, file: 'wind08_moderate.png', cam: CAMS.overview },
  strong:   { U: 13, dir: 15, warm: 65, file: 'wind13_strong.png', cam: CAMS.overview },
  storm:    { U: 19, dir: 15, warm: 70, file: 'wind19_storm.png', cam: CAMS.overview },
  glint:    { U: 6, dir: 15, warm: 50, file: 'view_glint.png', cam: CAMS.glint },
  boat:     { follow: true, U: 6, dir: 15, warm: 50, file: 'view_boat.png', cam: CAMS.boat },
  shore:    { U: 8, dir: 15, warm: 55, file: 'view_shore.png', cam: CAMS.shore },
  rocks:    { U: 11, dir: 15, warm: 60, file: 'view_rocks.png', cam: CAMS.rocks },
  top:      { U: 8, dir: 15, warm: 55, file: 'view_top.png', cam: CAMS.top },
  swashSeq: { U: 10, dir: 15, warm: 50, file: 'seq_swash.png', cam: CAMS.shore, seq: { n: 6, dt: 0.9 }, w: 800, h: 450 },
  rockSeq:  { U: 12, dir: 15, warm: 60, file: 'seq_rocks.png', cam: CAMS.rocks, seq: { n: 6, dt: 0.45 }, w: 800, h: 450 },
  boatSeq:  { follow: true, U: 13, dir: 15, warm: 60, file: 'seq_boat.png', cam: CAMS.boat, seq: { n: 6, dt: 0.6 }, w: 800, h: 450 },
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
  await page.evaluate(({ U, dir, warm, cam, follow }) => { const w = window.__water; w.setWind(U, dir); w.advance(warm); if (cam) Object.assign(w.cam, cam); if (cam && cam.target) w.cam.target = [...cam.target]; if (follow) { const b = w.sim.boat.pos; w.cam.target = [b[0], b[1], 0.05]; } }, sc);
  if (sc.seq) {
    // 连拍 n 帧（每帧间隔 dt 秒仿真时间），拼成 3 列联系表，一次导出
    const urls = [];
    for (let i = 0; i < sc.seq.n; i++) {
      await page.evaluate(() => window.__water.draw());
      urls.push(await page.evaluate(() => document.getElementById('c').toDataURL('image/png')));
      await page.evaluate((dt) => window.__water.advance(dt), sc.seq.dt);
    }
    const sheet = await page.evaluate(async ({ urls, w, h }) => {
      const cols = 3, rows = Math.ceil(urls.length / cols), cv = document.createElement('canvas'); cv.width = w * cols; cv.height = h * rows; const g = cv.getContext('2d');
      for (let i = 0; i < urls.length; i++) { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = urls[i]; }); g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h); }
      return cv.toDataURL('image/png');
    }, { urls, w: sc.w || 1280, h: sc.h || 720 });
    fs.writeFileSync(path.join(outDir, sc.file), Buffer.from(sheet.split(',')[1], 'base64'));
  } else {
    await page.evaluate(() => window.__water.draw());
    const dataUrl = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
    fs.writeFileSync(path.join(outDir, sc.file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log(`${name} -> out/${sc.file} (${((Date.now() - t0) / 1000).toFixed(1)}s)${errs.length ? '\n  JS错误: ' + errs.join('\n  ').slice(0, 1500) : ''}`);
  if (errs.length) failed++;
  await page.close();
}
await browser.close(); server.kill();
process.exit(failed ? 1 : 0);
