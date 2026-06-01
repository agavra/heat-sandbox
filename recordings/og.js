#!/usr/bin/env node
//============================================================================
// Open Graph image generator
//
// Drives the live index.html in headless Chrome, builds a full-bleed grid of
// per-workload sparklines (reusing the page's own miniLine/heatGrad), overlays
// the title + tagline, and screenshots a 1200x630 PNG to ../og.png.
//
// Usage:
//   cd recordings && node og.js
//
// Env:
//   CHROME_PATH   path to a Chrome/Chromium binary (default: macOS Chrome)
//============================================================================
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const INDEX = 'file://' + path.resolve(__dirname, '..', 'index.html');
const OUT = path.resolve(__dirname, '..', 'og.png');
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const W = 1200, H = 630;
const COLS = 8, ROWS = 11;                 // grid that fills the frame
const TITLE = 'Simulating Multi-tenancy';
const TAGLINE = 'When does a fleet of spiky workloads balance itself out?';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await page.goto(INDEX, { waitUntil: 'networkidle0' });

  await page.evaluate((cfg) => {
    // neutral background, then run the real simulation to populate SIM
    document.documentElement.style.setProperty('--bg', '#FAFAFA');
    Object.assign(P, { rho: 0, spikiness: 0.7, sizeskew: 0.7, seed: 7 });
    simulate();
    const { series, sizes } = SIM;

    // shared 0-cap heat scale across tiles (97th pct of the shown sample)
    const n = cfg.cols * cfg.rows, samp = [];
    for (let i = 0; i < n; i++) for (let t = 0; t < T; t += 3) samp.push(series[i * T + t] * sizes[i]);
    samp.sort((a, b) => a - b);
    const cap = Math.min(10, Math.max(2.2, (samp[Math.floor(samp.length * 0.97)] || 3) * 1.08));

    // replace the page with a clean OG canvas: full-bleed grid + centered title
    const fmtSz = (s) => '×' + (s < 9.95 ? s.toFixed(1) : Math.round(s));
    let tiles = '';
    for (let i = 0; i < n; i++) {
      tiles += `<div class="ogt"><span class="lab">w${String(i).padStart(2, '0')}</span>` +
        `<canvas class="ogs" data-i="${i}"></canvas><span class="sz">${fmtSz(sizes[i])}</span></div>`;
    }
    document.body.innerHTML =
      `<div id="og">
         <div id="oggrid">${tiles}</div>
         <div id="ogwash"></div>
         <div id="ogtxt"><div class="ttl">${cfg.title}</div><div class="tag">${cfg.tagline}</div></div>
       </div>`;

    const st = document.createElement('style');
    st.textContent = `
      html,body{margin:0;padding:0;background:var(--bg)}
      #og{position:relative;width:${cfg.W}px;height:${cfg.H}px;overflow:hidden;background:var(--bg);
        font-family:${MONO}}
      #oggrid{position:absolute;inset:0;display:grid;gap:9px 14px;padding:26px 30px;
        grid-template-columns:repeat(${cfg.cols},1fr);
        grid-template-rows:repeat(${cfg.rows},1fr);opacity:.62}
      .ogt{display:flex;align-items:center;gap:6px;overflow:hidden;white-space:nowrap}
      .ogt .lab{color:var(--faint);font-size:11px;flex:0 0 auto;font-variant-numeric:tabular-nums}
      .ogt .sz{color:var(--amber);font-size:10px;flex:0 0 auto;font-variant-numeric:tabular-nums}
      canvas.ogs{display:block;width:100%;height:100%;flex:1 1 auto;min-width:0}
      /* horizontal light band so the centered text stays legible over the grid */
      #ogwash{position:absolute;inset:0;background:linear-gradient(to bottom,
        rgba(250,250,250,0) 26%,rgba(250,250,250,.93) 44%,rgba(250,250,250,.93) 56%,
        rgba(250,250,250,0) 74%)}
      #ogtxt{position:absolute;inset:0;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:14px;text-align:center}
      #ogtxt .ttl{font-size:58px;font-weight:680;color:var(--text);letter-spacing:.01em}
      #ogtxt .ttl::before{content:"▌ ";color:var(--accent)}
      #ogtxt .tag{font-size:23px;font-weight:500;color:var(--dim);letter-spacing:.01em}`;
    document.head.appendChild(st);

    // draw each sparkline with the page's own renderer
    document.querySelectorAll('canvas.ogs').forEach((cv) => {
      const i = +cv.dataset.i; miniLine(cv, series, i, cap, sizes[i]);
    });
  }, { W, H, cols: COLS, rows: ROWS, title: TITLE, tagline: TAGLINE });

  await new Promise((r) => setTimeout(r, 80));
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: W, height: H } });
  await browser.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`-> ${path.relative(path.resolve(__dirname, '..'), OUT)} (${W}x${H}, ${kb} KiB)`);
})();
