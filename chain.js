// Auto-Chain — analysis-driven processing chain. Reverse-engineered from Dolby.io Media
// Enhance-class products: classical DSP, no ML. analyze() measures, plan() turns the
// measurements into an adaptive, cited stage list (the "recipe" — the visible chain
// Dolby/iZotope hide), apply() executes it, code() exports it as copy-paste runnable JS.
// One stage may be neural, named by plan() when its caller can run it (`neural`: a speech
// bed to DeepFilterNet3) and run by that caller; this package runs none and imports none.
//
// Every stage below is a shipped @audio/* atom — this package is pure orchestration: no
// DSP kernel lives here except the one genuinely trivial one (gain multiply) that
// doesn't warrant its own published atom.

import lufsFn from '@audio/loudness-lufs'
import truepeakFn from '@audio/loudness-truepeak'
import lraFn from '@audio/loudness-lra'
import { vad } from '@audio/vad'
import { classify, CLICK_RATE, BED_SNR } from '@audio/denoise-detect'
import ltasFn from '@audio/spectral-ltas'
import targetCurve, { deviation } from '@audio/spectral-target'
import dehum from '@audio/denoise-dehum'
import omlsa from '@audio/denoise-omlsa'
import declick from '@audio/denoise-declick'
import declip, { rails, bands } from '@audio/denoise-declip'
import dereverb from '@audio/denoise-dereverb'
import deplosive from '@audio/denoise-deplosive'
import deesser from '@audio/dynamics-deesser'
import multiband from '@audio/dynamics-multiband'
import limiter from '@audio/dynamics-limiter'
import firEq, { design as designFir } from '@audio/eq-fir'
import highpass from '@audio/filter-biquad/highpass'
import { encode as msEncode, decode as msDecode } from '@audio/spatial-midside'

// LTAS analysis window — spectral-ltas / spectral-target's own shared default
// (bins = 4096/2+1 = 2049), so target() needs no explicit `bins` override.
const LTAS_FRAME = 4096
// EBU-informed loudness targets (todo.md Stage 2): speech/voice-music -16 LUFS, music -14.
const DEFAULT_LUFS = { speech: -16, music: -14, 'voice-music': -16 }

const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x

// What dereverb and deplosive take, dB re the take, over which a room or pops are a defect to repair. On the speech
// tuning takes of audio's bench/rx/assistant.mjs, dereverb took −12.7 dB or more from every take in a room, and from
// the readings' own mild rooms −21 to −31 dB (PESQ against them 4.64 → 4.15–4.60); deplosive took −21.4 dB or more
// from every take with pops, and from the rest down to −65 (a voice's own low end at a word's onset).
const REVERB_MIN = -20, POPS_MIN = -22

// The neural denoiser a plan names with `neural`: @audio/neural-denoise's DeepFilterNet3 (Schröter et al., Interspeech
// 2023), its output mixed back by the package's mixback(), the noise DFN_LIMIT dB × intensity down. This package does
// not run it (it is asynchronous, an ONNX model): apply() refuses it, its executor runs it (audio's auto()), code()
// awaits it. On the 40 speech tuning takes of audio's bench/rx/assistant.mjs whose plan holds denoise, repairs alone,
// PESQ / STOI / SI-SDR / DNSMOS OVRL: OM-LSA 1.99 / 0.868 / 14.7 dB / 2.87; DeepFilterNet3 at deepfilter()'s defaults
// (18 dB, noise near the voice to 40 dB under it) 2.51 / 0.894 / 16.5 / 3.13, at 24 and 30 dB 2.55 and 2.61, at 60
// 2.74 / 0.896 / 16.5 / 3.20, its whole removal the same (DNSMOS SIG 3.43, OM-LSA 3.36: the voice no worse for it).
// A steady bed alone 2.61 → 3.31, DEMAND's 1.86 → 2.84. At 60 dB down no bed reaches a floor (40 dB under the voice:
// 50 and 60 scored as none), so none: the noise goes 60 dB down, a trace of the room left, not digital silence.
const NEURAL = '@audio/neural-denoise', DFN_LIMIT = 60

// Accept a bare mono Float32Array the same way every dependency kernel does.
const toChannels = (channels) => channels[0]?.length === undefined ? [channels] : channels

function toMono(channels) {
  const n = channels[0].length
  const mono = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length
  return mono
}

// Clipping, by declip's own evidence, per channel: a rail (the samples a hard clip cut piled onto one level, in runs:
// FFmpeg adeclip's top-bin test, relative to the rail) or, with none, a band (a rail lossy coding spread: a mode at the
// extreme with mass either side of it). count: runs of 2 or more at a rail (or over a band's cut); ratio: the share of
// samples there; level: the lowest rail, dBFS; kind: 'rail', 'band' or null. declip rebuilds exactly these samples.
const TAU = 1e-3, KAPPA = 6        // declip's: a rail's width (share of the rail), a band's cut (spreads under its mode)
function detectClipping(channels) {
  let count = 0, clipped = 0, total = 0, level = Infinity, kind = null
  for (const ch of channels) {
    total += ch.length
    let { hi, lo } = rails(ch), band = false
    if (hi == null && lo == null) {
      const b = bands(ch), cut = (m, s) => m && m.r - KAPPA * m.s > 0 ? s * (m.r - KAPPA * m.s) : null
      hi = cut(b.hi, 1); lo = cut(b.lo, -1); band = hi != null || lo != null
    }
    if (hi == null && lo == null) continue
    kind = kind === 'rail' || !band ? 'rail' : 'band'
    const th = hi == null ? Infinity : band ? hi : hi * (1 - TAU), tl = lo == null ? -Infinity : band ? lo : lo * (1 - TAU)
    for (const r of [hi, lo]) if (r != null) level = Math.min(level, 20 * Math.log10(Math.abs(r)))
    let run = 0
    for (let i = 0; i <= ch.length; i++) {
      if (i < ch.length && (ch[i] >= th || ch[i] <= tl)) { run++; clipped++ }
      else { if (run >= 2) count++; run = 0 }
    }
  }
  return { count, ratio: total ? clipped / total : 0, level: kind ? level : null, kind }
}

// What a self-gating repair takes from x: null when y comes back bit for bit, else the energy taken re x, dB (and the
// spans it moved: runs of changed samples, 50 ms apart or more, for pops)
function taken(x, y, fs) {
  let e = 0, p = 0, spans = 0, last = -Infinity
  const gap = 0.05 * fs
  for (let i = 0; i < x.length; i++) {
    const d = y[i] - x[i]
    p += x[i] * x[i]
    if (d === 0) continue
    e += d * d
    if (i - last > gap) spans++
    last = i
  }
  return e > 0 ? { db: 10 * Math.log10(e / p), spans } : null
}

// Mean of a per-bin curve (linear or dB, caller's choice) over [lo, hi] Hz.
function bandMean(curve, fs, frameSize, lo, hi) {
  const k0 = Math.max(0, Math.ceil(lo * frameSize / fs))
  const k1 = Math.min(curve.length - 1, Math.floor(hi * frameSize / fs))
  let sum = 0, n = 0
  for (let k = k0; k <= k1; k++) { sum += curve[k]; n++ }
  return n ? sum / n : 0
}

// The spread of clean voices about Byrne et al.'s LTASS: the largest octave-smoothed deviation from it (dB, at each
// octave's centre) over the 61 clean speech takes of audio's bench/rx/assistant.mjs tuning split (VoiceBank's training
// speakers, readings). The LTASS is an average over talkers: a voice within this far of it is one of them, not a tonal
// defect, and the EQ corrects only the excess.
const SPREAD = [[125, 10.0], [250, 8.4], [500, 8.7], [1000, 7.4], [2000, 6.9], [4000, 12.0], [8000, 8.6]]
// the spread at f Hz: log-frequency interpolation between octave centres, held past the ends
function spreadAt(table, f) {
  if (f <= table[0][0]) return table[0][1]
  for (let i = 1; i < table.length; i++) if (f <= table[i][0]) {
    const [f0, v0] = table[i - 1], [f1, v1] = table[i], t = Math.log2(f / f0) / Math.log2(f1 / f0)
    return v0 + t * (v1 - v0)
  }
  return table[table.length - 1][1]
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

export function analyze(channels, { fs = 44100, type } = {}) {
  channels = toChannels(channels)
  const duration = channels[0].length / fs
  const mono = toMono(channels)

  const lufs = lufsFn(channels, { fs })
  const truePeakDb = truepeakFn(channels, { fs })
  const lra = lraFn(channels, { fs })

  const ltas = ltasFn(mono, { frameSize: LTAS_FRAME })
  const sibilanceDb = 20 * Math.log10(
    Math.max(bandMean(ltas, fs, LTAS_FRAME, 5000, 9000), 1e-12) /
    Math.max(bandMean(ltas, fs, LTAS_FRAME, 1000, 4000), 1e-12)
  )

  const clipping = detectClipping(channels)

  // The defects, by @audio/denoise-detect's evidence (its README has the confusion matrix):
  // each needs positive evidence, so a clean take reads no clicks and no bed. Its scores are
  // independent, and plan() reads each.
  const { scores } = classify(mono, fs)
  const clicks = scores.click, snr = scores.snr

  // The repairs that judge for themselves (dehum, deplosive, dereverb) are run here on the mono mix, as the plan hands
  // it to them: past declick, which runs before each (an isolated click, a jump out of nothing, reads to dereverb as a
  // fall no room allows). Each returns a take it finds nothing in bit for bit; what it took is the evidence.
  const pre = clicks > CLICK_RATE ? declick(Float32Array.from(mono), { fs }) : mono

  // Hum, by dehum's own detection: its measurement of the whole take, else lines tracked along the 50 and 60 Hz series
  // (hum under music, too faint over the whole take for one transform). denoise-detect's verdict (its series by the one
  // transform, A-weighted within 50 dB of the program) found 26 % of the speech tuning takes' hum 20–35 dB under the
  // voice, dehum 45 %. freq, harmonics, level: denoise-detect's measured series, when it found one.
  const humTaken = pre.length ? taken(pre, dehum(Float32Array.from(pre), { fs }), fs) : null
  const hum = humTaken ? { freq: scores.humFreq || null, harmonics: scores.hum, level: scores.humLevel, taken: humTaken.db } : null

  const { voiced } = vad(mono, { fs })
  const voicedRatio = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 0

  // A voice's room and pops; with music in the take neither is read (a held note's sustain reads as a room, a kick as a
  // pop). dereverb finds a diffuse tail falling slower than the voice (its dry, diffuse and pauses checks; the take is
  // speech by its type, so its music check stands aside: a held vowel reads to it as a held note); deplosive a
  // thump under 80 Hz rising out of nothing over the voice's band and holding without a period.
  const voice = (type ?? 'speech') === 'speech' && mono.length > 0
  const reverb = voice ? taken(pre, dereverb(pre, { fs, music: 'enhance' }), fs) : null
  const pops = voice ? taken(pre, deplosive(Float32Array.from(pre), { fs }), fs) : null

  const analysis = {
    fs, duration, channels: channels.length,
    lufs, truePeakDb, lra,
    snr, ltas, sibilanceDb,
    hum, clipping, clicks, voicedRatio, reverb, pops,
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

  // Repairs first, in the order the damage is undone (the last done first: iZotope's own chain, RX 12 Repair
  // Assistant's, de-clip, de-click, de-hum, de-noise, de-reverb, de-ess), then the tone and level stages. Each repair
  // stands on its own evidence; a clean take gets none.

  // 1. declip: on declip's own evidence (a rail, or a band lossy coding spread). First: every other stage moves the
  // samples off the rails it rebuilds from (a highpass alone tilts a flat top). The kernel's defaults.
  const clip = analysis.clipping
  if (clip?.kind) {
    stages.push({
      atom: '@audio/denoise-declip', name: 'declip',
      params: {},
      why: `clipped: ${clip.count} runs at ${clip.kind === 'band' ? 'a coded rail' : 'the rails'}, ${clip.level.toFixed(1)} dBFS, ${(100 * clip.ratio).toFixed(2)} % of samples`,
    })
  }

  // 2. declick: only if denoise-detect's own click rate clears its declick threshold
  // (CLICK_RATE, the one that package selects its declick branch at). Kernel defaults. Before the
  // highpass, which would ring on each click and spread it.
  if (analysis.clicks > CLICK_RATE) {
    stages.push({
      atom: '@audio/denoise-declick', name: 'declick',
      params: {},
      why: `impulsive clicks, ${analysis.clicks.toFixed(1)} a second (> ${CLICK_RATE} trigger)`,
    })
  }

  // 3. deplosive: speech alone (a kick drum is a pop to it), where deplosive's own detection (a thump under 80 Hz
  // rising out of nothing over the voice's band, without a period) takes over POPS_MIN of the take. Before the
  // highpass, which leaves its response to a pop's edges behind. The kernel's defaults.
  if (type === 'speech' && analysis.pops?.db > POPS_MIN) {
    stages.push({
      atom: '@audio/denoise-deplosive', name: 'deplosive',
      params: {},
      why: `plosive pops: ${analysis.pops.spans} taken, ${analysis.pops.db.toFixed(1)} dB of the take`,
    })
  }

  // 4. hpf: always: DC/rumble guard. 40 Hz for pure speech (nothing useful below it); 20 Hz, the bottom of hearing, for
  // music-like content: at 0.3's 25 Hz the guard took the sub-bass out of 4 of the 32 tuning mixes (PEAQ ODG under
  // −0.5; mean 0.06 against 0.17 at 20 Hz, 0.21 untouched).
  const hpfHz = musicLike ? 20 : 40
  stages.push({
    atom: '@audio/filter-biquad', name: 'hpf',
    params: { fc: hpfHz, order: 2, Q: 0.707 },
    why: `DC/rumble guard, always applied — ${hpfHz} Hz highpass (${type} convention)`,
  })

  // 5. dehum: on dehum's own detection (analyze()); it finds the series again, tracks its exact frequency and takes
  // every harmonic to 1 kHz and every line over it to 8 kHz. The kernel's defaults.
  if (analysis.hum) {
    const { freq, taken } = analysis.hum
    stages.push({
      atom: '@audio/denoise-dehum', name: 'dehum',
      params: {},
      why: `mains hum${freq ? ` at ${freq.toFixed(2)} Hz` : ''}: ${taken.toFixed(1)} dB of the take (dehum's own detection)`,
    })
  }

  // 6. denoise: speech-bearing types, only on a noise bed within BED_SNR of the program, shown in its pauses or held
  // at its bands' floor. omlsa, as denoise-detect routes every bed (STOI +0.007 over wiener on
  // ~1000 takes: its README), tracks the bed itself (IMCRA, Cohen 2003), so a bed that changes
  // over the take is followed. Not on music: tracking a dense mix it takes held parts of the mix for the bed (clean
  // MUSDB18 previews through it: SDR 4–9 dB to themselves), and on every music take of the tuning split it went on
  // (beds 15–35 dB under the mix, and three clean mixes whose steady parts read as one) it left the take further from
  // the clean mix than it came (SI-SDR −1.8 to −10.7 dB) and PEAQ's grade no better. `intensity` scales the floor the
  // noise is taken to from the kernel's −15 dB.
  // With `neural` (its caller runs @audio/neural-denoise: audio's auto()), speech's bed goes to DeepFilterNet3 instead
  // (NEURAL above); voice-music keeps omlsa, as the model takes a music bed under a voice for noise. A take the model's
  // guard passes as music in its larger part ({ music }: the share its caller saw it pass where this stage runs) the
  // model would leave as it came: omlsa there, as without it. The gate is the bed's evidence alone: the 15 tuning beds it
  // misses would gain as much (PESQ 2.36 → 2.95), but neither its level nor the model's own removal tells them from
  // other takes: clean ones read 23–66 dB under where they read 25.5–47, and on the 96 takes without a bed read under
  // 40 dB the model cost the clean ones PESQ 0.08 (4.55 → 4.47), most others 0.3–2.3 dB of SI-SDR; what it takes where
  // this stage runs is a room's tail first (−4 to −11 dB of the takes in a room, −5 to −24 of the missed beds), and over
  // −18 dB it added 9 of the beds with 20 other takes, one clean: PESQ +0.18 a take, STOI −0.003, SI-SDR −0.8 dB.
  const bed = analysis.snr < BED_SNR, music = opts.neural?.music > 0.5
  if (speechLike && bed) {
    const why = `noise bed ${analysis.snr.toFixed(1)} dB under the program (< ${BED_SNR} dB trigger)`
    stages.push(opts.neural && type === 'speech' && !music ? {
      atom: NEURAL, name: 'denoise',
      params: { model: 'deepfilternet3', limit: Math.max(2, DFN_LIMIT * intensity), floor: 0 },
      why,
    } : {
      atom: '@audio/denoise-omlsa', name: 'denoise',
      params: { gMin: clamp(-15 * intensity, -30, -2) },
      why: why + (music ? `; DeepFilterNet3 hears music in ${Math.round(100 * opts.neural.music)} % of it` : ''),
    })
  }

  // 7. dereverb: speech alone (a held note's sustain reads as a room), where its own checks find a diffuse tail falling
  // slower than the voice (dry takes pass it bit for bit) and it takes over REVERB_MIN of the take. After the denoiser:
  // a bed under the voice reads as a tail that never falls. `intensity` scales the late estimate (`strength`, the
  // kernel's 1).
  if (type === 'speech' && analysis.reverb?.db > REVERB_MIN) {
    stages.push({
      atom: '@audio/denoise-dereverb', name: 'dereverb',
      params: { strength: intensity, music: 'enhance' },
      why: `late reverberation: a diffuse tail, ${analysis.reverb.db.toFixed(1)} dB of the take (dereverb's dry, diffuse and pauses checks)`,
    })
  }

  // 8. deesser: speech-bearing types only, only once sibilance clears the mid-band
  // ratio. The kernel judges each 's' itself (its band over the voice body, dB, against
  // its threshold) and cuts the band over its split by how far it rises (its default mode, 'split': with no 's' the
  // input passes sample for sample); `intensity` scales the deepest cut from its −8 dB `range`. One take can't tell a
  // sibilant speaker from a harsh recording: on the tuning takes, harsh ones (sibilants 4–12 dB up) and the rest overlap
  // on this ratio and on the deesser's own mean cut alike, and the deesser gains a harsh take PESQ 0.15 where it costs a
  // clean one 0.03. −6 dB keeps 56 % of the harsh takes at 9 % of the rest (−8: 69 % at 22 %; summed PESQ over the
  // tuning takes −0.12 against −0.92).
  const SIB_ON = -6
  if (speechLike && analysis.sibilanceDb > SIB_ON) {
    stages.push({
      atom: '@audio/dynamics-deesser', name: 'deesser',
      params: { range: -8 * intensity || 0 },   // || 0: no −0 in the recipe
      why: `sibilance ${analysis.sibilanceDb.toFixed(1)} dB rel. 1-4 kHz band (> ${SIB_ON} dB trigger)`,
    })
  }

  // 9. eq: toward the type's target curve (spectral-target's deviation over the band the target is known in, levelled
  // per octave, smoothed an octave: a broad-strokes correction, not a surgical one), only by what lies beyond the spread
  // clean recordings of the type keep about it (SPREAD), × intensity; skipped under 1 dB. A voice within it gets no EQ.
  // Speech only: Byrne et al.'s LTASS holds across talkers and languages, while Pestana et al.'s slope is the average of
  // commercial pop mixes, not of music (a solo trumpet lies 6–7 dB past the spread of mixes and is no worse for it), and
  // voice-music's is a convention. Reference mode matches the reference whole: there the match is the request.
  if (reference || type === 'speech') {
    const bins = analysis.ltas.length, n = 2 * (bins - 1)
    const targetDb = reference ? ltasToDb(reference.ltas) : targetCurve(type, { fs, bins })
    const correction = deviation(analysis.ltas, targetDb, { fs, smoothOct: 1 })
    const spread = reference ? null : SPREAD
    let maxAbs = 0
    for (let k = 0; k < bins; k++) {
      const c = correction[k], over = spread ? Math.max(0, Math.abs(c) - spreadAt(spread, k * fs / n)) : Math.abs(c)
      correction[k] = (Math.sign(c) * over * intensity) || 0
      maxAbs = Math.max(maxAbs, Math.abs(correction[k]))
    }
    if (maxAbs >= 1) {
      stages.push({
        atom: '@audio/eq-fir', name: 'eq',
        params: { correction: Array.from(correction), taps: 511 },
        why: reference
          ? `spectral deviation from reference LTAS, max ${maxAbs.toFixed(1)} dB (>=1 dB trigger)`
          : `tone ${maxAbs.toFixed(1)} dB past the spread of clean voices about the speech target curve (>=1 dB trigger)`,
      })
    }
  }

  // 10. multiband: glue only where the take's dynamics are wider than finished programme keeps them: its loudness range
  // (EBU Tech 3342) over 12 LU, where no clean tuning take, speech or music, came within 7 LU; its ratio by how far over
  // (to 2), × intensity; the threshold at the take's own integrated loudness. 2-band for speech, 3-band where music is.
  const LRA_WIDE = 12
  const lra = analysis.lra ?? 0
  if (lra > LRA_WIDE) {
    const ratio = clamp(1 + intensity * (lra - LRA_WIDE) / LRA_WIDE, 1, 2)
    stages.push({
      atom: '@audio/dynamics-multiband', name: 'multiband',
      params: {
        freqs: musicLike ? [200, 2000] : [1000],
        threshold: Math.round(analysis.lufs ?? -24), ratio: Number(ratio.toFixed(3)),
        upThreshold: -40, upRatio: 1, depth: 1,
        attack: 5, release: 150, makeup: 0,
      },
      why: `wide dynamics: LRA ${lra.toFixed(1)} LU (> ${LRA_WIDE} LU trigger) -> ${musicLike ? 3 : 2}-band glue, ratio ${ratio.toFixed(2)}`,
    })
  }

  // Reference mode: stereo width match: side-gain toward the reference's own width.
  if (reference && reference.width != null && analysis.width != null) {
    const w = clamp(reference.width / Math.max(analysis.width, 1e-6), 0, 4)
    stages.push({
      atom: '@audio/spatial-midside', name: 'width',
      params: { width: w },
      why: `stereo width ${analysis.width.toFixed(2)} -> reference width ${reference.width.toFixed(2)} (side gain x${w.toFixed(2)})`,
    })
  }

  // 11. gain: toward the loudness target, measured where the stage runs (after the repairs and the EQ, which move
  // both), its true peak held under the ceiling with at most `limit` dB of limiting: 6 dB × intensity (none at 0). The
  // clean tuning takes needed 2.6 dB of limiting to reach their targets (median; 95th percentile speech 6.9, music
  // 5.3), and it cost little next to the EQ and glue 0.3 put on every take: PESQ 4.64 → 4.60 at 6 dB (4.60 at all they
  // needed), music ODG 0.21 → −0.03 with the true-peak limiter. A take that needs more stops short of the target by the
  // rest; a loud one is turned down. Reference mode reaches the reference's loudness, its limiter taking what it must.
  let ceiling = opts.ceiling ?? -1
  if (reference && reference.truePeakDb != null) ceiling = Math.min(ceiling, reference.truePeakDb)
  const measured = analysis.lufs ?? targetLufs, peak = analysis.truePeakDb ?? -Infinity
  const cap = reference ? Infinity : 6 * intensity
  // the limiter where the gain may take peaks over the ceiling: predicted from the take as it came, and wherever declip
  // rebuilds peaks over its rails or the EQ lifts a band; without it the gain stops at the ceiling
  const lifts = stages.some(s => s.name === 'declip' || s.name === 'eq')
  const limit = cap > 0 && (lifts || clamp(targetLufs - measured, -20, 20) > ceiling - peak) ? cap : 0
  const gainDb = clamp(Math.min(targetLufs - measured, ceiling - peak + limit), -20, 20)
  stages.push({
    atom: 'gain', name: 'gain',
    params: { target: targetLufs, ceiling, limit: limit === Infinity ? 99 : limit },
    why: `loudness ${measured.toFixed(1)} -> ${targetLufs} LUFS, true peak ${peak.toFixed(1)} dBTP under ${ceiling.toFixed(1)}${limit ? `, with ${limit === Infinity ? 'all the' : `at most ${limit.toFixed(1)} dB of`} limiting` : ''}: about ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`,
  })

  // 12. limiter: where the gain may take peaks over the ceiling; true peak (ITU-R BS.1770-4 Annex 2: the waveform
  // between samples held under the ceiling too). Idle under the ceiling: the sound passes as it came.
  if (limit > 0) {
    stages.push({
      atom: '@audio/dynamics-limiter', name: 'limiter',
      params: { ceiling, lookahead: 5, release: 50, truePeak: true },
      why: `true peak ceiling ${ceiling.toFixed(1)} dBTP${reference ? ' (matched to reference true peak)' : `, at most ${limit.toFixed(1)} dB taken (6 dB × intensity ${intensity})`}`,
    })
  }

  return { fs, type, intensity, targetLufs, stages }
}

// ─────────────────────────────────────────────────────────────────────────

// The gain stage's dB on the sound reaching it: toward `target` LUFS, its true peak held under `ceiling` + `limit`
// (a recipe of 0.3 carries a fixed `db`)
function gainDb(out, p, fs) {
  if (p.db != null) return p.db
  const m = lufsFn(out, { fs }), tp = truepeakFn(out, { fs })
  if (!Number.isFinite(m)) return 0
  return clamp(Math.min(p.target - m, p.ceiling - (Number.isFinite(tp) ? tp : -Infinity) + p.limit), -20, 20)
}

function runStage(stage, out, fs) {
  const p = stage.params
  switch (stage.name) {
    case 'hpf':
      for (let c = 0; c < out.length; c++) out[c] = highpass(out[c], { fc: p.fc, order: p.order, Q: p.Q, fs })
      break
    case 'dehum':
      for (let c = 0; c < out.length; c++) out[c] = dehum(out[c], { ...p, fs })
      break
    case 'declip':
      for (let c = 0; c < out.length; c++) out[c] = declip(out[c], { ...p, fs })
      break
    case 'deplosive':
      for (let c = 0; c < out.length; c++) deplosive(out[c], { ...p, fs })
      break
    case 'denoise':
      if (stage.atom === NEURAL) throw new Error(`@audio/chain: apply() can't run the denoise stage, ${NEURAL}'s ${p.model}: it runs asynchronously. Apply the stages before it, await its denoise(), apply the rest, as code() writes it (audio's auto() runs it so)`)
      for (let c = 0; c < out.length; c++) out[c] = omlsa(out[c], { fs, gMin: p.gMin })
      break
    case 'dereverb':
      for (let c = 0; c < out.length; c++) out[c] = dereverb(out[c], { ...p, fs })
      break
    case 'declick':
      for (let c = 0; c < out.length; c++) out[c] = declick(out[c], { ...p, fs })
      break
    case 'deesser':
      for (let c = 0; c < out.length; c++) out[c] = deesser(out[c], { ...p, sampleRate: fs })
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
      const g = 10 ** (gainDb(out, p, fs) / 20)
      for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= g
      break
    }
    case 'limiter':
      for (let c = 0; c < out.length; c++) out[c] = limiter(out[c], { sampleRate: fs, ceiling: p.ceiling, lookahead: p.lookahead, release: p.release, truePeak: p.truePeak })
      break
    default:
      throw new Error(`@audio/chain: apply() — unknown stage "${stage.name}"`)
  }
}

export function apply(channels, recipe, { fs = 44100 } = {}) {
  channels = toChannels(channels)
  const out = channels.map(ch => Float32Array.from(ch))

  // the loudness the gain stage gave (the target, or short of it where its limit stopped it)
  let aimed = recipe.targetLufs
  for (const stage of recipe.stages) {
    runStage(stage, out, fs)
    if (stage.name === 'gain') { const m = lufsFn(out, { fs }); if (Number.isFinite(m)) aimed = Math.min(recipe.targetLufs, m) }
  }

  // Single refinement pass: re-measure once after the limiter, trim <= +-2 dB back to the
  // loudness the gain gave (what the limiter's peaks took from it), then re-limit (a trim
  // can otherwise punch a new true-peak overshoot through the ceiling the limiter just enforced).
  const limiterStage = recipe.stages.find(s => s.name === 'limiter')
  if (limiterStage) {
    const measured = lufsFn(out, { fs })
    if (measured != null && isFinite(measured)) {
      const trim = clamp(aimed - measured, -2, 2)
      if (Math.abs(trim) > 0.01) {
        const g = 10 ** (trim / 20)
        for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= g
        for (let c = 0; c < out.length; c++)
          out[c] = limiter(out[c], {
            sampleRate: fs,
            ceiling: limiterStage.params.ceiling,
            lookahead: limiterStage.params.lookahead,
            release: limiterStage.params.release,
            truePeak: limiterStage.params.truePeak,
          })
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────

export default function chain(channels, opts = {}) {
  const fs = opts.fs ?? 44100
  const analysis = analyze(channels, { fs, type: opts.type })
  const recipe = plan(analysis, opts)
  const outChannels = apply(channels, recipe, { fs })
  return { channels: outChannels, recipe, analysis }
}

// ─────────────────────────────────────────────────────────────────────────

// Exports the recipe as copy-paste runnable ESM: imports of each stage's atom, then the
// stages applied in order with the exact params the recipe carries (including embedded
// derived data — the EQ correction curve), then apply()'s refinement pass: the script
// renders what apply() renders, bit for bit, without re-analyzing anything. A neural
// denoise stage is awaited (an ES module's top-level await), as its executor runs it.
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
        bodyLines.push(`for (const ch of channels) dehum(ch, ${JSON.stringify({ ...p, fs })})`)
        break
      case 'declip':
        addImport(`import declip from '@audio/denoise-declip'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = declip(ch, ${JSON.stringify({ ...p, fs })}) })`)
        break
      case 'deplosive':
        addImport(`import deplosive from '@audio/denoise-deplosive'`)
        bodyLines.push(`for (const ch of channels) deplosive(ch, ${JSON.stringify({ ...p, fs })})`)
        break
      case 'dereverb':
        addImport(`import dereverb from '@audio/denoise-dereverb'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = dereverb(ch, ${JSON.stringify({ ...p, fs })}) })`)
        break
      case 'denoise':
        if (stage.atom === NEURAL) {
          addImport(`import denoise from '${NEURAL}'`)
          bodyLines.push(`for (let i = 0; i < channels.length; i++) channels[i] = await denoise(channels[i], ${JSON.stringify({ sampleRate: fs, ...p })})`)
          break
        }
        addImport(`import omlsa from '@audio/denoise-omlsa'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = omlsa(ch, { fs: ${fs}, gMin: ${p.gMin} }) })`)
        break
      case 'declick':
        addImport(`import declick from '@audio/denoise-declick'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = declick(ch, ${JSON.stringify({ ...p, fs })}) })`)
        break
      case 'deesser':
        addImport(`import deesser from '@audio/dynamics-deesser'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = deesser(ch, ${JSON.stringify({ ...p, sampleRate: fs })}) })`)
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
        addImport(`import lufs from '@audio/loudness-lufs'`)
        addImport(`import truepeak from '@audio/loudness-truepeak'`)
        bodyLines.push(p.db != null ? `{ const g = 10 ** (${p.db} / 20); for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g }\nconst aimed = Math.min(${recipe.targetLufs}, lufs(channels, { fs }))` : [
          `{`,
          `  const m = lufs(channels, { fs }), tp = truepeak(channels, { fs })`,
          `  const db = Number.isFinite(m) ? Math.max(-20, Math.min(20, Math.min(${p.target} - m, ${p.ceiling} - (Number.isFinite(tp) ? tp : -Infinity) + ${p.limit}))) : 0`,
          `  const g = 10 ** (db / 20)`,
          `  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g`,
          `}`,
          `const aimed = Math.min(${recipe.targetLufs}, lufs(channels, { fs }))`,
        ].join('\n'))
        break
      case 'limiter':
        addImport(`import limiter from '@audio/dynamics-limiter'`)
        bodyLines.push(`channels.forEach((ch, i) => { channels[i] = limiter(ch, ${JSON.stringify({ sampleRate: fs, ceiling: p.ceiling, lookahead: p.lookahead, release: p.release, truePeak: p.truePeak })}) })`)
        break
    }
    bodyLines.push('')
  }

  // apply()'s refinement pass: loudness re-measured once, a <= ±2 dB trim, the limiter again
  const lim = recipe.stages.find(s => s.name === 'limiter')
  if (lim) {
    addImport(`import lufs from '@audio/loudness-lufs'`)
    bodyLines.push(`// trim: loudness re-measured, trimmed <= ±2 dB back to what the gain gave, re-limited (apply()'s refinement pass)`)
    bodyLines.push([
      `{`,
      `  const m = lufs(channels, { fs }), trim = Math.max(-2, Math.min(2, (Number.isFinite(aimed) ? aimed : ${recipe.targetLufs}) - m))`,
      `  if (Number.isFinite(m) && Math.abs(trim) > 0.01) {`,
      `    const g = 10 ** (trim / 20)`,
      `    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g`,
      `    channels.forEach((ch, i) => { channels[i] = limiter(ch, ${JSON.stringify({ sampleRate: fs, ceiling: lim.params.ceiling, lookahead: lim.params.lookahead, release: lim.params.release, truePeak: lim.params.truePeak })}) })`,
      `  }`,
      `}`,
    ].join('\n'))
  }

  return `// audiojs recipe — generated by @audio/chain
// type: ${recipe.type} · intensity: ${recipe.intensity} · targetLufs: ${recipe.targetLufs}

${importLines.join('\n')}

const fs = ${fs}
// channels: Float32Array[] — mutated stage by stage, mirroring apply()

${bodyLines.join('\n')}`
}
