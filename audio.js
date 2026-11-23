// atom manifest — Auto-Chain's two host-facing surfaces per @audio/plugin CONTRACT.
//   auto  — whole-render one-knob enhance: analyze -> plan -> apply inside one process
//           call (streaming: false — this is the open "God Particle": adaptive by
//           measurement, not a fixed preset. See README for the per-stage inclusion
//           rules `plan()` applies underneath it).
//   chain — stat atom: analyze -> plan only, returns the recipe without touching the
//           audio. Mix Analyser's report feed and any "show me the chain before you
//           render" UI read this.
// And what a host that runs the recipe itself needs (audio's auto(): its neural denoise stage, which apply() can't
// run, between apply()'s parts): the functions, and plan()'s options from these params.
import chainFn, { analyze, plan } from './chain.js'
import { latency as deplosiveLatency } from '@audio/denoise-deplosive'
export { analyze, plan, apply, code } from './chain.js'

// plan()'s options from the params as a host hands them (a number as its 1-length array, or the number): targetLufs 0,
// the sentinel (see params.targetLufs below), is no override
export function options(params) {
  const at = v => ArrayBuffer.isView(v) ? v[0] : v, targetLufs = at(params.targetLufs)
  return { type: params.type, intensity: at(params.intensity), targetLufs: targetLufs === 0 ? undefined : targetLufs, ceiling: at(params.ceiling) }
}

export const auto = (ctx) => {
  return (inputs, outputs, params) => {
    const inp = inputs[0], out = outputs[0]
    if (!inp || !inp.length) return
    const channels = []
    for (let c = 0; c < inp.length; c++) channels.push(Float32Array.from(inp[c]))
    const { channels: outChannels } = chainFn(channels, { fs: ctx.sampleRate, ...options(params) })
    for (let c = 0; c < inp.length && c < outChannels.length; c++) out[c].set(outChannels[c])
  }
}
auto.channels = 'any'
auto.streaming = false
// Seconds the output takes to fall 60 dB once the input stops, for any recipe the type can plan (plan() reads the take,
// which a tail cannot see): the stages that ring, in series, their decays added. The high-pass, always, 20 Hz where
// music may be and 40 for speech: an RBJ 2nd-order section, its poles of radius r = √a2, a2 = (1 − α)/(1 + α),
// α = sin ω0 / 2Q, fall 60 dB in ln(1000)/−ln r samples (J. O. Smith: the time constant τ = −1/ln r samples,
// "Introduction to Digital Filters", Time Constant of One Pole; t60 = ln(1000)·τ, "Mathematics of the DFT", Audio
// Decay Time). Multiband's lowest crossover, 200 Hz where music may be and 1 kHz for speech: LR4 is that pole twice,
// whose envelope n·rⁿ falls 60 dB at −n·ln r ≈ 10.24. Where speech may be, the deesser's linear-phase split, ±1.5 ms;
// for speech, the EQ's 511-tap linear-phase FIR (255 samples) and deplosive's linear-phase low band (its latency). The
// repairs and the denoisers ring on nothing past the take (measured: 0). Left out: dehum, which on a take with hum
// writes the hum, inverted, into silence that follows it, a second and more (dehum's defect, not a decay to keep)
const poleDecay = (fc, Q, fs) => { const a = Math.sin(2 * Math.PI * fc / fs) / (2 * Q); return -0.5 * Math.log((1 - a) / (1 + a)) }
auto.tail = ({ sampleRate: fs, params }) => {
  const music = params.type !== 'speech'
  let n = Math.log(1000) / poleDecay(music ? 20 : 40, 0.707, fs) + 10.24 / poleDecay(music ? 200 : 1000, Math.SQRT1_2, fs)
  if (params.type !== 'music') n += 0.0015 * fs
  if (params.type === 'speech') n += 255 + deplosiveLatency(fs)
  return n / fs
}
auto.params = {
  type: { type: 'enum', values: ['speech', 'music', 'voice-music'], default: 'speech' },
  intensity: { type: 'number', min: 0, max: 2, default: 1 },
  // 0 is a sentinel for "no override: use the content-type default" (speech/voice-music
  // -16 LUFS, music -14 LUFS): the param system has no null, and 0 LUFS is never a
  // sensible target. The range holds it: a host clamps a default into the declared range, and
  // 0.3's -30..-6 turned it into -6 LUFS (audio's auto() pushed every take 10 dB into the limiter).
  targetLufs: { type: 'number', min: -30, max: 0, default: 0, unit: 'LUFS' },
  ceiling: { type: 'number', min: -6, max: 0, default: -1, unit: 'dB' },
}

export const chain = {
  stat: 'chain',
  compute: (channels, { sampleRate, ...opts }) => plan(analyze(channels, { fs: sampleRate, type: opts.type }), opts),
}
