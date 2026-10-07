// atom manifest — Auto-Chain's two host-facing surfaces per @audio/compile CONTRACT.
//   auto  — whole-render one-knob enhance: analyze -> plan -> apply inside one process
//           call (streaming: false — this is the open "God Particle": adaptive by
//           measurement, not a fixed preset. See README for the per-stage inclusion
//           rules `plan()` applies underneath it).
//   chain — stat atom: analyze -> plan only, returns the recipe without touching the
//           audio. Mix Analyser's report feed and any "show me the chain before you
//           render" UI read this.
import chainFn, { analyze, plan } from './chain.js'

export const auto = (ctx) => {
  return (inputs, outputs, params) => {
    const inp = inputs[0], out = outputs[0]
    if (!inp || !inp.length) return
    const channels = []
    for (let c = 0; c < inp.length; c++) channels.push(Float32Array.from(inp[c]))
    // 0 is a param-system sentinel for "no override" (see params.targetLufs below) —
    // translated to undefined here so plan() falls through to its per-type default.
    const targetLufsRaw = params.targetLufs[0]
    const { channels: outChannels } = chainFn(channels, {
      fs: ctx.sampleRate,
      type: params.type,
      intensity: params.intensity[0],
      targetLufs: targetLufsRaw === 0 ? undefined : targetLufsRaw,
      ceiling: params.ceiling[0],
    })
    for (let c = 0; c < inp.length && c < outChannels.length; c++) out[c].set(outChannels[c])
  }
}
auto.channels = 'any'
auto.streaming = false
auto.tail = 0
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
