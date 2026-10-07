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
  /** -30..0 LUFS (default 0: the type's own, speech -16, music -14) */
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
    /** -30..0 LUFS (default 0: the type's own) */
    "targetLufs": { type: "number", default: 0 }
    /** -6..0 dB (default -1) */
    "ceiling": { type: "number", default: -1 }
  }
}

/** A recipe stage: the atom it runs, its params, the measurement that put it there */
export interface Stage { atom: string, name: string, params: Record<string, unknown>, why: string }
export interface Recipe { fs: number, type: 'speech' | 'music' | 'voice-music', intensity: number, targetLufs: number, stages: Stage[] }
export interface PlanOptions {
  type?: 'speech' | 'music' | 'voice-music'
  intensity?: number
  targetLufs?: number
  ceiling?: number
  reference?: Record<string, unknown>
  /** its caller runs @audio/neural-denoise: a speech bed goes to DeepFilterNet3 (a stage apply() can't run, code() awaits);
   *  `music`: the share the model's guard passed as music where the stage runs (over half: OM-LSA instead) */
  neural?: boolean | { music?: number }
}
/** For a host that runs the recipe itself (chain.js's own) */
export declare function analyze(channels: Float32Array[] | Float32Array, opts?: { fs?: number, type?: PlanOptions['type'] }): Record<string, any>
export declare function plan(analysis: Record<string, any>, opts?: PlanOptions): Recipe
export declare function apply(channels: Float32Array[] | Float32Array, recipe: Recipe, opts?: { fs?: number }): Float32Array[]
export declare function code(recipe: Recipe): string
/** plan()'s options from the params as a host hands them over (a number or its 1-length array): targetLufs 0, the sentinel, none */
export declare function options(params: Record<string, unknown>): PlanOptions

/** Stat plugin 'chain' — whole-signal analysis, registers as a.stat('chain') */
export declare const chain: {
  stat: 'chain'
  compute(channels: Float32Array[], opts: { sampleRate: number, [k: string]: unknown }): unknown
}
