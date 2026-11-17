// 总测试入口：依次运行物理/仿真/浏览器测试，汇总 A/C/D 分与 B 自评，打印总分。
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const run = (f) => { const r = spawnSync('node', ['tools/' + f], { stdio: 'inherit' }); return r.status === 0; };
const ok = ['test-physics.mjs', 'test-sim.mjs', 'test-browser.mjs'].map(run);
const rd = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
const all = { ...rd('out/physics-scores.json'), ...rd('out/sim-scores.json'), ...rd('out/browser-scores.json') };
let A = 0, C = 0;
for (const [k, v] of Object.entries(all)) { if (k[0] === 'A') A += v.score; if (k[0] === 'C') C += v.score; console.log(k, v.score + '/' + (v.max ?? 5)); }
const B = Object.values(rd('docs/VISUAL_SCORES.json').scores ?? {}).reduce((s, v) => s + v.score, 0);
const D1 = ok.every(Boolean) ? 4 : 0;
const D2 = ['README.md', 'docs/DEVELOPMENT.md'].every(existsSync) ? 3 : 0;
const D3 = existsSync('tools/capture.mjs') ? 3 : 0;
const total = A + B + C + D1 + D2 + D3;
console.log(`\nA=${A}/40  B=${B}/40（自评）  C=${C}/10  D=${D1 + D2 + D3}/10  总分=${total}/100`);
process.exit(total >= 90 && D1 ? 0 : 1);
