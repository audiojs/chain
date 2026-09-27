# @audio/chain

Auto-Chain — the meta-atom that turns **(audio + content-type preset | reference track)**
into a configured, executed, and *explained* processing chain. Reverse-engineered from
Dolby.io Media Enhance-class products (classical DSP, no ML): an analysis pass measures
the input, an adaptive stage list is assembled entirely from shipped `@audio/*` atoms
with parameters set by those measurements, the chain runs, and you get back the result
*and* the recipe — every stage's exact parameters plus a one-line reason citing the
measurement that put it there. Dolby and iZotope hide the chain behind one "Enhance"
button; this shows it. The recipe is the product.

```js
import chain from '@audio/chain'

const { channels, recipe, analysis } = chain([left, right], { type: 'speech' })
for (const s of recipe.stages) console.log(`${s.name.padEnd(9)} ${s.why}`)
// hpf       DC/rumble guard, always applied — 40 Hz highpass (speech convention)
// dehum     mains hum at 60 Hz, 24.0 dB above local floor (>=10 dB trigger)
// denoise   noise floor -45.6 dB (> -60 dB trigger), severity 72%
// declick   impulsive clicks — 2.6 a second (> 1 trigger)
// deesser   sibilance 5.7 dB rel. 1-4 kHz band (> -8 dB trigger)
// eq        spectral deviation from speech target curve, max 12.0 dB (>=1 dB trigger)
// gain      loudness normalization: measured -17.3 LUFS -> target -16 LUFS
// limiter   true-peak ceiling -1.0 dBTP, always applied
```

## API

| export | signature | role |
|---|---|---|
| `analyze` | `analyze(channels, { fs=44100 })` | Read-only measurement pass. Returns a plain object: `fs, duration, channels, lufs, truePeakDb, lra, noiseFloorDb, noisePsd, ltas, sibilanceDb, hum, clipping, clicks, voicedRatio`, plus `width` when `channels.length >= 2`. |
| `plan` | `plan(analysis, opts)` | Analysis → recipe: `{ fs, type, intensity, targetLufs, stages }`. Each stage is `{ atom, name, params, why }`. `JSON.stringify`-safe (no typed arrays). |
| `apply` | `apply(channels, recipe, { fs=44100 })` | Executes `recipe.stages` in order over copies (input untouched), then one refinement pass (see below). Returns `Float32Array[]`. |
| `chain` (default) | `chain(channels, opts)` | One-shot `analyze → plan → apply` → `{ channels, recipe, analysis }`. |
| `code` | `code(recipe)` | Recipe → copy-paste runnable ESM: imports of every stage's atom + the exact params, executed in order (embeds derived data — the noise profile, the EQ correction curve — so the script reproduces the render without re-analyzing anything). |

`plan()` options:

| opt | default | meaning |
|---|---|---|
| `type` | `'speech'` | `'speech' \| 'music' \| 'voice-music'` |
| `intensity` | `1` | `0..2` — scales how hard the adaptive stages (denoise/deesser/eq/multiband) work; does not change *whether* a stage fires (that's measurement-only, see below) |
| `targetLufs` | per-type | override the loudness target (speech/voice-music `-16`, music `-14` — EBU-informed conventions) |
| `reference` | — | `{ ltas, lufs, truePeakDb, width }`, typically `analyze()` of a reference track — see **Reference mode** |
| `ceiling` | `-1` | true-peak ceiling override, dBTP |

## Per-stage inclusion rules

Execution order (the `gain` stage runs before `limiter` even though it's numbered later
in the catalog below — loudness is normalized, *then* the peaks that raised are
brickwalled). `speechLike` = type ≠ `'music'`; `musicLike` = type ≠ `'speech'` —
`'voice-music'` is hybrid and lands on whichever side matters for that *specific*
stage's own concern (vocal content → speech-side; full-mix bass/dynamics → music-side).

| stage | atom | inclusion trigger | measurement cited |
|---|---|---|---|
| `hpf` | `@audio/filter-biquad` (highpass) | always | — DC/rumble guard; 40 Hz for speech, 25 Hz for `musicLike` (preserves bass under a bed mix) |
| `dehum` | `@audio/denoise-dehum` | `analysis.hum` truthy | inline Goertzel, fundamental + 2 harmonics at 50 Hz and 60 Hz vs. a ±15 Hz off-tone floor; reports the stronger candidate once it clears **≥10 dB** above that floor |
| `denoise` | `@audio/denoise-wiener` | `noiseFloorDb > -60` | `noiseFloorDb` (median noise-PSD bin power, dB) — severity maps `-60 → -40` dB to light → strong, scaled further by `intensity` |
| `declick` | `@audio/denoise-declick` | `clicks > CLICK_RATE` (1 a second) | `analysis.clicks` — **reused from `@audio/denoise-detect`'s own classifier** (impulses per second that stand out of the AR residual and have no like one pitch period away), with the threshold it uses to pick its own declick branch |
| `deesser` | `@audio/dynamics-deesser` | `speechLike && sibilanceDb > -8` | `sibilanceDb` — 5-9 kHz vs. 1-4 kHz LTAS band ratio, dB |
| `eq` | `@audio/eq-fir` | `max\|correction\| >= 1 dB` (post-intensity) | `deviation(ltas, targetCurve)` from `@audio/spectral-target`, octave-smoothed (broader than the kernel's own 1/3-oct default — a broad-strokes mastering correction, not a surgical one) and clamped ±12 dB |
| `multiband` | `@audio/dynamics-multiband` | `musicLike \|\| (speechLike && lra > 12)` | `analysis.lra` for the speech branch; unconditional (content-type preset) for `musicLike`. 2-band (`speechLike`) or 3-band (`musicLike`) split; downward-only (`upRatio: 1`), ratio capped at 2 — "light glue" |
| `width` | `@audio/spatial-midside` | reference mode, both ≥2ch | `analysis.width` vs `reference.width` (side/mid RMS ratio) — reference mode only, see below |
| `gain` | *(inline)* | always | `targetLufs - measured lufs`, clamped ±20 dB — not a published atom, a two-line scalar multiply doesn't warrant one |
| `limiter` | `@audio/dynamics-limiter` | always | — true-peak ceiling, default `-1` dBTP (tightened to `min(ceiling, reference.truePeakDb)` in reference mode) |

Corrective stages (`dehum`/`denoise`/`declick`) fire on the **input's own** analysis in
either mode — reference mode changes the tone/loudness/width target, not whether the
input's own defects get fixed.

`apply()`'s refinement pass: after every stage runs (including `gain` and `limiter`),
loudness is re-measured once; if it's off by more than the limiter/gain's own
tolerance, a ±2 dB trim is applied and the limiter re-run (a trim can otherwise punch a
new true-peak overshoot through the ceiling `limiter` already enforced). One pass, not a
loop — documented here because it's the one place `apply()` re-measures rather than
just executing the recipe literally.

## Reference mode

`plan(analysis, { reference })` — Matchering-style mastering. `reference` is normally
just `analyze()` run on a reference track (its `ltas`, `lufs`, `truePeakDb`, and — for
stereo input — `width` are all it needs):

- **EQ target** becomes the reference's own LTAS (linear → dB) instead of a
  content-type preset curve — `deviation(analysis.ltas, ltasToDb(reference.ltas))`.
- **`targetLufs`** defaults to `reference.lufs` (explicit `opts.targetLufs` still wins).
- **Limiter ceiling** tightens to `min(ceiling, reference.truePeakDb)`.
- **`width` stage** is added when both input and reference are stereo: mid/side matrix
  via `@audio/spatial-midside`, side gain = `reference.width / analysis.width` (clamped
  `0..4`).

## Manifest (`audio.js`)

Two host-facing surfaces per [`@audio/compile` CONTRACT.md](https://github.com/audiojs/compile/blob/main/CONTRACT.md):

- **`auto`** — processor atom, `streaming: false` (whole-render — the entire signal in
  one `process` call), `channels: 'any'`. Runs `analyze → plan → apply` inside that one
  call: the open "God Particle," adaptive by measurement rather than a fixed preset.
  Params: `type` (enum, default `'speech'`), `intensity` (`0..2`, default `1`),
  `targetLufs` (`-30..-6` LUFS, default `0` — **`0` is a sentinel for "no override, use
  the per-type default"**, since the param system has no null and 0 LUFS is never a
  sensible target), `ceiling` (`-6..0` dB, default `-1`).
- **`chain`** — stat atom, `{ stat: 'chain', compute(channels, opts) }`. `analyze` +
  `plan` only, **no processing** — the recipe for a report/preview UI (Mix Analyser's
  feed, a "show me the chain before you render" panel) without paying for a render.

`audio.d.ts` is **hand-written, not tool-generated**: `@audio/compile/tools/dts.js` only
walks monorepo `<family>/packages/*` layouts (`readdirSync(FAM, fam, 'packages')`) — it
has no root-package mode, and this repo is a root package with no `packages/` dir. Content matches the tool's own generated format otherwise.

## Scope

Classical DSP only. Every processing stage is a deterministic, published `@audio/*`
atom — BS.1770 loudness, minimum-statistics noise PSD (Martin 2001), Welch LTAS,
biquad/FIR filters, feedforward compressors and a lookahead limiter. No ML, no black
box: two runs on the same input are bit-identical, and `code()` turns any recipe into a
plain script you can read, edit, and re-run without this package at all. That's the
whole point — Dolby.io Media Enhance and iZotope's mastering assistants apply a chain
exactly like this one and never show it. `@audio/chain` always does.

## Tests

```sh
npm test
```

All fixtures are synthetic and seeded (no bundled audio assets, no `Math.random`) —
deterministic in, deterministic out. Thresholds in `test.js` were calibrated against
this pipeline's own measured output where no external reference exists (e.g.
`noiseFloorDb` is a median unnormalized-FFT PSD-bin power in dB, not RMS dBFS — the two
differ by a fixed, window-dependent offset); see the comments above each fixture and
assertion for the reasoning and the specific numbers.
