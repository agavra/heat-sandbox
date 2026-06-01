#!/usr/bin/env node
//============================================================================
// Heat-sandbox GIF recorder
//
// Drives the live index.html in headless Chrome, sweeps one parameter across
// frames, screenshots the chosen panel(s), and assembles a GIF with ffmpeg.
//
// Usage:
//   cd recordings && npm install
//   node record.js <recipe>      # e.g. node record.js skew-sweep
//   node record.js all           # render every recipe
//   node record.js --list        # list recipe names
//
// Env:
//   CHROME_PATH   path to a Chrome/Chromium binary (default: macOS Chrome)
//
// Output GIFs land in ../gifs/ (gitignored). Frames go to a temp dir.
//============================================================================
const puppeteer = require('puppeteer-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INDEX = 'file://' + path.resolve(__dirname, '..', 'index.html');
const GIF_DIR = path.resolve(__dirname, '..', 'gifs');
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

//----------------------------------------------------------------------------
// Recipes — each produces ../gifs/<out>. See README.md for what each shows.
//
//   base      : knob values held fixed (rho, spikiness, sizeskew, seed, N)
//   sweep     : { param, from, to, frames, scale, exp }
//               param: 'N' (derive-only) | 'rho' | 'sizeskew' | 'spikiness'
//               scale: 'linear' | 'log' | 'pow' (uses exp, ease-out if exp<1)
//   fps       : gif frame rate
//   panels    : which panels to capture: ['aggregate'], ['peakmean'], or both
//               (both => stacked vertically, aggregate on top)
//   fixedAxis : pin the aggregate y-axis (auto-measured across the sweep) so
//               rising spikes grow instead of being renormalized each frame
//   badge     : null | 'rho' | 'sizeskew' | 'spikiness' | 'N'
//               draws a cut-in "--flag value" label in the aggregate top-right
//----------------------------------------------------------------------------
const RECIPES = {
  // Idealized aggregate: independent, equal-sized workloads average out to flat.
  'aggregate': {
    base: { rho: 0, spikiness: 0.44, sizeskew: 0, seed: 7 },
    sweep: { param: 'N', from: 1, to: 5e6, frames: 100, scale: 'log' },
    fps: 10, panels: ['aggregate'], fixedAxis: false, badge: null,
  },
  // Same, but with 10% correlation — never quite flattens (correlation floor).
  'aggregate-corr10': {
    base: { rho: 0.1, spikiness: 0.44, sizeskew: 0, seed: 7 },
    sweep: { param: 'N', from: 1, to: 5e6, frames: 100, scale: 'log' },
    fps: 10, panels: ['aggregate'], fixedAxis: false, badge: null,
  },
  // Fixed N=2000, sweep correlation 0 -> 50%. Floor rises; spikes synchronize.
  'corr-sweep': {
    base: { rho: 0, spikiness: 0.44, sizeskew: 0, seed: 7, N: 2000 },
    sweep: { param: 'rho', from: 0, to: 0.5, frames: 80, scale: 'linear' },
    fps: 10, panels: ['aggregate', 'peakmean'], fixedAxis: true, badge: 'rho',
  },
  // Fixed N=2000, sweep size-skew 0 -> 100% (eased). A few elephants dominate.
  // seed 30 chosen so the sampled day's peak/mean ~= the typical fleet (panels agree).
  'skew-sweep': {
    base: { rho: 0, spikiness: 0.7, sizeskew: 0, seed: 30, N: 2000 },
    sweep: { param: 'sizeskew', from: 0, to: 1.0, frames: 80, scale: 'pow', exp: 0.6 },
    fps: 10, panels: ['aggregate', 'peakmean'], fixedAxis: true, badge: 'sizeskew',
  },
};

const FLAG = { rho: '--corr', sizeskew: '--size-skew', spikiness: '--spikiness', N: '--fleet' };

//----------------------------------------------------------------------------
// Helpers
//----------------------------------------------------------------------------
const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K'
    : Math.round(n).toString();

// value of the swept param at frame i (0..frames-1)
function valueAt(sweep, i) {
  const t = sweep.frames === 1 ? 0 : i / (sweep.frames - 1);
  let v;
  if (sweep.scale === 'log') v = Math.pow(10, Math.log10(sweep.from || 1) + (Math.log10(sweep.to) - Math.log10(sweep.from || 1)) * t);
  else if (sweep.scale === 'pow') v = sweep.from + (sweep.to - sweep.from) * Math.pow(t, sweep.exp ?? 1);
  else v = sweep.from + (sweep.to - sweep.from) * t;
  return sweep.param === 'N' ? Math.max(1, Math.round(v)) : v;
}

// label shown in the badge for a swept value
function badgeText(param, v) {
  const val = param === 'N' ? fmtN(v) : Math.round(v * 100) + '%';
  return `<span style="color:var(--purple)">${FLAG[param]}</span> ` +
    `<span style="color:var(--accent)">${val}</span>`;
}

// "nice" gridline step giving <=5 intervals up to ymax (1/2/5 x 10^k)
function niceStep(ymax) {
  for (let k = 0; k < 9; k++) for (const m of [1, 2, 5]) {
    const s = m * Math.pow(10, k);
    if (ymax / s <= 5) return s;
  }
  return ymax;
}

//----------------------------------------------------------------------------
// drawTimeline override (string) — pins the aggregate y-axis to window.FIXED_YMAX
// with gridlines every window.FIXED_STEP. Faithful copy of the page's function
// otherwise. Injected only when recipe.fixedAxis is set.
//----------------------------------------------------------------------------
function fixedAxisOverride() {
  window.drawTimeline = function () {
    const cv = document.getElementById('timeline');
    const { ctx, w, h } = setup(cv);
    const padL = 54, padR = 14, padT = 12, padB = 24,
      x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
    const { D: agg } = VIEW;
    let dmax = 0, dmin = Infinity;
    for (let t = 0; t < T; t++) { if (agg[t] > dmax) dmax = agg[t]; if (agg[t] < dmin) dmin = agg[t]; }
    if (!isFinite(dmin)) dmin = 0;
    const ymax = window.FIXED_YMAX || 1, step = window.FIXED_STEP || 1; // defaults during pass-1 measurement
    const X = t => x0 + (x1 - x0) * t / (T - 1), Y = v => y1 - (y1 - y0) * v / ymax;
    const fmtAx = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : Math.round(v).toString();
    for (let v = 0; v <= ymax + 1; v += step) gridY(ctx, x0, x1, Y(v), fmtAx(v));
    const heat = heatGrad(ctx, Y(dmax), Y(dmin > dmax - 1e-9 ? 0 : dmin));
    ctx.beginPath();
    for (let t = 0; t < T; t++) { const x = X(t), y = Y(agg[t]); t ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.lineTo(X(T - 1), y1); ctx.lineTo(X(0), y1); ctx.closePath();
    ctx.fillStyle = heat; ctx.globalAlpha = .1; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = heat; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let t = 0; t < T; t++) { const x = X(t), y = Y(agg[t]); t ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
    ctx.fillStyle = css('--dim'); ctx.font = '10px ' + MONO; ctx.textAlign = 'center';
    for (let hI = 0; hI <= 24; hI += 6) { const t = hI / 24 * (T - 1); ctx.fillText(hI + 'h', X(t), h - 7); }
  };
}

//----------------------------------------------------------------------------
// Render one recipe
//----------------------------------------------------------------------------
async function render(name, recipe) {
  const { base, sweep, fps, panels, fixedAxis, badge } = recipe;
  const showAgg = panels.includes('aggregate');
  const showPk = panels.includes('peakmean');
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-frames-'));
  const outPath = path.join(GIF_DIR, name + '.gif');
  fs.mkdirSync(GIF_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--force-device-scale-factor=2'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 2 });
  await page.goto(INDEX, { waitUntil: 'networkidle0' });

  // initial setup: knobs, neutral background, layout, optional axis override + badge
  await page.evaluate((cfg) => {
    document.documentElement.style.setProperty('--bg', '#FAFAFA');
    document.documentElement.style.setProperty('--panel', '#FAFAFA');
    Object.assign(P, cfg.base);
    if (P.N == null) P.N = 1;
    simulate();

    document.getElementById('status').style.display = 'none';
    if (!cfg.showAgg) document.getElementById('timeline').closest('.panel').style.display = 'none';
    if (!cfg.showPk) document.getElementById('amort').closest('.panel').style.display = 'none';
    document.querySelector('.row2').style.gridTemplateColumns = '1fr';
    const st = document.createElement('style');
    st.textContent = '.row2 .panel.grow{height:300px} .panel.grow canvas{min-height:0}';
    document.head.appendChild(st);

    if (cfg.fixedAxis) eval('(' + cfg.override + ')()');

    if (cfg.badge && cfg.showAgg) {
      const b = document.createElement('div');
      b.id = 'sweepBadge';
      b.style.cssText = 'position:absolute;top:-0.72em;right:11px;background:var(--bg);' +
        'padding:0 7px;font-size:11.5px;font-weight:600;white-space:nowrap';
      document.getElementById('timeline').closest('.panel').appendChild(b);
    }
  }, { base, showAgg, showPk, fixedAxis, badge, override: fixedAxisOverride.toString() });

  // fixed axis: pass 1 — measure the tallest aggregate peak across the sweep
  if (fixedAxis) {
    let globalMax = 0;
    for (let i = 0; i < sweep.frames; i++) {
      const v = valueAt(sweep, i);
      const peak = await page.evaluate((p, val) => {
        P[p] = val; (p === 'N' ? derive : simulate)();
        let m = 0; for (let t = 0; t < VIEW.D.length; t++) if (VIEW.D[t] > m) m = VIEW.D[t];
        return m;
      }, sweep.param, v);
      if (peak > globalMax) globalMax = peak;
    }
    const ymax = Math.ceil(globalMax / 1000) * 1000;
    await page.evaluate((y, s) => { window.FIXED_YMAX = y; window.FIXED_STEP = s; }, ymax, niceStep(ymax));
    console.log(`  axis: peak=${Math.round(globalMax)} -> ymax=${ymax}`);
  }

  // pass 2 — render frames
  for (let i = 0; i < sweep.frames; i++) {
    const v = valueAt(sweep, i);
    const html = badge ? badgeText(sweep.param, v) : null;
    await page.evaluate((p, val, badgeHtml) => {
      P[p] = val; (p === 'N' ? derive : simulate)();
      if (badgeHtml) document.getElementById('sweepBadge').innerHTML = badgeHtml;
    }, sweep.param, v, html);
    await new Promise((r) => setTimeout(r, 20));
    const box = await page.evaluate((sa, sp) => {
      const rs = [];
      if (sa) rs.push(document.getElementById('timeline').closest('.panel').getBoundingClientRect());
      if (sp) rs.push(document.getElementById('amort').closest('.panel').getBoundingClientRect());
      const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
      return { x, y, width: Math.max(...rs.map(r => r.right)) - x, height: Math.max(...rs.map(r => r.bottom)) - y };
    }, showAgg, showPk);
    const pad = 12;
    await page.screenshot({
      path: path.join(framesDir, `frame_${String(i).padStart(3, '0')}.png`),
      clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + pad + 2 },
    });
  }
  await browser.close();

  // assemble with ffmpeg (palettegen for clean colors)
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame_%03d.png'),
    '-vf', 'split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a',
    '-loop', '0', outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(framesDir, { recursive: true, force: true });
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`  -> ${path.relative(path.resolve(__dirname, '..'), outPath)} (${sweep.frames}f @ ${fps}fps, ${kb} KiB)`);
}

//----------------------------------------------------------------------------
(async () => {
  const arg = process.argv[2];
  if (!arg || arg === '--list') {
    console.log('recipes:', Object.keys(RECIPES).join(', '), '\nusage: node record.js <recipe|all>');
    process.exit(arg ? 0 : 1);
  }
  const names = arg === 'all' ? Object.keys(RECIPES) : [arg];
  for (const n of names) {
    if (!RECIPES[n]) { console.error(`unknown recipe: ${n}`); process.exit(1); }
    console.log(`rendering ${n} ...`);
    await render(n, RECIPES[n]);
  }
})();
