# recordings/

Tooling to record the animated GIFs used in the blog post from the live
`index.html`. One script (`record.js`) drives the page in headless Chrome,
sweeps a parameter across frames, screenshots the chosen panel(s), and stitches
them into a GIF with ffmpeg.

The GIFs themselves live in `../gifs/` and are **gitignored** — regenerate them
from here. This directory (the recorder + recipes) is the source of truth.

## Prerequisites

- **Node** (tested on 26; anything modern works)
- **Google Chrome** installed. Default path is macOS
  (`/Applications/Google Chrome.app/...`); override with `CHROME_PATH=/path/to/chrome`.
- **ffmpeg** on your `PATH` (`brew install ffmpeg`).

## Setup

```sh
cd recordings
npm install          # installs puppeteer-core (uses your existing Chrome, no download)
```

## Usage

```sh
node record.js skew-sweep     # render one recipe -> ../gifs/skew-sweep.gif
node record.js all            # render every recipe
node record.js --list         # list recipe names
```

Each run prints the chosen fixed-axis ceiling (if any) and the output size.

## How it works

`record.js` loads `index.html`, then per recipe:

1. **Setup** — forces a neutral `#FAFAFA` background, sets the fixed knobs
   (`P.rho`, `P.spikiness`, `P.sizeskew`, `P.seed`, `P.N`), hides the status
   footer, and lays the two charts out vertically (`.row2` → single column).
   Only the requested panels are shown.
2. **Fixed axis (optional)** — for sweeps where spikes grow, it does a first
   pass measuring the tallest aggregate peak across the whole sweep, then pins
   the aggregate y-axis to a clean ceiling (via a `window.drawTimeline`
   override) so spikes *grow* instead of being renormalized every frame.
3. **Render** — for each frame it sets the swept parameter and re-runs the
   simulation, screenshots the panel region, and (optionally) updates a cut-in
   `--flag value` badge in the aggregate's top-right corner.
4. **Assemble** — ffmpeg with `palettegen`/`paletteuse` for clean GIF colors.

Key detail: sweeping **N** only needs `derive()` (the simulation is
N-independent); sweeping `rho` / `sizeskew` / `spikiness` re-runs `simulate()`.

## Recipes / what each GIF shows

All use `T=240` ticks/day, seed-deterministic, `#FAFAFA` background, ~1976px wide @ 2× DPR.

| recipe | fixed knobs | sweep | shows |
|---|---|---|---|
| `aggregate` | corr 0, spike 0.44, skew 0 | **N: 1 → 5M** (log), 100f/10fps | the idealized case — independent, equal-sized workloads average out from one spiky series to a dead-flat aggregate. Single full-width panel. |
| `aggregate-corr10` | corr **0.1**, spike 0.44, skew 0 | N: 1 → 5M (log), 100f/10fps | same sweep but 10% correlation — the aggregate never fully flattens; it plateaus with synchronized ripple (the correlation floor). |
| `corr-sweep` | N=2000, spike 0.44, skew 0 | **corr: 0 → 50%** (linear), 80f/10fps | fixed fleet, rising correlation. Aggregate (top) sprouts synchronized spikes; peak/mean (bottom) floor climbs ~1.0× → ~2.9×. Fixed aggregate axis. |
| `skew-sweep` | N=2000, spike **0.7**, corr 0, **seed 30** | **size-skew: 0 → 100%** (eased, t^0.6), 80f/10fps | fixed fleet, rising size-skew. A few "elephant" workloads emerge → aggregate gets bursty, peak/mean lifts off the floor toward the "indivisible" line (~2.8× at N=2000). Fixed axis + live `--size-skew` badge. |

### Notes on parameter choices

- **`skew-sweep` uses spikiness 0.7 (not 0.44)** on purpose: at 0.44 the *typical*
  size-skew effect at N=2000 is mild (~1.3×) and the aggregate barely moves; 0.7
  makes size-skew visibly **and** honestly drive the aggregate (~2.8×).
- **`skew-sweep` uses seed 30** because the aggregate panel draws *one sampled
  day* while the peak/mean marker shows the *typical (median)* fleet. Seed 30 is
  one where the sampled day's peak/mean ≈ the typical value, so the two panels
  agree. (Most seeds either look flat or contain a freak whale that contradicts
  the marker.) To find another, sweep `P.seed` and compare `peakMean(VIEW.D)` to
  `VIEW.pm` at the target skew.
- **Eased pacing** (`scale:'pow', exp:0.6`) makes the loop move fast through low
  skew and linger at the high end where the interesting behavior is.

## Extending

Add an entry to `RECIPES` in `record.js`:

```js
'my-sweep': {
  base: { rho: 0, spikiness: 0.44, sizeskew: 0, seed: 7, N: 2000 },
  sweep: { param: 'spikiness', from: 0, to: 1, frames: 80, scale: 'linear' },
  fps: 10, panels: ['aggregate', 'peakmean'], fixedAxis: true, badge: 'spikiness',
},
```

- `param`: `'N'` (derive-only) | `'rho'` | `'sizeskew'` | `'spikiness'`
- `scale`: `'linear'` | `'log'` | `'pow'` (with `exp`; `exp<1` = ease-out)
- `panels`: `['aggregate']`, `['peakmean']`, or both (both = stacked, aggregate on top)
- `fixedAxis`: pin the aggregate y-axis (2-pass auto-measured ceiling)
- `badge`: `null` | `'rho'` | `'sizeskew'` | `'spikiness'` | `'N'`

## Relevant model code (in ../index.html `<script>`)

- `simulate()` — builds the workload sample (shapes + sizes), the correlation
  floor, and the measured peak/mean-vs-N curve (`SIM.meas`).
- `derive()` — builds the displayed aggregate `D(t)` and the current-N marker
  for the chosen `P.N` (no re-sim).
- `drawTimeline()` / `drawAmort()` — the two charts the recorder captures.
- **Size-skew measurement fix:** under size-skew the peak/mean curve is computed
  as the **median over many fresh fleets** (not a single cumulative pass), then
  monotone-clamped — otherwise infinite-variance sizes produce a non-monotone,
  whale-dependent sawtooth. The current-N marker reads the smoothed curve via
  `simPM()`. See the `if(!sized){...}else{...}` block in `simulate()`.
