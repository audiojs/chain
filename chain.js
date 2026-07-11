// Auto-Chain — analysis-driven processing chain. Reverse-engineered from Dolby.io Media
// Enhance-class products: classical DSP, no ML. analyze() measures, plan() turns the
// measurements into an adaptive, cited stage list (the "recipe" — the visible chain
// Dolby/iZotope hide), apply() executes it, code() exports it as copy-paste runnable JS.
//
// Every stage below is a shipped @audio/* atom — this package is pure orchestration: no
// DSP kernel lives here except the two genuinely trivial ones (gain multiply, inline
// Goertzel for hum) that don't warrant their own published atom.

import lufsFn from '@audio/loudness-lufs'
import truepeakFn from '@audio/loudness-truepeak'
import lraFn from '@audio/loudness-lra'
import { minStats } from '@audio/noise-estimate'
import { stftAnalyse } from '@audio/stft'
import { vad } from '@audio/vad'
import { classify } from '@audio/denoise-detect'
import ltasFn from '@audio/spectral-ltas'
import targetCurve, { deviation } from '@audio/spectral-target'
import dehum from '@audio/denoise-dehum'
import wiener from '@audio/denoise-wiener'
import declick from '@audio/denoise-declick'
import deesser from '@audio/dynamics-deesser'
import multiband from '@audio/dynamics-multiband'
import limiter from '@audio/dynamics-limiter'
import firEq, { design as designFir } from '@audio/eq-fir'
import highpass from '@audio/filter-biquad/highpass'
import { encode as msEncode, decode as msDecode } from '@audio/spatial-midside'

// Noise-PSD analysis window — pinned to denoise-wiener's own defaults (frameSize 2048,
// hopSize 512 ⇒ half+1 = 1025 bins) so the profile analyze() builds slots straight into
// that kernel's `profile` option with no bin-count mismatch.
const NOISE_N = 2048, NOISE_HOP = 512
// LTAS analysis window — spectral-ltas / spectral-target's own shared default
// (bins = 4096/2+1 = 2049), so target()/deviation() need no explicit `bins` override.
const LTAS_FRAME = 4096
// EBU-informed loudness targets (todo.md Stage 2): speech/voice-music -16 LUFS, music -14.
const DEFAULT_LUFS = { speech: -16, music: -14, 'voice-music': -16 }

const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x

// Accept a bare mono Float32Array the same way every dependency kernel does.
const toChannels = (channels) => channels[0]?.length === undefined ? [channels] : channels

function toMono(channels) {
  const n = channels[0].length
  const mono = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length
  return mono
}

function median(arr) {
  const a = Float64Array.from(arr)
  a.sort()
  const n = a.length
  if (!n) return 0
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2
}

// Goertzel power at a single frequency — a 10-line inline DFT bin, cheaper than pulling
// fourier-transform in just for two-tone hum detection. Same technique
// @audio/denoise-detect uses internally for its own (hit-count) hum classifier; here it
// feeds an actual dB-above-floor measurement instead of a threshold count.
function goertzelPower(data, f, fs) {
  const w = 2 * Math.PI * f / fs, c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = 0; i < data.length; i++) { const s = data[i] + c * s1 - s2; s2 = s1; s1 = s }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / data.length
}

// Mains hum: fundamental + 2 harmonics (3 tones) at 50 Hz and 60 Hz, each measured
// against its own ±15 Hz off-tone floor — avoids the FFT-bin leakage / self-contamination
// a PSD-bin lookup would have this close to DC. Reports the stronger candidate once it
// clears ~10 dB above the local floor.
function detectHum(mono, fs) {
  const chunk = mono.length > 16384 ? mono.subarray(0, 16384) : mono
  const scan = (f0) => {
    let on = 0, off = 0, n = 0
    for (let h = 1; h <= 3; h++) {
      const f = f0 * h
      if (f > fs / 2 - 50 || f - 15 < 1) break
      on += goertzelPower(chunk, f, fs)
      off += Math.max((goertzelPower(chunk, f - 15, fs) + goertzelPower(chunk, f + 15, fs)) / 2, 1e-30)
      n++
    }
    return n ? 10 * Math.log10(on / off) : -Infinity
  }
  const db50 = scan(50), db60 = scan(60)
  const [freq, db] = db60 >= db50 ? [60, db60] : [50, db50]
  return db >= 10 ? { freq, db } : null
}

// Runs of consecutive |x| >= 0.999 (>=2 samples), summed across channels.
function detectClipping(channels) {
  let count = 0, clipped = 0, total = 0
  for (const ch of channels) {
    total += ch.length
    let run = 0
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) >= 0.999) { run++; clipped++ }
      else { if (run >= 2) count++; run = 0 }
    }
    if (run >= 2) count++
  }
  return { count, ratio: total ? clipped / total : 0 }
}

// Mean of a per-bin curve (linear or dB, caller's choice) over [lo, hi] Hz.
function bandMean(curve, fs, frameSize, lo, hi) {
  const k0 = Math.max(0, Math.ceil(lo * frameSize / fs))
  const k1 = Math.min(curve.length - 1, Math.floor(hi * frameSize / fs))
  let sum = 0, n = 0
  for (let k = k0; k <= k1; k++) { sum += curve[k]; n++ }
  return n ? sum / n : 0
}

function ltasToDb(ltas) {
  const out = new Float32Array(ltas.length)
  for (let k = 0; k < ltas.length; k++) out[k] = 20 * Math.log10(Math.max(ltas[k], 1e-12))
  return out
}

// Stereo width proxy: side/mid RMS ratio via the M/S matrix (0 = mono, ~1 = typical
// stereo, >1 = side-heavy). Only meaningful for >=2 channels — the first two are used.
function measureWidth(channels) {
  const [L, R] = channels
  let sm = 0, ss = 0
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5
    sm += m * m; ss += s * s
  }
  return Math.sqrt(ss / Math.max(sm, 1e-12))
}

// ─────────────────────────────────────────────────────────────────────────

export function analyze(channels, { fs = 44100 } = {}) {
  channels = toChannels(channels)
  const duration = channels[0].length / fs
  const mono = toMono(channels)

  const lufs = lufsFn(channels, { fs })
  const truePeakDb = truepeakFn(channels, { fs })
  const lra = lraFn(channels, { fs })

  // Noise PSD — Minimum Statistics (Martin 2001), tracked across the whole take so it
  // reflects quiet frames wherever they fall, not just a leading "noise-only" prefix.
  const half = NOISE_N >> 1
  const est = minStats(half, {})
  stftAnalyse(mono, mag => est.update(mag), { frameSize: NOISE_N, hopSize: NOISE_HOP })
  const noisePsd = Float32Array.from(est.psd)
  const noiseFloorDb = 10 * Math.log10(Math.max(median(est.psd), 1e-12))

  const ltas = ltasFn(mono, { frameSize: LTAS_FRAME })
  const sibilanceDb = 20 * Math.log10(
    Math.max(bandMean(ltas, fs, LTAS_FRAME, 5000, 9000), 1e-12) /
    Math.max(bandMean(ltas, fs, LTAS_FRAME, 1000, 4000), 1e-12)
  )

  const hum = detectHum(mono, fs)
  const clipping = detectClipping(channels)

  // Reuse denoise-detect's own classifier for the click score rather than re-deriving
  // AR-residual kurtosis — plan() reuses its exact threshold (12) for the declick trigger.
  const { scores } = classify(Float32Array.from(mono), fs)
  const clicks = scores.click

  const { active } = vad(Float32Array.from(mono), { fs })
  const voicedRatio = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0

  const analysis = {
    fs, duration, channels: channels.length,
    lufs, truePeakDb, lra,
    noiseFloorDb, noisePsd,
    ltas, sibilanceDb,
    hum, clipping, clicks, voicedRatio,
  }
  // Stereo width — only meaningful (and only cheap) for >=2 channels; consumed by
  // reference-mode's width-match stage (see plan()). Not in the illustrative shape
  // comment in the API brief, but reference mode explicitly needs it and this is the
  // one place that already has the channel pair in hand.
  if (channels.length >= 2) analysis.width = measureWidth(channels)
  return analysis
}

// ─────────────────────────────────────────────────────────────────────────

export function plan(analysis, opts = {}) {
  const type = opts.type ?? 'speech'
  const intensity = clamp(opts.intensity ?? 1, 0, 2)
  const reference = opts.reference
  const targetLufs = opts.targetLufs ?? (reference ? reference.lufs : (DEFAULT_LUFS[type] ?? DEFAULT_LUFS.speech))
  const fs = analysis.fs

  // Two independent buckets per stage's own concern — voice-music is hybrid and lands
  // on whichever side matters for that stage: speechLike (has vocal content worth
  // de-essing) includes voice-music; musicLike (full-mix bass/dynamics worth preserving
  // with a gentler HPF and a 3-band glue) also includes voice-music.
  const speechLike = type !== 'music'
  const musicLike = type !== 'speech'

  const stages = []

  // 1. hpf — always: DC/rumble guard. 25 Hz for music-like content (preserve bass under
  // a bed mix), 40 Hz for pure speech (nothing useful below it).
  const hpfHz = musicLike ? 25 : 40
  stages.push({
    atom: '@audio/filter-biquad', name: 'hpf',
    params: { fc: hpfHz, order: 2, Q: 0.707 },
    why: `DC/rumble guard, always applied — ${hpfHz} Hz highpass (${type} convention)`,
  })

  // 2. dehum — only if a mains candidate cleared the floor (detectHum's ~10 dB trigger).
  if (analysis.hum) {
    stages.push({
      atom: '@audio/denoise-dehum', name: 'dehum',
      params: { freq: analysis.hum.freq, harmonics: 4, Q: 30 },
      why: `mains hum at ${analysis.hum.freq} Hz, ${analysis.hum.db.toFixed(1)} dB above local floor (>=10 dB trigger)`,
    })
  }

  // 3. denoise — only once the noise floor clears -60 dB. Strength scales with both how
  // bad the floor is (-60 -> -40 dB maps light -> strong severity) and `intensity`.
  const NOISE_FLOOR_ON = -60, NOISE_FLOOR_MAX = -40
  if (analysis.noiseFloorDb > NOISE_FLOOR_ON) {
    const severity = clamp((analysis.noiseFloorDb - NOISE_FLOOR_ON) / (NOISE_FLOOR_MAX - NOISE_FLOOR_ON), 0, 1)
    const xiFloor = clamp(-10 - 15 * severity * intensity, -30, -2)
    stages.push({
      atom: '@audio/denoise-wiener', name: 'denoise',
      params: {
        rule: 'mmse-lsa', alphaDD: 0.98, xiFloor,
        frameSize: NOISE_N, hopSize: NOISE_HOP,
        profile: Array.from(analysis.noisePsd),
      },
      why: `noise floor ${analysis.noiseFloorDb.toFixed(1)} dB (> ${NOISE_FLOOR_ON} dB trigger), severity ${Math.round(severity * 100)}%`,
    })
  }

  // 4. declick — only if denoise-detect's own click score clears its declick threshold
  // (reused verbatim: that package selects its declick branch at score > 12).
  const CLICK_ON = 12
  if (analysis.clicks > CLICK_ON) {
    stages.push({
      atom: '@audio/denoise-declick', name: 'declick',
      params: { order: 60, windowSize: 1024, hopSize: 512, threshold: 4, guard: 2, maxBurst: 64 },
      why: `impulsive clicks — AR-residual kurtosis ${analysis.clicks.toFixed(1)} (> ${CLICK_ON} trigger)`,
    })
  }

  // 5. deesser — speech-bearing types only, only once sibilance clears the mid-band
  // ratio. The deesser's own threshold param tightens with how far sibilance overshoots.
  const SIB_ON = -8
  if (speechLike && analysis.sibilanceDb > SIB_ON) {
    const excess = analysis.sibilanceDb - SIB_ON
    const threshold = clamp(-20 - excess * intensity, -40, -8)
    stages.push({
      atom: '@audio/dynamics-deesser', name: 'deesser',
      params: { mode: 'band', freq: 6500, q: 1.4, threshold, ratio: 4 },
      why: `sibilance ${analysis.sibilanceDb.toFixed(1)} dB rel. 1-4 kHz band (> ${SIB_ON} dB trigger)`,
    })
  }

  // 6. eq — adaptive match toward the content-type (or reference) target curve;
  // skipped when the resulting correction is inaudibly small. Smoothed at a full
  // octave (vs. deviation()'s own 1/3-oct default) — this is a broad-strokes mastering
  // correction, not a surgical parametric one, and a wider window keeps thinly-sampled
  // bands (sparse harmonic content, near-silent octaves) from producing erratic
  // narrow-band swings that would otherwise re-boost exactly the frequencies denoise
  // just cleaned up.
  {
    const bins = analysis.ltas.length
    const targetDb = reference ? ltasToDb(reference.ltas) : targetCurve(type, { fs, bins })
    const correction = deviation(analysis.ltas, targetDb, { fs, smoothOct: 1 })
    for (let k = 0; k < correction.length; k++) correction[k] *= intensity
    let maxAbs = 0
    for (let k = 0; k < correction.length; k++) maxAbs = Math.max(maxAbs, Math.abs(correction[k]))
    if (maxAbs >= 1) {
      stages.push({
        atom: '@audio/eq-fir', name: 'eq',
        params: { correction: Array.from(correction), taps: 511 },
        why: reference
          ? `spectral deviation from reference LTAS, max ${maxAbs.toFixed(1)} dB (>=1 dB trigger)`
          : `spectral deviation from ${type} target curve, max ${maxAbs.toFixed(1)} dB (>=1 dB trigger)`,
      })
    }
  }

  // 7. multiband — light glue. Always for music-like content (2-4 kHz-split 3-band);
  // for pure speech only when dynamics are wide (LRA > 12 LU), then a gentler 2-band
  // split. Downward-only (upRatio 1) and ratio capped at 2 keeps it "light."
  const LRA_WIDE = 12
  const lra = analysis.lra ?? 0
  const widenSpeech = !musicLike && lra > LRA_WIDE
  if (musicLike || widenSpeech) {
    stages.push({
      atom: '@audio/dynamics-multiband', name: 'multiband',
      params: {
        freqs: musicLike ? [200, 2000] : [1000],
        threshold: -24, ratio: clamp(1 + 0.5 * intensity, 1, 2),
        upThreshold: -40, upRatio: 1, depth: 1,
        attack: 5, release: 150, makeup: 0,
      },
      why: musicLike
        ? `content-type preset: ${type} -> gentle 3-band glue, always applied`
        : `wide dynamics: LRA ${lra.toFixed(1)} LU (> ${LRA_WIDE} LU trigger) -> gentle 2-band glue`,
    })
  }

  // Reference mode: stereo width match — side-gain toward the reference's own width.
  if (reference && reference.width != null && analysis.width != null) {
    const w = clamp(reference.width / Math.max(analysis.width, 1e-6), 0, 4)
    stages.push({
      atom: '@audio/spatial-midside', name: 'width',
      params: { width: w },
      why: `stereo width ${analysis.width.toFixed(2)} -> reference width ${reference.width.toFixed(2)} (side gain x${w.toFixed(2)})`,
    })
  }

  // 9 in the stage catalog, but pushed here (before the limiter) because that's
  // execution order: normalize loudness, then brickwall the peaks it may have raised.
  const measured = analysis.lufs ?? targetLufs
  const gainDb = clamp(targetLufs - measured, -20, 20)
  stages.push({
    atom: 'gain', name: 'gain',
    params: { db: Number(gainDb.toFixed(3)) },
    why: `loudness normalization: measured ${measured.toFixed(1)} LUFS -> target ${targetLufs} LUFS`,
  })

  // 8 in the stage catalog — always, true-peak ceiling. Reference mode tightens the
  // ceiling to the reference's own true peak when that's the lower (safer) bound.
  let ceiling = opts.ceiling ?? -1
  if (reference && reference.truePeakDb != null) ceiling = Math.min(ceiling, reference.truePeakDb)
  stages.push({
    atom: '@audio/dynamics-limiter', name: 'limiter',
    params: { ceiling, lookahead: 5, release: 50 },
    why: `true-peak ceiling ${ceiling.toFixed(1)} dBTP, always applied${reference ? ' (matched to reference)' : ''}`,
  })

  return { fs, type, intensity, targetLufs, stages }
}

// ─────────────────────────────────────────────────────────────────────────

function runStage(stage, out, fs) {
  const p = stage.params
  switch (stage.name) {
    case 'hpf':
      for (let c = 0; c < out.length; c++) out[c] = highpass(out[c], { fc: p.fc, order: p.order, Q: p.Q, fs })
      break
    case 'dehum':
      for (let c = 0; c < out.length; c++) out[c] = dehum(out[c], { freq: p.freq, harmonics: p.harmonics, Q: p.Q, fs })
      break
    case 'denoise':
      for (let c = 0; c < out.length; c++)
        out[c] = wiener(out[c], {
          profile: p.profile, frameSize: p.frameSize, hopSize: p.hopSize, fs,
          rule: p.rule, alphaDD: p.alphaDD, xiMin: 10 ** (p.xiFloor / 10),
        })
      break
    case 'declick':
      for (let c = 0; c < out.length; c++) out[c] = declick(out[c], p)
      break
    case 'deesser':
      for (let c = 0; c < out.length; c++)
        out[c] = deesser(out[c], { sampleRate: fs, mode: p.mode, freq: p.freq, q: p.q, threshold: p.threshold, ratio: p.ratio })
      break
    case 'eq': {
      const correction = Float32Array.from(p.correction)
      const n = 2 * (correction.length - 1)
      const response = (f) => {
        let k = Math.round(f * n / fs)
        if (k < 0) k = 0; else if (k >= correction.length) k = correction.length - 1
        return correction[k]
      }
      const coefs = designFir(response, { taps: p.taps, fs })
      for (let c = 0; c < out.length; c++) out[c] = firEq(out[c], { coefs })
      break
    }
    case 'multiband':
      for (let c = 0; c < out.length; c++)
        out[c] = multiband(out[c], {
          fs, freqs: p.freqs,
          bands: {
            threshold: p.threshold, ratio: p.ratio, upThreshold: p.upThreshold,
            upRatio: p.upRatio, depth: p.depth, attack: p.attack, release: p.release, makeup: p.makeup,
          },
        })
      break
    case 'width':
      if (out.length >= 2) { msEncode([out[0], out[1]]); msDecode([out[0], out[1]], { width: p.width }) }
      break
    case 'gain': {
      const g = 10 ** (p.db / 20)
      for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= g
      break
    }
    case 'limiter':
      for (let c = 0; c < out.length; c++) out[c] = limiter(out[c], { sampleRate: fs, ceiling: p.ceiling, lookahead: p.lookahead, release: p.release })
      break
    default:
      throw new Error(`@audio/chain: apply() — unknown stage "${stage.name}"`)
  }
}

export function apply(channels, recipe, { fs = 44100 } = {}) {
  channels = toChannels(channels)
  const out = channels.map(ch => Float32Array.from(ch))

  for (const stage of recipe.stages) runStage(stage, out, fs)

  // Single refinement pass: re-measure once after gain+limiter, trim <= +-2 dB if the
  // integrated loudness missed target, then re-limit (a trim can otherwise punch a new
  // true-peak overshoot through the ceiling the limiter stage just enforced above).
  const limiterStage = recipe.stages.find(s => s.name === 'limiter')
  if (limiterStage) {
    const measured = lufsFn(out, { fs })
    if (measured != null && isFinite(measured)) {
      const trim = clamp(recipe.targetLufs - measured, -2, 2)
      if (Math.abs(trim) > 0.01) {
        const g = 10 ** (trim / 20)
        for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= g
        for (let c = 0; c < out.length; c++)
          out[c] = limiter(out[c], {
            sampleRate: fs,
            ceiling: limiterStage.params.ceiling,
            lookahead: limiterStage.params.lookahead,
            release: limiterStage.params.release,
          })
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────

export default function chain(channels, opts = {}) {
  const fs = opts.fs ?? 44100
  const analysis = analyze(channels, { fs })
  const recipe = plan(analysis, opts)
  const outChannels = apply(channels, recipe, { fs })
  return { channels: outChannels, recipe, analysis }
}

// ─────────────────────────────────────────────────────────────────────────

// Exports the recipe as copy-paste runnable ESM: imports of each stage's atom, then the
// stages applied in order with the exact params the recipe carries (including embedded
// derived data — the noise profile, the EQ correction curve — so the script reproduces
// the render without re-analyzing anything).
export function code(recipe) {
  const fs = recipe.fs
  const seen = new Set()
  const importLines = []
  const addImport = (line) => { if (!seen.has(line)) { seen.add(line); importLines.push(line) } }
  const bodyLines = []

  for (const stage of recipe.stages) {
    const p = stage.params
    bodyLines.push(`// ${stage.name} — ${stage.why}`)
    switch (stage.name) {
      case 'hpf':
        addImport(`import highpass from '@audio/filter-biquad/highpass'`)
        bodyLines.push(`for (const ch of channels) highpass(ch, ${JSON.stringify({ fc: p.fc, order: p.order, Q: p.Q, fs })})`)
        break
      case 'dehum':
        addImport(`import dehum from '@audio/denoise-dehum'`)
        bodyLines.push(`for (const ch of channels) dehum(ch, ${JSON.stringify({ freq: p.freq, harmonics: p.harmonics, Q: p.Q, fs })})`)
        break
      case 'denoise':
        addImport(`import wiener from '@audio/denoise-wiener'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = wiener(ch, { profile: ${JSON.stringify(p.profile)}, frameSize: ${p.frameSize}, hopSize: ${p.hopSize}, fs, rule: ${JSON.stringify(p.rule)}, alphaDD: ${p.alphaDD}, xiMin: ${10 ** (p.xiFloor / 10)} }) })`)
        break
      case 'declick':
        addImport(`import declick from '@audio/denoise-declick'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = declick(ch, ${JSON.stringify(p)}) })`)
        break
      case 'deesser':
        addImport(`import deesser from '@audio/dynamics-deesser'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = deesser(ch, ${JSON.stringify({ sampleRate: fs, mode: p.mode, freq: p.freq, q: p.q, threshold: p.threshold, ratio: p.ratio })}) })`)
        break
      case 'eq':
        addImport(`import firEq, { design } from '@audio/eq-fir'`)
        bodyLines.push([
          `{`,
          `  const correction = ${JSON.stringify(p.correction)}`,
          `  const n = 2 * (correction.length - 1)`,
          `  const response = (f) => correction[Math.min(correction.length - 1, Math.max(0, Math.round(f * n / fs)))]`,
          `  const coefs = design(response, { taps: ${p.taps}, fs })`,
          `  channels.forEach((ch, i) => { channels[i] = firEq(ch, { coefs }) })`,
          `}`,
        ].join('\n'))
        break
      case 'multiband':
        addImport(`import multiband from '@audio/dynamics-multiband'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = multiband(ch, ${JSON.stringify({
          fs, freqs: p.freqs,
          bands: { threshold: p.threshold, ratio: p.ratio, upThreshold: p.upThreshold, upRatio: p.upRatio, depth: p.depth, attack: p.attack, release: p.release, makeup: p.makeup },
        })}) })`)
        break
      case 'width':
        addImport(`import { encode, decode } from '@audio/spatial-midside'`)
        bodyLines.push(`if (channels.length >= 2) { encode([channels[0], channels[1]]); decode([channels[0], channels[1]], ${JSON.stringify({ width: p.width })}) }`)
        break
      case 'gain':
        bodyLines.push(`{ const g = ${10 ** (p.db / 20)}; for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g }`)
        break
      case 'limiter':
        addImport(`import limiter from '@audio/dynamics-limiter'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = limiter(ch, ${JSON.stringify({ sampleRate: fs, ceiling: p.ceiling, lookahead: p.lookahead, release: p.release })}) })`)
        break
    }
    bodyLines.push('')
  }

  return `// audiojs recipe — generated by @audio/chain
// type: ${recipe.type} · intensity: ${recipe.intensity} · targetLufs: ${recipe.targetLufs}

${importLines.join('\n')}

const fs = ${fs}
// channels: Float32Array[] — mutated stage by stage, mirroring apply()

${bodyLines.join('\n')}`
}
