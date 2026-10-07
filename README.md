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
// a voice clipped, in a room, under white noise 16 dB down (bench/rx/assistant.mjs in audio, a tuning take):
// declip    clipped: 1075 runs at the rails, 0.0 dBFS, 2.95 % of samples
// hpf       DC/rumble guard, always applied — 40 Hz highpass (speech convention)
// denoise   noise bed 15.5 dB under the program (< 25 dB trigger)
// dereverb  late reverberation: a diffuse tail, -8.8 dB of the take (dereverb's dry, diffuse and pauses checks)
// eq        spectral deviation from speech target curve, max 7.1 dB (>=1 dB trigger)
// gain      loudness normalization: measured -8.5 LUFS -> target -16 LUFS
// limiter   peak ceiling -1.0 dB, always applied
```

## API

| export | signature | role |
|---|---|---|
| `analyze` | `analyze(channels, { fs=44100, type })` | Read-only measurement pass. Returns a plain object: `fs, duration, channels, lufs, truePeakDb, lra, snr, ltas, sibilanceDb, hum, clipping, clicks, voicedRatio, reverb, pops`, plus `width` when `channels.length >= 2`. `snr`: program over noise bed, dB (`Infinity`: no bed); `hum`: `{ freq, harmonics, level, taken }` or `null` (`taken`: what dehum's own detection took, dB re the take; `freq`, `harmonics`, `level`: denoise-detect's measured series, its A-weighted level re the program, when it found one); `clipping`: `{ count, ratio, level, kind }`, declip's evidence (`kind` `'rail'`, `'band'` or `null`; `level` the lowest rail, dBFS); `clicks`: impulses a second; `voicedRatio`: share of voiced frames (`@audio/vad`); `reverb`, `pops`: `{ db, spans }` that dereverb and deplosive take from the take, or `null` (read for `type` `'speech'` only, the default). |
| `plan` | `plan(analysis, opts)` | Analysis → recipe: `{ fs, type, intensity, targetLufs, stages }`. Each stage is `{ atom, name, params, why }`. `JSON.stringify`-safe (no typed arrays). |
| `apply` | `apply(channels, recipe, { fs=44100 })` | Executes `recipe.stages` in order over copies (input untouched), then one refinement pass (see below). Returns `Float32Array[]`. |
| `chain` (default) | `chain(channels, opts)` | One-shot `analyze → plan → apply` → `{ channels, recipe, analysis }`. |
| `code` | `code(recipe)` | Recipe → copy-paste runnable ESM: imports of every stage's atom + the exact params, executed in order, then `apply()`'s refinement pass. Embeds derived data (the EQ correction curve), so the script renders what `apply()` renders, bit for bit, without re-analyzing anything. |

`plan()` options:

| opt | default | meaning |
|---|---|---|
| `type` | `'speech'` | `'speech' \| 'music' \| 'voice-music'` |
| `intensity` | `1` | `0..2`: scales how hard the adaptive stages work: denoise's a priori SNR floor (−15 dB × intensity, −2..−30), dereverb's late estimate (`strength` × intensity), the deesser's deepest cut (−8 dB × intensity), the EQ correction, the multiband ratio. Does not change *whether* a stage fires (that's measurement-only, see below); declip, declick, deplosive and dehum have no strength |
| `targetLufs` | per-type | override the loudness target (speech/voice-music `-16`, music `-14` — EBU-informed conventions) |
| `reference` | — | `{ ltas, lufs, truePeakDb, width }`, typically `analyze()` of a reference track — see **Reference mode** |
| `ceiling` | `-1` | peak ceiling override, dB |

## Per-stage inclusion rules

Execution order: the repairs first, in the order the damage is undone, the last done first (iZotope's own,
RX 12 Repair Assistant's: de-clip, de-click, de-hum, de-noise, de-reverb, de-ess), then the tone and level stages
(`gain` runs before `limiter`: loudness is normalized, *then* the peaks that raised are brickwalled). Each repair stands
on its own evidence; a clean take gets none. `speechLike` = type ≠ `'music'`; `musicLike` = type ≠ `'speech'` –
`'voice-music'` is hybrid and lands on whichever side matters for that *specific* stage's own concern (vocal content →
speech-side; full-mix bass/dynamics → music-side); dereverb and deplosive are `'speech'`'s alone (a held note's sustain
reads as a room to one, a kick drum as a pop to the other).

| stage | atom | inclusion trigger | measurement cited |
|---|---|---|---|
| `declip` | `@audio/denoise-declip` | `clipping.kind` | **declip's own evidence** (`rails`, `bands`): the samples a hard clip piled onto one level, in runs, or a rail lossy coding spread. First: every other stage moves the samples off the rails it rebuilds from. The kernel's defaults |
| `declick` | `@audio/denoise-declick` | `clicks > CLICK_RATE` (1 a second) | **`@audio/denoise-detect`'s click rate** (isolated impulses standing 32σ out of the AR error), with the threshold it picks its own declick branch at. Before the highpass, which rings on a click and spreads it. The kernel's defaults |
| `deplosive` | `@audio/denoise-deplosive` | `type === 'speech' && pops.db > -22` | **deplosive's own detection**, run in `analyze()` (on the take past declick, as the plan hands it on, here and for dehum and dereverb: a click reads to dereverb as a fall no room allows): a thump under 80 Hz rising out of nothing over the voice's band, without a period; what it takes, over −22 dB of the take (a voice's own low end at a word's onset takes less). The kernel's defaults |
| `hpf` | `@audio/filter-biquad` (highpass) | always | DC/rumble guard; 40 Hz for speech, 20 Hz for `musicLike`, the bottom of hearing (0.3's 25 Hz took the sub-bass out of bass-heavy mixes: PEAQ ODG under −0.5 for 4 of 32 tuning mixes) |
| `dehum` | `@audio/denoise-dehum` | `hum` | **dehum's own detection**, run in `analyze()`: its measurement over the take, else lines tracked along the 50 and 60 Hz series (hum under music); what it took. The kernel finds the series again, tracks its exact frequency, takes every harmonic to 1 kHz and every line over it to 8 kHz |
| `denoise` | `@audio/denoise-omlsa` | `speechLike && snr < BED_SNR` (25 dB) | **`@audio/denoise-detect`'s noise bed**: a floor shown in the program's pauses or held at its bands' floor, its level re the program. OM-LSA, the bed tracked by IMCRA, so one that changes over the take is followed; `{ gMin }`, the floor the noise is taken to, dB. Not on music: tracking a dense mix it takes held parts of it for the bed (see Measured) |
| `dereverb` | `@audio/denoise-dereverb` | `type === 'speech' && reverb.db > -20` | **dereverb's own checks**, run in `analyze()`: a diffuse tail falling slower than the voice (dry, diffuse, pauses); what it takes, over −20 dB of the take (a reading's own mild room at home takes less). After the denoiser: a bed reads as a tail that never falls. `{ strength }`, the late estimate's scale × intensity |
| `deesser` | `@audio/dynamics-deesser` | `speechLike && sibilanceDb > -6` | `sibilanceDb`: 5-9 kHz vs. 1-4 kHz LTAS band ratio, dB. `{ range }`, its default mode (`split`): the kernel judges each 's' (its band over the voice body, against its own threshold) and cuts the band over 3.5 kHz; `range` −8 dB × intensity |
| `eq` | `@audio/eq-fir` | `max\|correction\| >= 1 dB` (post-intensity) | the target curve (`@audio/spectral-target`) less the LTAS, each levelled by its mean over the band the target is known in, per octave (speech 100 Hz–10 kHz, music 100 Hz–4 kHz, a reference 20 Hz–0.45·fs), octave-smoothed, clamped ±12 dB, faded to 0 over the half octave outside: a broad-strokes mastering correction, not a surgical one |
| `multiband` | `@audio/dynamics-multiband` | `musicLike \|\| (speechLike && lra > 12)` | `analysis.lra` for the speech branch; unconditional (content-type preset) for `musicLike`. 2-band (`speechLike`) or 3-band (`musicLike`) split; downward-only (`upRatio: 1`), ratio capped at 2 — "light glue" |
| `width` | `@audio/spatial-midside` | reference mode, both ≥2ch | `analysis.width` vs `reference.width` (side/mid RMS ratio) — reference mode only, see below |
| `gain` | *(inline)* | always | `targetLufs - measured lufs`, clamped ±20 dB — not a published atom, a two-line scalar multiply doesn't warrant one |
| `limiter` | `@audio/dynamics-limiter` | always | — peak ceiling, default `-1` dB (tightened to `min(ceiling, reference.truePeakDb)` in reference mode). The limiter holds sample peaks: an inter-sample peak can pass it by a fraction of a dB |

Corrective stages fire on the **input's own** analysis in either mode: reference mode changes the tone/loudness/width
target, not whether the input's own defects get fixed.

`apply()`'s refinement pass: after every stage runs (including `gain` and `limiter`),
loudness is re-measured once; if it's off by more than the limiter/gain's own
tolerance, a ±2 dB trim is applied and the limiter re-run (a trim can otherwise punch a
new peak through the ceiling `limiter` already enforced). One pass, not a
loop — documented here because it's the one place `apply()` re-measures rather than
just executing the recipe literally.

## Measured

### Against iZotope RX 12 Repair Assistant

`node bench/rx/assistant.mjs test` in [audio](https://github.com/audiojs/audio) (2026-10): takes with several defects at
once, each made on a clean recording, so a repair is scored against the sound before the damage. Speech: VoiceBank's
test speakers, four utterances to a clip (52 clips), and 20 s of eight Spoken Wikipedia readings, twice (16); music: 25
MUSDB18 test previews and four longer pieces (29). Each clip makes three takes: clean; one defect, the kinds in turn; two
to four at random. The defects (seeded; every setting in the script's header): a steady bed (white, pink, brown, or under
150 Hz) 5–25 dB under the voice; a DEMAND recording 0–20 dB under; mains hum or buzz 20–35 dB under; clicks 1–4 a
second at 3–10× the sound around them; hard clipping to 3–15 dB SDR, the rails at full scale; a MIT IR Survey room (the
reference: the take's early sound in it); sibilants 4–12 dB brighter; plosive pops. Music gets the first five, gentler.
Every setting, RX's and this package's thresholds, was chosen on tuning takes from VoiceBank's training speakers, seven
other readings and MUSDB18's training songs.

RX: Repair Assistant (VST3, a new instance per render; Voice for speech, Music for music). Offline it renders what it is
set to: its analysis is its window's Learn, which no parameter reaches, and its state after a render holds nothing
learned but De-hum's harmonics, all zero; at its defaults it returns the input (Voice −136 dB, Music bit for bit). So it
cannot de-hum (De-hum needs learned harmonics), and it has no de-plosive. Tuned: each module's setting chosen on the
tuning takes with its defect, then on for every take each module whose dropping lowered the tuning mean: speech De-noise
80 %, De-reverb 25 %, De-clip at −0.1 dB without its limiter, De-ess at its defaults (De-click off: on, it lowered the
mean); music De-click and De-clip (De-noise lowered PEAQ's grade at every amount, −2.26 → −2.34 at 20 %, −2.90 at
100 %). Oracle: the tuned modules on for each take's own defects, what a perfect analysis would set. Ours: the recipe's
repairs alone (RX's scope), and `auto()` whole (with the EQ, glue, loudness and limiter).

Speech: PESQ (P.862.2), mean over the takes:

| takes | input | RX tuned | RX oracle | 0.3.0 repairs | **0.4.0 repairs** | 0.4.0 `auto()` |
|---|---:|---:|---:|---:|---:|---:|
| clean (68) | 4.64 | 3.81 | 4.64 | 4.54 | 4.46 | 4.33 |
| steady bed (9) | 1.81 | 2.94 | 2.95 | 2.39 | 2.39 | 2.35 |
| DEMAND (9) | 1.84 | 2.90 | 2.93 | 2.03 | 2.07 | 1.86 |
| hum, buzz (9) | 2.78 | 3.60 | 2.78 | 3.24 | 3.28 | 2.93 |
| clicks (9) | 2.25 | 2.98 | 2.97 | 3.54 | 3.86 | 3.83 |
| clipped (8) | 2.38 | 2.66 | 3.07 | 2.36 | 3.87 | 3.50 |
| room (8) | 2.06 | 2.09 | 2.41 | 2.06 | 2.60 | 2.31 |
| sibilance (8) | 4.44 | 3.74 | 4.58 | 4.52 | 4.52 | 4.40 |
| pops (8) | 2.52 | 2.50 | 2.52 | 3.01 | 3.77 | 3.79 |
| 2–4 defects (68) | 1.60 | 2.18 | 2.20 | 1.87 | 2.31 | 2.15 |
| all with defects (136) | 2.04 | 2.56 | 2.61 | 2.38 | 2.79 | 2.63 |
| … STOI | 0.90 | 0.91 | 0.92 | 0.91 | 0.93 | 0.92 |
| … SI-SDR, dB | 9.3 | 13.0 | 13.7 | 14.7 | 18.2 | 12.7 |
| … DNSMOS OVRL | 2.77 | 3.12 | 3.07 | 2.91 | 3.00 | 2.96 |

Music: PEAQ Basic ODG (ITU-R BS.1387), mean:

| takes | input | RX tuned | RX oracle | 0.3.0 repairs | **0.4.0 repairs** | 0.4.0 `auto()` |
|---|---:|---:|---:|---:|---:|---:|
| clean (29) | 0.21 | 0.21 | 0.21 | −0.28 | 0.09 | −2.06 |
| steady bed (6) | −0.65 | −0.65 | −0.74 | −0.83 | −0.63 | −2.19 |
| DEMAND (6) | −0.55 | −0.55 | −0.68 | −0.54 | −0.53 | −2.29 |
| hum, buzz (6) | −0.67 | −0.67 | −0.67 | −0.96 | −0.66 | −2.45 |
| clicks (6) | −2.38 | −2.35 | −2.38 | −1.03 | −0.28 | −2.34 |
| clipped (5) | −3.22 | −3.12 | −3.12 | −3.20 | −2.26 | −3.10 |
| 2–4 defects (29) | −3.07 | −3.05 | −3.06 | −2.88 | −2.56 | −3.12 |
| all with defects (58) | −2.25 | −2.23 | −2.26 | −2.06 | −1.69 | −2.79 |
| … SI-SDR, dB | 16.0 | 15.0 | 14.0 | 18.3 | 22.3 | −19.3 |
| … NMR, dB | −7.2 | −7.9 | −7.2 | −7.9 | −9.8 | 0.0 |

Paired over the takes with defects, the repairs against RX tuned: speech PESQ +0.23 ± 0.14 (95 %), STOI +0.01 ± 0.01,
SI-SDR +5.2 ± 1.1 dB, DNSMOS OVRL −0.12 ± 0.05; music ODG +0.54 ± 0.25, SI-SDR +7.3 ± 1.8 dB, NMR 1.9 ± 2.5 dB lower.
Against RX oracle: speech PESQ +0.18 ± 0.13, SI-SDR +4.5 ± 1.2, OVRL −0.07 ± 0.05; music ODG +0.57 ± 0.25. RX leads
where a bed is the defect: PESQ −0.55 ± 0.16 on the steady beds, −0.83 ± 0.35 on DEMAND's (OVRL −0.22, −0.36); its
De-noise at 80 % takes more of a bed than OM-LSA's −15 dB floor (on the tuning takes a −20 dB floor or the noise read
4 dB louder gained 0.01–0.03 PESQ a take for 0.01 of STOI). It takes hum as part of the bed too (PESQ
+0.32 ± 0.56 over ours, which keeps the voice: SI-SDR 10.9 ± 4.6 dB over RX's). Clean takes: RX tuned runs its De-noise
on every take (PESQ 4.64 → 3.81); the repairs change them by the 40 Hz guard and the deesser, deplosive and dereverb
where their evidence holds (SDR to the input, median 12.1 dB); the guard costs music ODG 0.12. `auto()`'s EQ toward the
type's target, its glue and its limiter cost a clean mix 2.15 of ODG and a clean voice 0.13 of PESQ against the repairs
alone: a choice of sound, not a repair.

What the plan turns on, per defect, recall · false alarms (takes with the defect · without it):

| defect | 0.3.0 | 0.4.0 |
|---|---:|---:|
| speech: steady bed → denoise (33 · 137) | 79 · 1 % | 79 · 1 % |
| speech: DEMAND → denoise (43 · 137) | 70 · 1 % | 70 · 1 % |
| speech: hum → dehum (34 · 170) | 26 · 0 % | 47 · 0 % |
| speech: clicks → declick (30 · 174) | 77 · 0 % | 77 · 0 % |
| speech: clipped → declip (35 · 169) | 0 · 0 % | 100 · 0 % |
| speech: room → dereverb (30 · 174) | 0 · 0 % | 97 · 6 % |
| speech: sibilance → deesser (31 · 173) | 48 · 18 % | 35 · 12 % |
| speech: pops → deplosive (35 · 169) | 0 · 0 % | 100 · 2 % |
| music: steady bed, DEMAND → denoise (51 · 48) | 25 · 13 % | 0 · 0 % |
| music: hum → dehum (25 · 62) | 0 · 0 % | 0 · 0 % |
| music: clicks → declick (22 · 65) | 45 · 0 % | 45 · 0 % |
| music: clipped → declip (20 · 67) | 0 · 0 % | 100 · 0 % |

The beds missed sit 25 dB or more under the voice above 63 Hz, most of a brown bed's power under it (the 40 Hz guard
takes it); dereverb's false alarms are one reading's own room (both its clean excerpts) and beds it read as a tail. Music beds go unrepaired by design (see `denoise`
above); hum under a mix stays too faint for dehum's detection. Through `audio`, 0.3's `auto()` normalized every take to
−6 LUFS (its `targetLufs` sentinel clamped into the declared range; see Manifest), not the type's −16.

### What the plan puts in

`node scripts/plan.js [tune|test] [chain.js]` plans every take of labelled material and counts the
repair stages each recipe holds (sources and mixtures in the script): VoiceBank+DEMAND's test set
(Valentini-Botinhao 2017), ten Spoken Wikipedia narrations, Slakh2100 mixes and VocalSet singers,
clean and with white or pink noise 10 and 20 dB under, mains hum 20 dB under, clicks at 5× the level
around. 0.3.0 → 0.4.0 on the test set, share of takes:

| material | n | declip | declick | deplosive | dehum | denoise | dereverb | deesser | nothing repaired |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| clean speech (VoiceBank) | 138 | · | 4 → 4% | · | · | · | · | 4 → 0% | 96 → 96% |
| narrations | 20 | · | · | 0 → 5% | 0 → 15% | 10 → 10% | 0 → 10% | 55 → 40% | 90 → 70% |
| music | 30 | · | · | · | 3 → 0% | 3 → 0% | · | · | 93 → 100% |
| VoiceBank+DEMAND noisy | 138 | 0 → 1% | · | 0 → 11% | · | 76 → 76% | 0 → 7% | 4 → 1% | 24 → 18% |
| speech + white, pink noise | 184 | · | · | · | · | 100 → 100% | 0 → 12% | 28 → 13% | 0 → 0% |
| music + white noise | 30 | · | · | · | 7 → 0% | 100 → 0% | · | · | 0 → 100% |
| speech + hum | 23 | · | 4 → 4% | · | 96 → 91% | 61 → 61% | · | 4 → 0% | 0 → 0% |
| music + hum | 10 | · | · | · | 80 → 90% | 10 → 0% | · | · | 20 → 10% |
| speech + clicks | 46 | · | 93 → 93% | · | · | · | · | 4 → 0% | 7 → 7% |
| music + clicks | 20 | · | 100 → 100% | · | · | 10 → 0% | · | · | 0 → 0% |

The narrations' dehum is their own mains hum (two of the ten carry a line 20 dB over its
surroundings, `bench/rx/dehum.mjs` in audio), their dereverb a reader's room; the noisy takes'
deplosive and dereverb are bursts of DEMAND's noise under 80 Hz and beds read as a tail. Music is
no longer denoised (see `denoise`).
Missed: beds that sit 25 dB and more under the voice above 63 Hz (the test set's bus and office
noise at 12.5–17.5 dB, most of whose power lies under 40 Hz, which the guard highpass takes), as
denoise-detect's README measures. 0.1.1 → 0.2.0: clean speech untouched 0 → 96 %, narrations 20 →
90 %, music 63 → 97 % (0.1.1 denoised every speech take on an absolute floor and put declick into
38 % of clean VoiceBank takes).

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
  `targetLufs` (`-30..0` LUFS, default `0`: **`0` is a sentinel for "no override, use
  the per-type default"**, since the param system has no null and 0 LUFS is never a
  sensible target; the range holds it, as a host clamps a default into it: 0.3's `-30..-6` made
  it −6 LUFS in `audio`), `ceiling` (`-6..0` dB, default `-1`).
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
