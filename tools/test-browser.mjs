// C2/C3：真实浏览器（无头 Chromium + 软件 WebGL）里的功能与运行测试，走 Worker 路径。
// 用法：node tools/test-browser.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8792;
const server = spawn('node', [path.join(root, 'tools/dev-server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push(String(e)));
const checks = {};
await page.goto(`http://127.0.0.1:${PORT}/?ssaa=1`);
await page.waitForSelector('#stats');
// 等待首个仿真快照（统计行出现 fps）
await page.waitForFunction(() => /fps/.test(document.getElementById('stats').textContent), null, { timeout: 90000 });
const t0 = Date.now();
// —— C2：交互 ——
const stat = () => page.evaluate(() => document.getElementById('stats').textContent);
const wait = (ms) => page.waitForTimeout(ms);
// 风速滑杆
await page.evaluate(() => { const e = document.getElementById('wind'); e.value = 12; e.dispatchEvent(new Event('input')); });
await wait(2500); const s1 = await stat(); checks.windSlider = /有效风速 (\d+)/.test(s1) && Number(s1.match(/有效风速 ([\d.]+)/)[1]) > 6;
// 预设
await page.click('#presets button[data-u="20"]'); await wait(2500); const s2 = await stat(); checks.presets = Number(s2.match(/有效风速 ([\d.]+)/)[1]) > 10 && (await page.evaluate(() => document.getElementById('windv').textContent)).startsWith('20');
// 风向
await page.evaluate(() => { const e = document.getElementById('dir'); e.value = 180; e.dispatchEvent(new Event('input')); }); checks.dirSlider = (await page.evaluate(() => document.getElementById('dirv').textContent)).includes('离岸');
// 阵风/锚绳/跟船/画质/速度/暂停 按钮
await page.click('#gust'); checks.gustToggle = (await page.evaluate(() => document.getElementById('gust').textContent)) === '关'; await page.click('#gust');
await page.click('#rope'); checks.ropeToggle = (await page.evaluate(() => document.getElementById('rope').textContent)) === '关'; await page.click('#rope');
await page.click('#follow'); checks.followToggle = (await page.evaluate(() => document.getElementById('follow').textContent)) === '开'; await page.click('#follow');
await page.selectOption('#ssaa', '1'); checks.quality = true;
await page.evaluate(() => { const e = document.getElementById('speed'); e.value = 2; e.dispatchEvent(new Event('input')); }); checks.speed = (await page.evaluate(() => document.getElementById('speedv').textContent)) === '2.00×';
await page.evaluate(() => { const e = document.getElementById('speed'); e.value = 1; e.dispatchEvent(new Event('input')); });
await page.click('#pause'); checks.pause = (await page.evaluate(() => document.getElementById('pause').textContent)) === '继续'; await page.click('#pause');
// 相机：拖动 + 滚轮
const c = await page.$('#c'); const box = await c.boundingBox();
const grab = () => page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
const before = await grab();
await page.mouse.move(box.x + 320, box.y + 180); await page.mouse.down(); await page.mouse.move(box.x + 380, box.y + 165, { steps: 6 }); await page.mouse.up();
await page.mouse.wheel(0, -400); await wait(1500);
const after = await grab();
checks.camera = before !== after;
// 点击水面投石：点在水域中央偏下
await page.mouse.click(box.x + 250, box.y + 280); await wait(1500);
const sp = await stat(); checks.dropClick = /水花 \d+/.test(sp);
checks.uiComplete = ['windSlider', 'presets', 'dirSlider', 'gustToggle', 'ropeToggle', 'followToggle', 'quality', 'speed', 'pause', 'camera', 'dropClick'].every((k) => checks[k]);
// —— C3：运行 30 秒，无 JS 错误，画面不空白 ——
const remain = Math.max(0, 30000 - (Date.now() - t0)); await wait(remain);
const blank = await page.evaluate(() => { const cv = document.getElementById('c'); const t = document.createElement('canvas'); t.width = 64; t.height = 36; const g = t.getContext('2d'); g.drawImage(cv, 0, 0, 64, 36); const d = g.getImageData(0, 0, 64, 36).data; let m = 0, n = 0; for (let i = 0; i < d.length; i += 4) { m += d[i] + d[i + 1] + d[i + 2]; n++; } m /= n * 3; let v = 0; for (let i = 0; i < d.length; i += 4) { const x = (d[i] + d[i + 1] + d[i + 2]) / 3 - m; v += x * x; } return { mean: m, std: Math.sqrt(v / n) }; });
checks.nonBlank = blank.std > 8 && blank.mean > 20;
checks.noJsErrors = errs.length === 0;
fs.writeFileSync(path.join(root, 'out/app.png'), Buffer.from((await grab()).split(',')[1], 'base64'));
const c2 = checks.uiComplete ? 3 : 3 * Object.entries(checks).filter(([k]) => ['windSlider', 'presets', 'dirSlider', 'gustToggle', 'ropeToggle', 'followToggle', 'quality', 'speed', 'pause', 'camera', 'dropClick'].includes(k) && checks[k]).length / 11;
const c3 = (checks.noJsErrors ? 2 : 0) + (checks.nonBlank ? 1 : 0);
console.log('C2 界面功能', JSON.stringify(checks, null, 1));
console.log(`C2 得分 ${c2.toFixed(2)} / 3\nC3 浏览器运行：JS 错误 ${errs.length} 个${errs.length ? '\n  ' + errs.join('\n  ').slice(0, 800) : ''}，画面均值 ${blank.mean.toFixed(0)} 标准差 ${blank.std.toFixed(0)}\nC3 得分 ${c3.toFixed(2)} / 3`);
fs.writeFileSync(path.join(root, 'out/browser-scores.json'), JSON.stringify({ C2: { score: +c2.toFixed(2), max: 3, checks }, C3: { score: c3, max: 3, errors: errs.slice(0, 5), blank } }, null, 1));
await browser.close(); server.kill();
process.exit(c2 >= 3 && c3 >= 3 ? 0 : 1);
