# heat-sandbox

An interactive sandbox for **statistical multiplexing**: when does a fleet of spiky
workloads "balance itself out"?

It comes down to two things — how **correlated** the workloads are, and how **many**
share the fleet. Independent spikes cancel as you add workloads; a shared daily cycle
stacks up no matter the scale. The **amortization floor** is the burstiness that even an
infinite fleet can't remove.

Inspired by the ["managing heat"](https://www.allthingsdistributed.com/2023/07/building-and-operating-a-pretty-big-storage-system.html)
section of Andy Warfield's S3 post.

## Run it

It's a single self-contained `index.html` — no build, no dependencies.

```sh
open index.html
```

## Hosting

Served as a static page (e.g. GitHub Pages); `.nojekyll` disables Jekyll processing.
