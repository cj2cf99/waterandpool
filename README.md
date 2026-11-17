# water-sim：沙滩小水域实时模拟

浏览器实时模拟：清澈水体、不同风力下的风浪、水冲上沙滩、浪拍岸石的浪花，以及只受水作用（不直接受风）的小木船。
零依赖、无构建，原生 ES Modules + WebGL2，推荐 Chrome / Edge。

## 运行
```bash
node tools/dev-server.mjs   # 然后打开 http://127.0.0.1:8765/
```
测试：`npm test`（物理、仿真、浏览器测试；浏览器测试需要 Playwright + Chromium）。
截图：`node tools/capture.mjs <场景名>`，输出到 `out/`。

## 操作
- 左键拖动旋转，右键拖动平移，滚轮缩放，点击水面投一块石子。
- 面板：风速/风向滑块与预设、阵风、锚绳、跟随船、画质、速度、暂停。

## 原理
- 2D 浅水方程有限体积法（静水重构、HLL 通量、MUSCL、SSP-RK2），湿干前沿处理实现岸上冲。
- 风：风应力入 SWE；西侧开边界造涌浪（JONSWAP）；渲染端叠加 Gerstner 风浪。
- 船：刚体 + 浮力柱 + 阻力 + 附加质量，与水双向耦合；代码中没有任何风力项。
- 泡沫、湿沙记忆、水花粒子由波陡/弗劳德数/撞击触发。
详见 `docs/DEVELOPMENT.md`，验收标准见 `docs/ACCEPTANCE.md`，得分见 `docs/SCORES.md`。
