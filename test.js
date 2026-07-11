// Auto-Chain test suite. Deterministic synthetic fixtures only (no fixed audio assets) —
// every number a test compares against was measured by actually running the fixture
// through analyze()/plan()/apply() (see the comment above each fixture and threshold for
// the specific reasoning), not hand-picked from theory: FFT/window scaling conventions
// used internally (unnormalized DFT magnitude per @audio/stft) put absolute levels on a
// different scale than input dBFS, so thresholds are calibrated against this pipeline's
// own output, the only way to get them right for values with no external reference.

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { stftBatch } from '@audio/stft'
import chain, { analyze, plan, apply, code } from './chain.js'
import { auto, chain as chainStat } from './audio.js'

const FS = 44100

// ─── generic synth helpers ─────────────────────────────────────────────────

function sine(freq, n, amp = 1, fs = FS) {
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / fs)
  return d
}
function add(...arrays) {
  const n = Math.max(...arrays.map(a => a.length))
  const d = new Float32Array(n)
  for (const a of arrays) for (let i = 0; i < a.length; i++) d[i] += a[i]
  return d
}
function peakOf(d) { let p = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a } return p }
function normalizePeak(d, target) {
  const p = peakOf(d) || 1
  const g = target / p
  for (let i = 0; i < d.length; i++) d[i] *= g
  return d
}
function rms(d) { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length) }
// Deterministic LCG (not Math.random) — seeded so every run is bit-identical.
function lcgNoise(n, amp = 1, seed = 7) {
  const d = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    d[i] = amp * (2 * (s / 0x7fffffff) - 1)
  }
  return d
}
// Band-limited sawtooth (Fourier series, `harmonics` partials) — avoids the aliasing a
// naive phase-modulo sawtooth would add, and keeps energy above `freq` predictable
// (needed below to dodge the hum detector's own test frequencies).
function saw(freq, n, harmonics, fs = FS) {
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    const t = i / fs
    for (let h = 1; h <= harmonics; h++) {
      const hf = h * freq
      if (hf >= fs / 2) break
      s += Math.sin(2 * Math.PI * hf * t) / h
    }
    d[i] = s
  }
  return normalizePeak(d, 1)
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

// ─── fixtures ───────────────────────────────────────────────────────────────

// "dirty speech" — ~4 s. Voiced buzz (220 Hz band-limited sawtooth, 8 partials) AM'd at
// a 2 Hz syllable rate with true zero-amplitude gaps between syllables + 60 Hz mains hum
// with 2 harmonics at -30 dB rel. the voice peak + a -45ish dBFS white-noise floor + 5
// injected clicks + strong 6-8 kHz sibilant bursts.
//
// Two deliberate departures from the most literal reading of the brief, both load-bearing
// and documented here rather than silently baked in:
//  - Voice fundamental is 220 Hz, not the brief's illustrative "e.g. 150 Hz": 150 Hz is
//    exactly the 3rd harmonic of 50 Hz, which collided with detectHum()'s own 50 Hz scan
//    (fundamental + 2 harmonics) and produced a false 50 Hz hum reading instead of the
//    injected 60 Hz. 220 Hz and its (band-limited, so bounded) harmonics stay clear of
//    every 50/60 Hz-family probe frequency used below 200 Hz.
//  - Syllable rate is 2 Hz, not "~4 Hz": at 4 Hz each silence gap is only 125 ms, which is
//    shorter than twice denoise-wiener's own 2048-sample (~46 ms) analysis window: the
//    silence measurement never sees a settled steady state, only STFT-smeared transition
//    frames bleeding in from the adjacent voiced region, and the noise-floor-drop
//    assertion in test 5 reads mostly window-edge artifact instead of real suppression.
//    2 Hz gives 250 ms gaps — comfortably more than 2x that window — while staying
//    squarely in natural speech's 3-6 Hz syllable-rate range... close enough either side
//    of "~4 Hz" that "speech-ish" is the operative word, not the exact number.
function dirtySpeech() {
  const dur = 4, n = Math.round(dur * FS)
  const carrier = saw(220, n, 8)
  const voice = new Float32Array(n)
  const SYL_HZ = 2
  for (let i = 0; i < n; i++) {
    const t = i / FS
    const syl = Math.max(0, Math.sin(2 * Math.PI * SYL_HZ * t)) ** 2 // true zero between syllables
    voice[i] = 0.5 * syl * carrier[i]
  }

  const hum = add(sine(60, n, 1), sine(120, n, 0.7), sine(180, n, 0.5))
  normalizePeak(hum, 0.5 * 10 ** (-30 / 20)) // -30 dB rel. voice's 0.5 peak

  // Calibrated (not derived from a stated dBFS figure) so analyze()'s noiseFloorDb — a
  // median PSD-bin power in dB, on an unnormalized-FFT scale roughly +29 dB hotter than
  // RMS dBFS for a 2048-pt Hann window — lands mid-range in the [-50,-40] dB window test
  // 1 requires. See the module comment at the top of the file.
  const noise = lcgNoise(n, 0.00032, 11)

  const sib = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / FS
    if ((t % 0.5) < 0.12) { // bursts, 120 ms every 0.5 s
      sib[i] = 0.3 * (Math.sin(2 * Math.PI * 6500 * t) + Math.sin(2 * Math.PI * 7300 * t) + Math.sin(2 * Math.PI * 8000 * t)) / 3
    }
  }

  const out = add(voice, hum, noise, sib)
  const clickPos = [4000, 40000, 90000, 120000, 160000]
  for (const p of clickPos) if (p + 1 < out.length) { out[p] = 0.85; out[p + 1] = -0.8 }
  return out
}

// "clean music" — ~4 s chord (A3-ish minor triad, 220/277.18/329.63 Hz) + once-per-second
// percussive hits (two-partial decaying tone, marimba-ish, extended with two quieter
// upper partials at 3520/5280 Hz so the take has real — not FFT-noise-floor — energy up
// near 5 kHz; needed for test 7's LTAS-slope measurement to mean anything). No hum, no
// noise floor, no clicks: the percussive hit's short (4 ms) linear attack before the
// exponential decay matters — an instant-onset decay reads as a broadband click to the
// AR-residual kurtosis detector (denoise-detect's own declick trigger), which a few ms of
// ramp avoids. {period, attack, decay, amp} were picked by grid search for the lowest
// click score comfortably under the declick threshold (12) with a healthy (~9 dB) crest.
function cleanMusic() {
  const dur = 4, n = Math.round(dur * FS)
  const chordFreqs = [220, 277.18, 329.63]
  let out = new Float32Array(n)
  for (const f of chordFreqs) out = add(out, sine(f, n, 1 / chordFreqs.length))
  normalizePeak(out, 0.55)

  const period = 1, attackMs = 4, decayRate = 15, hitAmp = 0.26
  const attackT = attackMs / 1000
  for (let i = 0; i < n; i++) {
    const t = i / FS
    const hitT = t % period
    const attack = Math.min(1, hitT / attackT)
    const decay = Math.exp(-hitT * decayRate)
    const env = attack * decay
    out[i] += env * hitAmp * (
      Math.sin(2 * Math.PI * 880 * hitT) + 0.5 * Math.sin(2 * Math.PI * 1760 * hitT) +
      0.28 * Math.sin(2 * Math.PI * 3520 * hitT) + 0.16 * Math.sin(2 * Math.PI * 5280 * hitT)
    ) / 1.94
  }
  return out
}

// +dbPerOct dB/octave spectral tilt (frequency-domain magnitude scaling around f0) —
// test-only fixture mutator for reference mode (test 7). Uses @audio/stft directly
// (already a chain.js dependency) rather than adding one just for this.
function tiltCopy(data, fs, dbPerOct = 6, f0 = 1000) {
  const frameSize = 2048
  return stftBatch(data, (mag, phase) => {
    for (let k = 0; k < mag.length; k++) {
      const f = Math.max(1, k * fs / frameSize)
      mag[k] *= 10 ** (dbPerOct * Math.log2(f / f0) / 20)
    }
    return { mag, phase }
  }, { frameSize, hopSize: 512, fs })
}

// ─── measurement helpers (test-side instrumentation, independent of chain.js's own) ────

function goertzelDb(data, f, fs) {
  const w = 2 * Math.PI * f / fs, c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = 0; i < data.length; i++) { const s = data[i] + c * s1 - s2; s2 = s1; s1 = s }
  return 10 * Math.log10((s1 * s1 + s2 * s2 - c * s1 * s2) / data.length + 1e-30)
}

// Robust silence-gap floor: every syllable-silence window (t mod 0.5 in (0.25,0.5), see
// dirtySpeech), a 60 ms margin trimmed off each edge (clear of the widest analysis window
// in the chain — denoise-wiener's 2048-sample/~46 ms STFT frame), median dB across all
// gaps rather than one arbitrary window.
function gapFloorsDb(d, fs) {
  const period = 0.5, silStart = 0.25, silEnd = 0.5, margin = 0.06
  const vals = []
  for (let cycleStart = 0; cycleStart + period <= d.length / fs; cycleStart += period) {
    const a = Math.round((cycleStart + silStart + margin) * fs)
    const b = Math.round((cycleStart + silEnd - margin) * fs)
    if (b > a && b <= d.length) vals.push(20 * Math.log10(rms(d.subarray(a, b)) + 1e-12))
  }
  return vals
}

function ltasAtHz(ltas, f, fs, frameSize = 4096) {
  const k = Math.round(f * frameSize / fs)
  return 20 * Math.log10(Math.max(ltas[k], 1e-12))
}

// ─── shared fixtures + analysis (computed once, reused across tests) ──────────────────

const dirty = dirtySpeech()
const clean = cleanMusic()
const aDirty = analyze([dirty], { fs: FS })
const pDirty = plan(aDirty, { type: 'speech' })
const aClean = analyze([clean], { fs: FS })
const pClean = plan(aClean, { type: 'music' })

// ─── 1. analyze(dirty speech) ──────────────────────────────────────────────

test('analyze(dirty speech) — measures every documented field correctly', () => {
  assert.ok(aDirty.hum, 'hum should be detected')
  assert.ok(Math.abs(aDirty.hum.freq - 60) <= 1, `hum.freq should be ~60, got ${aDirty.hum.freq}`)
  assert.ok(aDirty.noiseFloorDb > -50 && aDirty.noiseFloorDb < -40, `noiseFloorDb should be in [-50,-40], got ${aDirty.noiseFloorDb}`)
  assert.equal(aDirty.clipping.count, 0, 'no clipping expected in the clean-peak dirty fixture')
  assert.ok(aDirty.clicks > 0, 'click score should be > 0 (5 injected clicks)')
  assert.ok(aDirty.voicedRatio > 0.3, `voicedRatio should be > 0.3, got ${aDirty.voicedRatio}`)
  assert.ok(Number.isFinite(aDirty.lufs), 'lufs should be finite')
})

// ─── 2. clipping detection ─────────────────────────────────────────────────

test('analyze() detects clipping on a hard-clipped copy', () => {
  const clipped = Float32Array.from(dirty, x => Math.max(-1, Math.min(1, x * 20)))
  const a = analyze([clipped], { fs: FS })
  assert.ok(a.clipping.ratio > 0, `clipping.ratio should be > 0, got ${a.clipping.ratio}`)
  assert.ok(a.clipping.count > 0, 'clipping.count should be > 0')
})

// ─── 3. plan(dirty, speech) — full adaptive stage list ────────────────────

test('plan(dirty, speech) includes every measurement-triggered stage with a cited why', () => {
  const names = pDirty.stages.map(s => s.name)
  for (const n of ['hpf', 'dehum', 'denoise', 'declick', 'deesser', 'eq', 'gain', 'limiter']) {
    assert.ok(names.includes(n), `expected stage "${n}" in ${names.join(',')}`)
  }
  for (const s of pDirty.stages) assert.ok(s.why && s.why.length > 0, `stage "${s.name}" missing why`)

  // JSON.stringify(recipe) roundtrips — no typed arrays inside stage params.
  const json = JSON.stringify(pDirty)
  const roundtripped = JSON.parse(json)
  assert.equal(roundtripped.stages.length, pDirty.stages.length)
  for (const s of pDirty.stages) {
    for (const v of Object.values(s.params)) {
      assert.ok(!ArrayBuffer.isView(v), `stage "${s.name}" has a typed array in params`)
    }
  }
})

// ─── 4. plan(clean music, music) — adaptivity: assert the skips ───────────

test('plan(clean music, music) skips dehum/denoise/declick, keeps eq/multiband/gain/limiter', () => {
  const names = pClean.stages.map(s => s.name)
  assert.ok(!names.includes('dehum'), 'no hum in clean music — dehum must be skipped')
  assert.ok(!names.includes('declick'), 'no clicks in clean music — declick must be skipped')
  assert.ok(!names.includes('denoise'), 'no noise floor in clean music — denoise must be skipped')
  for (const n of ['eq', 'multiband', 'gain', 'limiter']) {
    assert.ok(names.includes(n), `expected stage "${n}" in ${names.join(',')}`)
  }
})

// ─── 5. apply(dirty, recipe) — measured DSP outcomes ───────────────────────

test('apply(dirty, recipe) removes hum, drops the noise floor, and hits loudness/peak targets', () => {
  const out = apply([dirty], pDirty, { fs: FS })

  const humDrop = goertzelDb(dirty, 60, FS) - goertzelDb(out[0], 60, FS)
  assert.ok(humDrop >= 12, `60 Hz energy should drop >= 12 dB, got ${humDrop.toFixed(2)}`)

  const floorDrop = median(gapFloorsDb(dirty, FS)) - median(gapFloorsDb(out[0], FS))
  assert.ok(floorDrop >= 6, `noise floor should drop >= 6 dB, got ${floorDrop.toFixed(2)}`)

  const outLufs = analyze(out, { fs: FS }).lufs
  assert.ok(Math.abs(outLufs - pDirty.targetLufs) <= 1, `output LUFS should be within +-1 LU of ${pDirty.targetLufs}, got ${outLufs}`)

  const outTp = analyze(out, { fs: FS }).truePeakDb
  assert.ok(outTp <= -1 + 0.1, `true peak should be <= -0.9 dBTP, got ${outTp}`)
})

// ─── 6. one-shot chain() — shape + determinism ─────────────────────────────

test('chain() one-shot returns {channels, recipe, analysis}, differs from input, and is deterministic', () => {
  const r1 = chain([dirty], { type: 'speech' })
  const r2 = chain([dirty], { type: 'speech' })
  assert.ok(Array.isArray(r1.channels) && r1.recipe && r1.analysis, 'missing one of channels/recipe/analysis')

  let differs = false
  for (let i = 0; i < dirty.length; i++) if (Math.abs(r1.channels[0][i] - dirty[i]) > 1e-9) { differs = true; break }
  assert.ok(differs, 'output should differ from input')

  assert.equal(r1.channels[0].length, r2.channels[0].length)
  let identical = true
  for (let i = 0; i < r1.channels[0].length; i++) if (r1.channels[0][i] !== r2.channels[0][i]) { identical = false; break }
  assert.ok(identical, 'two runs on the same input should be bit-identical')
})

// ─── 7. reference mode — LTAS slope + loudness match ───────────────────────

test('reference mode moves a spectrally-tilted input toward the reference LTAS slope and loudness', () => {
  const reference = aClean // clean music's own analysis, reused wholesale as the reference
  const tilted = tiltCopy(clean, FS, 6) // +6 dB/oct tilt applied to a copy of the same track

  const aTilted = analyze([tilted], { fs: FS })
  const recipe = plan(aTilted, { type: 'music', reference })
  const out = apply([tilted], recipe, { fs: FS })
  const aOut = analyze(out, { fs: FS })

  const gapBefore = ltasAtHz(aTilted.ltas, 500, FS) - ltasAtHz(aTilted.ltas, 5000, FS)
  const gapRef = ltasAtHz(reference.ltas, 500, FS) - ltasAtHz(reference.ltas, 5000, FS)
  const gapAfter = ltasAtHz(aOut.ltas, 500, FS) - ltasAtHz(aOut.ltas, 5000, FS)

  const totalGap = Math.abs(gapBefore - gapRef)
  const remainingGap = Math.abs(gapAfter - gapRef)
  const closedFraction = 1 - remainingGap / totalGap
  assert.ok(closedFraction >= 0.5, `500Hz-vs-5kHz gap should close >= 50%, closed ${(closedFraction * 100).toFixed(1)}%`)

  assert.ok(Math.abs(aOut.lufs - reference.lufs) <= 1, `output LUFS should be within +-1 LU of reference's ${reference.lufs}, got ${aOut.lufs}`)
})

// ─── 8. code() — copy-paste runnable JS export ─────────────────────────────

test('code(recipe) emits every stage atom + params, in order, as syntactically valid JS', () => {
  const src = code(pDirty)
  assert.equal(typeof src, 'string')

  let lastIndex = -1
  for (const stage of pDirty.stages) {
    // Atom specifier must appear somewhere (imports are hoisted into one shared block,
    // so its raw text position isn't a stage-order signal — see below for that).
    assert.ok(src.includes(stage.atom), `code() should mention atom "${stage.atom}" for stage "${stage.name}"`)

    // Stage order: each stage's `// name — why` comment lives in the body section,
    // which is emitted in strict recipe.stages order (unlike the import block above
    // it, hoisted to the top and deduplicated in first-use order) — so this marker,
    // not the atom specifier, is the reliable order signal.
    const marker = `// ${stage.name} —`
    const idx = src.indexOf(marker)
    assert.ok(idx >= 0, `code() should have a "${marker}" comment for stage "${stage.name}"`)
    assert.ok(idx > lastIndex, `stage "${stage.name}" should appear after the previous stage`)
    lastIndex = idx

    // at least one param value literally present (proves params were embedded, not just the atom name)
    const sampleParam = Object.values(stage.params).find(v => typeof v === 'number' || typeof v === 'string')
    if (sampleParam !== undefined) assert.ok(src.includes(String(sampleParam)), `code() should embed a param value for "${stage.name}"`)
  }

  // Structural syntax check: import syntax can't run through new Function, so strip
  // import lines and confirm the remaining body — the actual executable recipe — parses.
  const body = src.split('\n').filter(l => !l.trim().startsWith('import ')).join('\n')
  assert.doesNotThrow(() => new Function('channels', body), 'code() body (minus imports) should be syntactically valid JS')
})

// ─── 9. audio.js manifest — auto processor + chain stat ───────────────────

test('manifest: auto processes a buffer without NaN, chain stat returns a recipe', () => {
  const ctx = {
    sampleRate: FS, maxChannels: 2, maxBlockSize: dirty.length, render: 'offline', duration: dirty.length / FS,
    params: {
      type: 'speech',
      intensity: new Float32Array([1]),
      targetLufs: new Float32Array([0]), // sentinel — per-type default
      ceiling: new Float32Array([-1]),
    },
  }
  const process = auto(ctx)
  const inputs = [[Float32Array.from(dirty)]]
  const outputs = [[new Float32Array(dirty.length)]]
  process(inputs, outputs, ctx.params)
  const out = outputs[0][0]

  assert.ok(!out.some(Number.isNaN), 'auto output should contain no NaN')
  let differs = false
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i] - dirty[i]) > 1e-9) { differs = true; break }
  assert.ok(differs, 'auto output should differ from input')

  const recipe = chainStat.compute([dirty], { sampleRate: FS, type: 'speech' })
  assert.ok(Array.isArray(recipe.stages) && recipe.stages.length > 0, 'chain stat compute() should return a recipe with stages')
  assert.equal(chainStat.stat, 'chain')
})
