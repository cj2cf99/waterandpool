// 仿真 Worker：以接近实时的速度推进 Simulation，并把快照发给主线程
import { Simulation } from './sim.js';
let sim = null, speed = 1, paused = false, last = 0, running = false, stat = { simRate: 1, ms: 0 };
let opts = {};
function init(o) { opts = o; sim = new Simulation(o); sim.setWind(o.U ?? 4, o.dirDeg ?? 15); if (!running) { running = true; last = performance.now(); loop(); } }
function loop() {
  const now = performance.now(); let wall = Math.min(0.1, (now - last) / 1000); last = now;
  if (sim && !paused) {
    const t0 = performance.now();
    const dt = Math.min(wall * speed, 1 / 20);
    if (dt > 0) sim.step(dt);
    const ms = performance.now() - t0;
    stat.ms = stat.ms * 0.9 + ms * 0.1; stat.simRate = stat.simRate * 0.9 + (wall > 0 ? (dt / wall) : 1) * 0.1;
  }
  if (sim) { const snap = sim.snapshot(); snap.stat = { ...stat, steps: sim.stats.steps }; const tr = [snap.eta.buffer, snap.depth.buffer, snap.foam.buffer, snap.wet.buffer, snap.vel.buffer, snap.spray.buffer]; postMessage({ type: 'snap', snap }, tr); }
  setTimeout(loop, 4);
}
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m.opts);
  else if (!sim) return;
  else if (m.type === 'wind') sim.setWind(m.U, m.dir);
  else if (m.type === 'gust') sim.windMode = m.on ? 'gusty' : 'steady';
  else if (m.type === 'drop') sim.drop(m.x, m.y, m.s ?? 0.07, m.r ?? 0.35);
  else if (m.type === 'rope') { if (sim.boat.rope) sim.boat.rope.on = m.on; }
  else if (m.type === 'speed') speed = m.v;
  else if (m.type === 'pause') paused = m.v;
};
