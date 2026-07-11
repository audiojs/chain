// Generated from the audio.js manifest (params metadata is the source of truth).
// Regenerate: node tools/dts.js in @audio/compile. Do not edit by hand.
//
// Hand-written, not tool-generated: @audio/compile/tools/dts.js only walks monorepo
// `<family>/packages/*` layouts (readdirSync(FAM, fam, 'packages')) — it has no
// root-package mode, and @audio/chain is a root package (mirrors @audio/wam's shape,
// no packages/ dir). Content matches the tool's own output format otherwise.

/** Automatable number — scalar, `t => value` fn, or breakpoint curve {t, v} */
type Auto = number | ((t: number) => number) | { t: number[], v: number[] }
/** Per-block param values as delivered by hosts (numbers arrive as 1-length Float32Array) */
type Live = Record<string, Float32Array | string | boolean>
type Ctx = { sampleRate: number, maxBlockSize: number, maxChannels: number, currentTime: number, duration?: number, events?: readonly any[], emit?: (name: string, ...args: any[]) => void, [k: string]: unknown }
type Process = (inputs: Float32Array[][], outputs: Float32Array[][], params: Live) => void

/** Chainable-host options for 'auto' */
export interface AutoOptions {
  /** default "speech" */
  "type"?: "speech" | "music" | "voice-music"
  /** 0..2 (default 1) */
  "intensity"?: Auto
  /** -30..-6 LUFS (default 0) */
  "targetLufs"?: Auto
  /** -6..0 dB (default -1) */
  "ceiling"?: Auto
  at?: number | string
  duration?: number | string
}

export declare const auto: {
  (ctx: Ctx): Process
  channels: "any"
  streaming: false
  tail: 0
  params: {
    /** default "speech" */
    "type": { type: "enum", values: ["speech","music","voice-music"], default: "speech" }
    /** 0..2 (default 1) */
    "intensity": { type: "number", default: 1 }
    /** -30..-6 LUFS (default 0) */
    "targetLufs": { type: "number", default: 0 }
    /** -6..0 dB (default -1) */
    "ceiling": { type: "number", default: -1 }
  }
}

/** Stat plugin 'chain' — whole-signal analysis, registers as a.stat('chain') */
export declare const chain: {
  stat: 'chain'
  compute(channels: Float32Array[], opts: { sampleRate: number, [k: string]: unknown }): unknown
}
