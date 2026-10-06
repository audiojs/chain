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
import { BED_SNR, CLICK_RATE } from '@audio/denoise-detect'
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

// "speech" — ~4 s. Voiced buzz (230 Hz band-limited sawtooth, 8 partials) AM'd at a 2 Hz
// syllable rate with true zero-amplitude gaps between syllables + 6.5-8 kHz sibilant bursts
// (120 ms, raised-cosine: a gated burst's edges are clicks to denoise-detect, 2 a second).
// The defects, each optional — all on, the "dirty" take; all off, the clean one:
//  - hum: 60 Hz mains with 2 harmonics at -30 dB rel. the voice peak;
//  - noise: a white-noise bed 18 dB under the program, as denoise-detect reads it (BED_SNR 25);
//  - clicks: 13 doublets, one every 0.3 s (3 a second, CLICK_RATE 1).
//
// Two deliberate choices, both load-bearing:
//  - Voice fundamental is 230 Hz: its partials under 1 kHz (230, 460, 690, 920) stay off
//    the 50 and 60 Hz series dehum removes up to 1 kHz. A steady synthetic partial on a mains
//    harmonic is a line to dehum (150 Hz = 3 x 50; 220 Hz put its 3rd on 660 = 11 x 60),
//    and goes with the hum.
//  - Syllable rate is 2 Hz, not ~4 Hz: 250 ms gaps, several times denoise-omlsa's ~23 ms
//    frame, so the gap-floor measurement in test 5 reads settled frames, not the STFT-smeared
//    edges of the syllables around them.
function speech({ hum = true, noise = true, clicks = true } = {}) {
  const dur = 4, n = Math.round(dur * FS)
  const carrier = saw(230, n, 8)
  const out = new Float32Array(n)
  const SYL_HZ = 2
  for (let i = 0; i < n; i++) {
    const t = i / FS, s = t % 0.5
    const syl = Math.max(0, Math.sin(2 * Math.PI * SYL_HZ * t)) ** 2 // true zero between syllables
    out[i] = 0.5 * syl * carrier[i]
    if (s < 0.12) out[i] += 0.3 * Math.sin(Math.PI * s / 0.12) ** 2 *
      (Math.sin(2 * Math.PI * 6500 * t) + Math.sin(2 * Math.PI * 7300 * t) + Math.sin(2 * Math.PI * 8000 * t)) / 3
  }
  if (hum) {
    const h = normalizePeak(add(sine(60, n, 1), sine(120, n, 0.7), sine(180, n, 0.5)), 0.5 * 10 ** (-30 / 20))
    for (let i = 0; i < n; i++) out[i] += h[i]
  }
  if (noise) {
    const w = lcgNoise(n, 0.03, 11)
    for (let i = 0; i < n; i++) out[i] += w[i]
  }
  if (clicks) for (let t = 0.15; t < dur - 0.1; t += 0.3) {
    const p = Math.round(t * FS)
    out[p] = 0.85; out[p + 1] = -0.8
  }
  return out
}

// "clean music" — ~4 s chord (A3-ish minor triad, 220/277.18/329.63 Hz) + once-per-second
// percussive hits (two-partial decaying tone, marimba-ish, extended with two quieter
// upper partials at 3520/5280 Hz so the take has real — not FFT-noise-floor — energy up
// near 5 kHz; needed for test 7's LTAS-slope measurement to mean anything). No hum, no
// noise floor, no clicks: the percussive hit's short (4 ms) linear attack before the
// exponential decay matters — an instant-onset decay reads as a broadband click to the
// impulse detector (denoise-detect's own declick trigger), which a few ms of
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
// speech), a 60 ms margin trimmed off each edge (clear of denoise-omlsa's ~23 ms STFT
// frame), median dB across all gaps rather than one arbitrary window.
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

const dirty = speech()
const clean = cleanMusic()
const aDirty = analyze([dirty], { fs: FS })
const pDirty = plan(aDirty, { type: 'speech' })
const aClean = analyze([clean], { fs: FS })
const pClean = plan(aClean, { type: 'music' })

// ─── 1. analyze(dirty speech) ──────────────────────────────────────────────

test('analyze(dirty speech) — measures every documented field correctly', () => {
  assert.ok(aDirty.hum, 'hum should be detected')
  assert.ok(Math.abs(aDirty.hum.freq - 60) <= 0.3, `hum.freq should be ~60, got ${aDirty.hum.freq}`)
  assert.ok(aDirty.hum.harmonics >= 3 && aDirty.hum.level > -50, `hum lines and level, got ${JSON.stringify(aDirty.hum)}`)
  assert.ok(aDirty.snr > 10 && aDirty.snr < BED_SNR, `noise bed should read 10..${BED_SNR} dB under the program, got ${aDirty.snr}`)
  assert.equal(aDirty.clipping.count, 0, 'no clipping expected in the clean-peak dirty fixture')
  assert.ok(aDirty.clicks > CLICK_RATE, `click rate should clear ${CLICK_RATE}/s (3/s injected), got ${aDirty.clicks}`)
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

// ─── 4b. plan(speech) — each defect on its evidence alone ──────────────────

const REPAIR = ['dehum', 'denoise', 'declick']
const cleanTake = speech({ hum: false, noise: false, clicks: false })
const repairs = (x) => plan(analyze([x], { fs: FS }), { type: 'speech' }).stages.filter(s => REPAIR.includes(s.name))
// error of y re x, dB
const errDb = (y, x) => { let e = 0, p = 0; for (let i = 0; i < x.length; i++) { e += (y[i] - x[i]) ** 2; p += x[i] * x[i] } return 10 * Math.log10(e / p) }

test('plan(clean speech) repairs nothing: no hum, no bed, no clicks evidenced', () => {
  const a = analyze([cleanTake], { fs: FS })
  assert.equal(a.hum, null, 'no hum')
  assert.ok(a.snr >= BED_SNR, `no noise bed, got snr ${a.snr}`)
  assert.ok(a.clicks <= CLICK_RATE, `no clicks, got ${a.clicks}/s`)
  assert.deepEqual(repairs(cleanTake), [])
})

// chain 0.1.1 put in dehum { freq, harmonics: 4, Q: 30 }, declick { order: 60, windowSize, hopSize, threshold: 4,
// guard, maxBurst } (params the 0.3 / 0.2 kernels no longer have) and denoise on an absolute floor (> -60 dB),
// with a 1025-bin profile frozen from the take's last second.
test('each defect alone puts in its own stage, with the kernels\' current params, and that stage repairs it', () => {
  for (const [defect, name, check] of [
    ['hum', 'dehum', p => { assert.deepEqual(Object.keys(p), ['freq']); assert.ok(Math.abs(p.freq - 60) < 0.3, `freq ${p.freq}`) }],
    ['noise', 'denoise', p => assert.deepEqual(p, { gMin: -15 })],
    ['clicks', 'declick', p => assert.deepEqual(p, {})],
  ]) {
    const x = speech({ hum: false, noise: false, clicks: false, [defect]: true }), st = repairs(x)
    assert.deepEqual(st.map(s => s.name), [name], `${defect} alone`)
    check(st[0].params)
    // the stage alone, through apply(): error re the clean take, measured -23.1 -> -80.3 dB (hum),
    // -16.7 -> -23.3 (noise), -21.3 -> -66.4 (clicks)
    const y = apply([x], { fs: FS, targetLufs: -16, stages: st }, { fs: FS })[0]
    const before = errDb(x, cleanTake), after = errDb(y, cleanTake)
    assert.ok(after < before - { hum: 40, noise: 5, clicks: 30 }[defect], `${name}: error re clean ${before.toFixed(1)} -> ${after.toFixed(1)} dB`)
  }
})

test('intensity scales denoise\'s floor and the deesser\'s deepest cut, not whether they fire', () => {
  for (const [intensity, gMin, range] of [[0, -2, 0], [0.5, -7.5, -3], [1, -15, -6], [2, -30, -12]]) {
    const st = plan(aDirty, { type: 'speech', intensity }).stages, by = n => st.find(s => s.name === n).params
    assert.equal(by('denoise').gMin, gMin, `intensity ${intensity}: gMin`)
    assert.equal(by('deesser').mode, 'band')
    assert.equal(by('deesser').range, range, `intensity ${intensity}: range`)
    assert.equal(by('deesser').threshold, undefined, 'the kernel\'s own threshold (sibilance band over the voice body)')
  }
})

// ─── 5. apply(dirty, recipe) — measured DSP outcomes ───────────────────────

test('apply(dirty, recipe) removes hum, drops the noise floor, and hits loudness/peak targets', () => {
  const out = apply([dirty], pDirty, { fs: FS })

  // measured: 60 Hz down 53.5 dB, the gaps' floor down 15.0 dB
  const humDrop = goertzelDb(dirty, 60, FS) - goertzelDb(out[0], 60, FS)
  assert.ok(humDrop >= 40, `60 Hz energy should drop >= 40 dB, got ${humDrop.toFixed(2)}`)

  const floorDrop = median(gapFloorsDb(dirty, FS)) - median(gapFloorsDb(out[0], FS))
  assert.ok(floorDrop >= 10, `noise floor should drop >= 10 dB, got ${floorDrop.toFixed(2)}`)

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

// LTAS slope, dB per octave, least squares over the percussive hit's four partials
// (880-5280 Hz): one event, so no broadband gain (the limiter's, the trim's) changes their
// ratios. Single bins between partials (500 Hz, 5 kHz) read the window's leakage instead,
// which the limiter's ramp into each peak moved (dynamics-limiter 0.1.6: 48 % closed, 0.1.4: 56 %).
function hitSlope(ltas, fs) {
  const x = [880, 1760, 3520, 5280].map(Math.log2), y = [880, 1760, 3520, 5280].map(f => ltasAtHz(ltas, f, fs))
  const mx = x.reduce((a, b) => a + b) / 4, my = y.reduce((a, b) => a + b) / 4
  let sxy = 0, sxx = 0
  for (let i = 0; i < 4; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2 }
  return sxy / sxx
}

test('reference mode moves a spectrally-tilted input toward the reference LTAS slope and loudness', () => {
  const reference = aClean // clean music's own analysis, reused wholesale as the reference
  const tilted = tiltCopy(clean, FS, 6) // +6 dB/oct tilt applied to a copy of the same track

  const aTilted = analyze([tilted], { fs: FS })
  const recipe = plan(aTilted, { type: 'music', reference })
  const out = apply([tilted], recipe, { fs: FS })
  const aOut = analyze(out, { fs: FS })

  // measured: reference -6.0 dB/oct, tilted 0.0, out -2.8 (46 % closed; the EQ alone closes
  // 63 %, the multiband glue gives some of it back), with chain 0.1.1's dependencies alike
  const sRef = hitSlope(reference.ltas, FS), sBefore = hitSlope(aTilted.ltas, FS), sAfter = hitSlope(aOut.ltas, FS)
  const closedFraction = 1 - Math.abs(sAfter - sRef) / Math.abs(sBefore - sRef)
  assert.ok(closedFraction >= 0.4, `LTAS slope gap should close >= 40%, closed ${(closedFraction * 100).toFixed(1)}% (${sBefore.toFixed(1)} -> ${sAfter.toFixed(1)}, reference ${sRef.toFixed(1)} dB/oct)`)

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

// The script itself, run: its imports resolved from this package's dependencies, its body a
// function of `channels`. It renders what apply() renders, bit for bit (refinement pass included).
async function runCode(recipe, channels) {
  const lines = code(recipe).split('\n')
  const imports = lines.filter(l => l.startsWith('import ')).map(l => l.replace(/'(@audio\/[^']+)'/, (_, s) => `'${import.meta.resolve(s)}'`))
  const body = lines.filter(l => !l.startsWith('import ')).join('\n')
  const mod = await import('data:text/javascript,' + encodeURIComponent(`${imports.join('\n')}\nexport default channels => {\n${body}\nreturn channels\n}`))
  return mod.default(channels)
}

test('code(recipe) runs and renders exactly what apply() renders', async () => {
  for (const [x, recipe] of [[dirty, pDirty], [clean, pClean]]) {
    const got = await runCode(recipe, [Float32Array.from(x)]), want = apply([x], recipe, { fs: FS })
    let diff = got[0].length === want[0].length ? 0 : Infinity
    for (let i = 0; i < want[0].length; i++) diff = Math.max(diff, Math.abs(got[0][i] - want[0][i]))
    assert.equal(diff, 0, `${recipe.type} (${recipe.stages.map(s => s.name).join(',')}): largest difference ${diff}`)
  }
})

test('edge cases: empty, one sample, shorter than every window, silence — no throw, no NaN, length kept', () => {
  for (const x of [new Float32Array(0), Float32Array.of(0.5), sine(440, 100, 0.3), new Float32Array(FS)]) {
    const { channels, recipe } = chain([x], { type: 'speech' })
    assert.equal(channels[0].length, x.length)
    assert.ok(!channels[0].some(Number.isNaN), `NaN in a ${x.length}-sample render`)
    assert.ok(!recipe.stages.some(s => REPAIR.includes(s.name)), `nothing to repair in ${x.length} samples: ${recipe.stages.map(s => s.name)}`)
  }
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
