// Generated from the audio.js manifest (params metadata is the source of truth).
// Regenerate: node tools/dts.js in @audio/plugin. Do not edit by hand.
//
// Hand-written, not tool-generated: @audio/plugin's tools/dts.js writes a manifest's processors and
// stats, not the functions and the recipe's types below them, and leaves this file as it is. Content
// matches the tool's own output format otherwise.

/** Automatable number — scalar, `t => value` fn, or breakpoint curve {t, v} */
type Auto = number | ((t: number) => number) | { t: number[], v: number[] }
/** Per-block param values as delivered by hosts (numbers arrive as 1-length Float32Array) */
type Live = Record<string, Float32Array | string | boolean>
type Transport = Readonly<{ playing: boolean, bpm: number, beat: number, barStart: number, timeSig: [number, number] }>
/** What a host hands a processor it builds: the contract's Context (CONTRACT.d.ts, 1.0) */
type Ctx = { readonly sampleRate: number, readonly maxBlockSize: number, readonly maxChannels: number, readonly layouts?: { readonly inputs: readonly (string | undefined)[], readonly outputs: readonly (string | undefined)[] }, readonly params: Live, readonly buffers: Readonly<Record<string, Float32Array[] | undefined>>, readonly events?: readonly { time: number, kind: 'on' | 'off', midi: number, velocity: number, id: number }[], emit(name: string, value: number): void, readonly transport: Transport }
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
  tail: (at: { sampleRate: number, params: Live, buffers?: {}, transport: Transport }) => number
  params: {
    /** default "speech" */
    "type": { type: "enum", values: ["speech","music","voice-music"], default: "speech" }
    /** 0..2 (default 1) */
    "intensity": { type: "number", min: 0, max: 2, default: 1 }
    /** -30..0 LUFS (default 0: the type's own) */
    "targetLufs": { type: "number", min: -30, max: 0, default: 0, unit: "LUFS" }
    /** -6..0 dB (default -1) */
    "ceiling": { type: "number", min: -6, max: 0, default: -1, unit: "dB" }
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
