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
import targetCurve from '@audio/spectral-target'
const targetFor = (type, bins) => targetCurve(type, { fs: 44100, bins })
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

// "speech": ~4 s. Voiced buzz (245 Hz band-limited sawtooth, 8 partials) AM'd at a 2 Hz
// syllable rate with true zero-amplitude gaps between syllables + 6.5-8 kHz sibilant bursts
// (120 ms, raised-cosine: a gated burst's edges are clicks to denoise-detect, 2 a second).
// The defects, each optional — all on, the "dirty" take; all off, the clean one:
//  - hum: 60 Hz mains with 2 harmonics at -30 dB rel. the voice peak;
//  - noise: a white-noise bed 18 dB under the program, as denoise-detect reads it (BED_SNR 25);
//  - clicks: 13 doublets, one every 0.3 s (3 a second, CLICK_RATE 1).
//
// Two deliberate choices, both load-bearing:
//  - Voice fundamental is 245 Hz: its partials (245·k to 1960 Hz) stay 5 Hz or more off every
//    multiple of 50 and 60, the most any fundamental near it keeps. A steady synthetic partial on a
//    mains harmonic is a line to dehum, and goes with the hum: dehum 0.5 takes the lines to 8 kHz,
//    and 230 Hz put its 6th on 1380 = 23 x 60 (the hum fixture's error re clean -23.1 -> -24.2 dB).
//  - Syllable rate is 2 Hz, not ~4 Hz: 250 ms gaps, several times denoise-omlsa's ~23 ms
//    frame, so the gap-floor measurement in test 5 reads settled frames, not the STFT-smeared
//    edges of the syllables around them.
function speech({ hum = true, noise = true, clicks = true } = {}) {
  const dur = 4, n = Math.round(dur * FS)
  const carrier = saw(245, n, 8)
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
  for (const n of ['hpf', 'dehum', 'denoise', 'declick', 'deesser', 'eq', 'gain']) {
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

test('plan(clean music, music): no repair, no glue (LRA under 12 LU), no limiter (its peaks allow the gain)', () => {
  const names = pClean.stages.map(s => s.name)
  for (const n of ['dehum', 'declick', 'denoise', 'declip', 'multiband', 'limiter']) assert.ok(!names.includes(n), `${n} in ${names.join(',')}`)
  assert.ok(names.includes('gain'), names.join(','))
})

// chain 0.3 put a limiter on every take, multiband glue on every mix, and an EQ toward the type's target on any take
// 1 dB off it: a finished master came back EQ'd, compressed and limited (clean MUSDB18 mixes: PEAQ ODG 0.21 -> -2.06).
// A take with the target's shape, its dynamics finished, its peaks under the ceiling after the gain, gets the gain alone.
const finished = (type, { lufs = -20, truePeakDb = -4, lra = 5 } = {}) => {
  const bins = 2049, ltas = Float32Array.from(targetFor(type, bins), db => 10 ** (db / 20))
  return { fs: FS, duration: 10, channels: 1, lufs, truePeakDb, lra, snr: Infinity, ltas, sibilanceDb: -20, hum: null,
    clipping: { count: 0, ratio: 0, level: null, kind: null }, clicks: 0, voicedRatio: 0.5, reverb: null, pops: null }
}
test('mastering stages act on measured need: a finished take gets the gain alone, and limiting only where the target needs it', () => {
  for (const type of ['music', 'speech']) {
    // loud and controlled: turned down, nothing else; quiet with peaks to spare: raised, nothing else
    for (const [lufs, truePeakDb] of [[-10, -1], [-30, -20]]) {
      const st = plan(finished(type, { lufs, truePeakDb }), { type }).stages.map(s => s.name)
      assert.deepEqual(st, ['hpf', 'gain'], `${type} ${lufs} LUFS, ${truePeakDb} dBTP: ${st}`)
    }
  }
  // a mix 6 dB under -14 LUFS whose peaks allow 3: the limiter takes the rest, 6 dB at most × intensity
  const st = plan(finished('music'), { type: 'music' }).stages, g = st.find(s => s.name === 'gain')
  assert.deepEqual(st.map(s => s.name), ['hpf', 'gain', 'limiter'])
  assert.deepEqual(g.params, { target: -14, ceiling: -1, limit: 6 })
  assert.equal(st.find(s => s.name === 'limiter').params.truePeak, true)
  const off = plan(finished('music'), { type: 'music', intensity: 0 }).stages
  assert.deepEqual(off.map(s => s.name), ['hpf', 'gain'], 'intensity 0: no limiting, the gain stops at the ceiling')
  assert.match(off.find(s => s.name === 'gain').why, /\+3\.0 dB/)
  assert.equal(plan(finished('music'), { type: 'music', intensity: 2 }).stages.find(s => s.name === 'gain').params.limit, 12)
  // wider dynamics put the glue in, by how far over
  const wide = plan(finished('music', { lra: 18 }), { type: 'music' }).stages.find(s => s.name === 'multiband')
  assert.equal(wide?.params.ratio, 1.5)
  // a voice off the target by more than clean voices are gets the excess back, only that
  const dull = finished('speech'), n = 2 * (dull.ltas.length - 1)
  for (let k = 0; k < dull.ltas.length; k++) if (k * FS / n > 3000) dull.ltas[k] *= 10 ** (-20 / 20)
  const eq = plan(dull, { type: 'speech' }).stages.find(s => s.name === 'eq')
  assert.ok(eq, 'a voice 20 dB dull over 3 kHz is EQed')
  const at = f => eq.params.correction[Math.round(f * n / FS)]
  assert.ok(at(5000) > 1 && at(5000) < 20 - 6.9, `5 kHz: ${at(5000).toFixed(1)} dB, the excess over the spread`)
  assert.ok(Math.abs(at(500)) < 1, `500 Hz untouched: ${at(500).toFixed(1)} dB`)
})

// The loudness auto() promises: a quiet clean voice, 14 dB under the target, every 4th syllable 4 dB up (peak to
// loudness 15.7 dB, over the 15 the target and the ceiling leave), reaches it within 1 LU, its true peak under the
// -1 dBTP ceiling (the limiter reads the waveform between samples, BS.1770-4 Annex 2). Measured −16.1 LUFS, −1.00 dBTP;
// the gated build that stopped at the ceiling left it at −17.8.
test('a quiet clean take reaches the loudness target within 1 LU, its true peak under the ceiling', () => {
  const peaky = cleanTake.map((v, i) => Math.floor(i / FS / 0.5) % 4 === 1 ? v * 10 ** (4 / 20) : v)
  const lu = analyze([peaky], { fs: FS }).lufs, quiet = peaky.map(v => v * 10 ** ((-30 - lu) / 20))
  const { channels, recipe } = chain([quiet], { type: 'speech' }), a = analyze(channels, { fs: FS })
  assert.ok(Math.abs(a.lufs + 16) <= 1, `${a.lufs.toFixed(2)} LUFS (${recipe.stages.map(s => s.name)})`)
  assert.ok(a.truePeakDb <= -1 + 0.05, `true peak ${a.truePeakDb.toFixed(2)} dBTP`)
})

// ─── 4b. plan(speech) — each defect on its evidence alone ──────────────────

const REPAIR = ['declip', 'declick', 'deplosive', 'dehum', 'denoise', 'dereverb']
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
    ['hum', 'dehum', p => assert.deepEqual(p, {})],
    ['noise', 'denoise', p => assert.deepEqual(p, { gMin: -15 })],
    ['clicks', 'declick', p => assert.deepEqual(p, {})],
  ]) {
    const x = speech({ hum: false, noise: false, clicks: false, [defect]: true }), st = repairs(x)
    assert.deepEqual(st.map(s => s.name), [name], `${defect} alone`)
    check(st[0].params)
    // the stage alone, through apply(): error re the clean take, measured -23.1 -> -28.6 dB (hum: its lines down
    // 73 dB, what is left the voice's own sidebands on the 60 Hz lines dehum 0.5 takes to 8 kHz, the steady
    // synthetic voice AM'd at 2 Hz; 0.4's lines to 1 kHz left -80.3), -16.7 -> -23.3 (noise), -21.3 -> -66.4 (clicks)
    const y = apply([x], { fs: FS, targetLufs: -16, stages: st }, { fs: FS })[0]
    const before = errDb(x, cleanTake), after = errDb(y, cleanTake)
    assert.ok(after < before - { hum: 5, noise: 5, clicks: 30 }[defect], `${name}: error re clean ${before.toFixed(1)} -> ${after.toFixed(1)} dB`)
    if (defect === 'hum') for (const f of [60, 120, 180]) assert.ok(goertzelDb(x, f, FS) - goertzelDb(y, f, FS) > 40, `${f} Hz down ${(goertzelDb(x, f, FS) - goertzelDb(y, f, FS)).toFixed(1)} dB`)
  }
})

// chain 0.3 had no declip, deplosive or dereverb: a clipped, a popped and a reverberant take went unrepaired.
// Clipped: the clean take 12 dB hotter into rails at ±0.5. Popped: a pressure pulse (a 40 ms raised-cosine, through a
// 150 Hz low-pass) at each syllable's onset, at the voice's peak. Reverberant: the take through a room of 0.5 s (T60),
// its tail decaying exponentially (Polack's diffuse field) under the direct sound, 6 dB under it in energy.
function lowpass1(x, fc) { const a = Math.exp(-2 * Math.PI * fc / FS); let y = 0; return x.map(v => y = (1 - a) * v + a * y) }
const hot = cleanTake.map(v => 4 * v), clipped = hot.map(v => Math.max(-0.5, Math.min(0.5, v)))
const popped = (() => {
  const x = Float32Array.from(cleanTake), L = Math.round(0.04 * FS), p = new Float32Array(L)
  for (let i = 0; i < L; i++) p[i] = Math.sin(Math.PI * i / L) ** 2
  const lp = lowpass1(lowpass1(p, 150), 150), pk = Math.max(...lp)
  for (let t = 0; t < 4; t += 0.5) { const at = Math.round(t * FS); for (let i = 0; i < L && at + i < x.length; i++) x[at + i] += 0.5 * lp[i] / pk }
  return x
})()
const inRoom = tail => {
  // the tail as velvet noise (Järveläinen & Karjalainen 2007): one ±1 impulse per 0.5 ms cell, a sparse diffuse field
  const L = Math.round(0.6 * FS), cell = Math.round(0.0005 * FS), tau = 0.5 / 6.91 * FS, r = lcgNoise(2 * Math.ceil(L / cell), 1, 23), taps = []
  let e = 0
  for (let c = 1, j = 0; c * cell < L; c++, j += 2) { const at = c * cell + Math.floor((r[j] + 1) / 2 * cell), g = Math.sign(r[j + 1]) * Math.exp(-at / tau); taps.push([at, g]); e += g * g }
  for (const t of taps) t[1] *= Math.sqrt(tail / e)
  const y = Float32Array.from(cleanTake)
  for (let i = 0; i < y.length; i++) { const v = cleanTake[i]; if (v) for (const [at, g] of taps) if (i + at < y.length) y[i + at] += v * g }
  return y
}
const room = inRoom(0.25)

test('a clipped, a popped and a reverberant take each put in their repair, on its own evidence, and it repairs', () => {
  for (const [x, name, ref, gain] of [[clipped, 'declip', hot, 3], [popped, 'deplosive', cleanTake, 6], [room, 'dereverb', null, 0]]) {
    const a = analyze([x], { fs: FS }), st = plan(a, { type: 'speech' }).stages
    assert.ok(st.some(s => s.name === name), `${name}: ${st.map(s => s.name).join(',')}`)
    if (!ref) continue
    const y = apply([x], { fs: FS, targetLufs: -16, stages: st.filter(s => s.name === name) }, { fs: FS })[0]
    const before = errDb(x, ref), after = errDb(y, ref)
    assert.ok(after < before - gain, `${name}: error re the take before the damage ${before.toFixed(1)} -> ${after.toFixed(1)} dB`)
  }
  assert.equal(analyze([clipped], { fs: FS }).clipping.kind, 'rail')
  assert.equal(analyze([cleanTake], { fs: FS }).clipping.kind, null)
  // a room 30 dB under the voice, what a reading at home keeps: what dereverb would take stays under 1 % of the take
  const mild = analyze([inRoom(0.001)], { fs: FS })
  assert.ok(!(mild.reverb?.db > -20), `mild room: dereverb takes ${mild.reverb?.db}`)
  assert.ok(!plan(mild, { type: 'speech' }).stages.some(s => s.name === 'dereverb'))
})

// chain 0.3 ran its highpass first: it rang on each click and spread it before declick could find it, and a
// clipped take's flat tops were tilted off the rails before any declip could read them.
test('repairs run first, in the order the damage is undone: declip, declick, deplosive, then the highpass', () => {
  const names = pDirty.stages.map(s => s.name)
  assert.ok(names.indexOf('declick') < names.indexOf('hpf'), names.join(','))
  const st = plan(analyze([clipped], { fs: FS }), { type: 'speech' }).stages.map(s => s.name)
  assert.equal(st[0], 'declip', st.join(','))
})

// chain 0.3 drew the EQ with spectral-target's deviation(), levelled by the mean of its bins over 20 Hz–0.45·fs: the
// octaves over 5 kHz outweighed the rest, and a voice read 12 dB over its target under 4 kHz and was lifted up to 16 kHz.
// Now the correction is drawn where the target is known (speech: Byrne's 100 Hz–10 kHz; music: Pestana's 100 Hz–4 kHz)
// and fades to 0 within half an octave outside.
test('the EQ is drawn where its target is known: 0 past half an octave outside it', () => {
  for (const [recipe, hi] of [[pDirty, 10000], [pClean, 4000]]) {
    const c = recipe.stages.find(s => s.name === 'eq')?.params.correction
    if (!c) continue
    const n = 2 * (c.length - 1)
    for (let k = 1; k < c.length; k++) {
      const f = k * FS / n
      if (f >= hi * Math.SQRT2 || f <= 100 / Math.SQRT2) assert.equal(c[k], 0, `${recipe.type}: ${f.toFixed(0)} Hz corrected ${c[k]}`)
    }
  }
})

test('intensity scales denoise\'s floor and the deesser\'s deepest cut, not whether they fire', () => {
  for (const [intensity, gMin, range] of [[0, -2, 0], [0.5, -7.5, -4], [1, -15, -8], [2, -30, -16]]) {
    const st = plan(aDirty, { type: 'speech', intensity }).stages, by = n => st.find(s => s.name === n).params
    assert.equal(by('denoise').gMin, gMin, `intensity ${intensity}: gMin`)
    assert.equal(by('deesser').mode, undefined, 'the kernel\'s own mode (split: the band over 3.5 kHz alone)')
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

// chain 0.3 declared targetLufs -30..-6 with the sentinel 0 (the type's default) as its default: audio clamps a default
// into the declared range, so its auto() normalized every take to -6 LUFS, pushing a speech take 10 dB into the limiter.
test('manifest: the targetLufs sentinel survives a host clamping the default into its range', () => {
  const p = auto.params.targetLufs
  assert.equal(Math.min(p.max, Math.max(p.min, p.default)), 0)
})

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
