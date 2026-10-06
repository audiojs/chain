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
// dehum     mains hum at 60.00 Hz, 6 lines, -36.0 dB(A) re the program (audible: denoise-detect's dehum verdict)
// denoise   noise bed 17.2 dB under the program (< 25 dB trigger)
// declick   impulsive clicks — 3.3 a second (> 1 trigger)
// deesser   sibilance -0.3 dB rel. 1-4 kHz band (> -8 dB trigger)
// eq        spectral deviation from speech target curve, max 12.0 dB (>=1 dB trigger)
// gain      loudness normalization: measured -18.3 LUFS -> target -16 LUFS
// limiter   peak ceiling -1.0 dB, always applied
```

## API

| export | signature | role |
|---|---|---|
| `analyze` | `analyze(channels, { fs=44100 })` | Read-only measurement pass. Returns a plain object: `fs, duration, channels, lufs, truePeakDb, lra, snr, ltas, sibilanceDb, hum, clipping, clicks, voicedRatio`, plus `width` when `channels.length >= 2`. `snr`: program over noise bed, dB (`Infinity`: no bed); `hum`: `{ freq, harmonics, level }` (dB(A) re the program) or `null`; `clicks`: impulses a second; `voicedRatio`: share of voiced frames (`@audio/vad`). |
| `plan` | `plan(analysis, opts)` | Analysis → recipe: `{ fs, type, intensity, targetLufs, stages }`. Each stage is `{ atom, name, params, why }`. `JSON.stringify`-safe (no typed arrays). |
| `apply` | `apply(channels, recipe, { fs=44100 })` | Executes `recipe.stages` in order over copies (input untouched), then one refinement pass (see below). Returns `Float32Array[]`. |
| `chain` (default) | `chain(channels, opts)` | One-shot `analyze → plan → apply` → `{ channels, recipe, analysis }`. |
| `code` | `code(recipe)` | Recipe → copy-paste runnable ESM: imports of every stage's atom + the exact params, executed in order, then `apply()`'s refinement pass. Embeds derived data (the EQ correction curve), so the script renders what `apply()` renders, bit for bit, without re-analyzing anything. |

`plan()` options:

| opt | default | meaning |
|---|---|---|
| `type` | `'speech'` | `'speech' \| 'music' \| 'voice-music'` |
| `intensity` | `1` | `0..2` — scales how hard the adaptive stages work: denoise's a priori SNR floor (−15 dB × intensity, −2..−30), the deesser's deepest cut (−6 dB × intensity), the EQ correction, the multiband ratio. Does not change *whether* a stage fires (that's measurement-only, see below); dehum and declick have no strength |
| `targetLufs` | per-type | override the loudness target (speech/voice-music `-16`, music `-14` — EBU-informed conventions) |
| `reference` | — | `{ ltas, lufs, truePeakDb, width }`, typically `analyze()` of a reference track — see **Reference mode** |
| `ceiling` | `-1` | peak ceiling override, dB |

## Per-stage inclusion rules

Execution order (the `gain` stage runs before `limiter` even though it's numbered later
in the catalog below — loudness is normalized, *then* the peaks that raised are
brickwalled). `speechLike` = type ≠ `'music'`; `musicLike` = type ≠ `'speech'` —
`'voice-music'` is hybrid and lands on whichever side matters for that *specific*
stage's own concern (vocal content → speech-side; full-mix bass/dynamics → music-side).

| stage | atom | inclusion trigger | measurement cited |
|---|---|---|---|
| `hpf` | `@audio/filter-biquad` (highpass) | always | — DC/rumble guard; 40 Hz for speech, 25 Hz for `musicLike` (preserves bass under a bed mix) |
| `dehum` | `@audio/denoise-dehum` | `analysis.hum` truthy | **`@audio/denoise-detect`'s hum verdict**: dehum's own measurement finds a 50 or 60 Hz series, A-weighted within 50 dB of the program. `{ freq }`: dehum measures the exact frequency within ±0.4 % and subtracts every harmonic up to 1 kHz |
| `denoise` | `@audio/denoise-omlsa` | `snr < BED_SNR` (25 dB) | **`@audio/denoise-detect`'s noise bed**: a floor shown in the program's pauses or held at its bands' floor, its level re the program. OM-LSA, the bed tracked by IMCRA, so one that changes over the take is followed and held notes are not learned; `{ gMin }`, the floor the noise is taken to, dB |
| `declick` | `@audio/denoise-declick` | `clicks > CLICK_RATE` (1 a second) | **`@audio/denoise-detect`'s click rate** (isolated impulses standing 32σ out of the AR error), with the threshold it picks its own declick branch at. The kernel's defaults |
| `deesser` | `@audio/dynamics-deesser` | `speechLike && sibilanceDb > -8` | `sibilanceDb` — 5-9 kHz vs. 1-4 kHz LTAS band ratio, dB. `{ mode: 'band', range }`: the kernel judges each 's' (its band over the voice body, against its own threshold); `range` −6 dB × intensity |
| `eq` | `@audio/eq-fir` | `max\|correction\| >= 1 dB` (post-intensity) | `deviation(ltas, targetCurve)` from `@audio/spectral-target`, octave-smoothed (broader than the kernel's own 1/3-oct default — a broad-strokes mastering correction, not a surgical one) and clamped ±12 dB |
| `multiband` | `@audio/dynamics-multiband` | `musicLike \|\| (speechLike && lra > 12)` | `analysis.lra` for the speech branch; unconditional (content-type preset) for `musicLike`. 2-band (`speechLike`) or 3-band (`musicLike`) split; downward-only (`upRatio: 1`), ratio capped at 2 — "light glue" |
| `width` | `@audio/spatial-midside` | reference mode, both ≥2ch | `analysis.width` vs `reference.width` (side/mid RMS ratio) — reference mode only, see below |
| `gain` | *(inline)* | always | `targetLufs - measured lufs`, clamped ±20 dB — not a published atom, a two-line scalar multiply doesn't warrant one |
| `limiter` | `@audio/dynamics-limiter` | always | — peak ceiling, default `-1` dB (tightened to `min(ceiling, reference.truePeakDb)` in reference mode). The limiter holds sample peaks: an inter-sample peak can pass it by a fraction of a dB |

Corrective stages (`dehum`/`denoise`/`declick`) fire on the **input's own** analysis in
either mode — reference mode changes the tone/loudness/width target, not whether the
input's own defects get fixed.

`apply()`'s refinement pass: after every stage runs (including `gain` and `limiter`),
loudness is re-measured once; if it's off by more than the limiter/gain's own
tolerance, a ±2 dB trim is applied and the limiter re-run (a trim can otherwise punch a
new peak through the ceiling `limiter` already enforced). One pass, not a
loop — documented here because it's the one place `apply()` re-measures rather than
just executing the recipe literally.

## Measured

`node scripts/plan.js [tune|test] [chain.js]` plans every take of labelled material and counts the
repair stages each recipe holds (sources and mixtures in the script). 0.1.1 → 0.2.0 on the test
set, run once: VoiceBank+DEMAND's test set (Valentini-Botinhao 2017), ten Spoken Wikipedia
narrations, Slakh2100 mixes and VocalSet singers, clean and with white or pink noise 10 and 20 dB
under, mains hum 20 dB under, clicks at 5× the level around. The triggers are
`@audio/denoise-detect`'s, its thresholds chosen on tuning material disjoint from this set.

| material | n | dehum | denoise | declick | nothing repaired |
|---|---:|---:|---:|---:|---:|
| clean speech (VoiceBank) | 138 | 3 → 0% | 100 → 0% | 38 → 4% | 0 → 96% |
| narrations | 20 | 25 → 0% | 70 → 10% | 0 → 0% | 20 → 90% |
| music | 30 | 10 → 3% | 30 → 0% | 0 → 0% | 63 → 97% |
| VoiceBank+DEMAND noisy | 138 | 19 → 0% | 100 → 65% | 7 → 0% | 0 → 35% |
| speech + white, pink noise | 184 | 2 → 0% | 100 → 100% | 2 → 0% | 0 → 0% |
| music + white noise | 30 | 10 → 7% | 100 → 100% | 0 → 0% | 0 → 0% |
| speech + hum | 23 | 100 → 96% | 100 → 4% | 43 → 4% | 0 → 4% |
| music + hum | 10 | 80 → 80% | 30 → 0% | 0 → 0% | 20 → 20% |
| speech + clicks | 46 | 0 → 0% | 100 → 0% | 100 → 93% | 0 → 7% |
| music + clicks | 20 | 5 → 0% | 30 → 0% | 100 → 100% | 0 → 0% |

0.1.1 denoised every speech take: its trigger, a noise floor over −60 dB on an unnormalized FFT
scale, is an absolute level any real recording clears; and it put declick into 38 % of clean
VoiceBank takes. Its wiener ran on a noise profile frozen from the take's last second of minimum
statistics, wrong wherever the bed changes over the take; 0.3 runs omlsa, as denoise-detect 0.5 routes every bed, its IMCRA tracking it and leaving held notes out.
Missed now: noise that holds a line through the pauses (the test set's bus noise, office and
living-room noise at 12.5–17.5 dB), as denoise-detect's README states. Tuning set (VoiceBank's
training subset, ten other narrations, repair/ music and other singers): clean speech untouched
0 → 93 %, narrations 40 → 90 %, music 38 → 100 %, its noisy VoiceBank takes denoised 100 → 86 %.

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
this pipeline's own measured output where no external reference exists (e.g. the
fixture's noise is set for `@audio/denoise-detect` to read its bed 10 to 25 dB under the
program; it reads 17.2); see the comments above each fixture and assertion for the
reasoning and the specific numbers.
