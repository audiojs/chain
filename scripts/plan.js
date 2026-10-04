// Which corrective stages plan() puts in, on labelled material. Run: `node scripts/plan.js [tune|test] [path to a
// chain.js]` (minutes; an earlier chain.js where its imports resolve, e.g. 0.1.1's, `git show 3ad399b:chain.js`, in
// a folder holding its package.json's node_modules). Prints the README's table: per class of material, the share of
// takes whose recipe holds dehum, denoise, declick, deesser, and the share with none of the first three (nothing
// repaired).
//
// Material, from ~/.cache/audiojs/data (never committed); each set is skipped where missing:
//   speech  VoiceBank+DEMAND (Valentini-Botinhao 2017, CC BY 4.0), every 6th utterance: tune, the 28-speaker training
//           subset; test, the test set. Clean, and its noisy twin (DEMAND noises, 0–15 dB in training, 2.5–17.5 dB in
//           the test set). Every 3rd clean take under white or pink noise at 10 and 20 dB re its active level.
//   narration  Spoken Wikipedia (CC BY-SA), 15 s at 10 s and at 40 s of each: spoken-train/ (tune) or spoken/ (test).
//   music   tune: repair/*.f32 excerpts ("Vibe Ace", Brahms, the Nutcracker, a trumpet; @audio/denoise's
//           scripts/repair.js) and VocalSet singers m1 f2 m2 f1 (Wilkins et al. 2018, CC BY 4.0); test: Slakh2100 odd
//           mixes (Manilow et al. 2019, CC BY 4.0, 10 s at 30 s) and singers f3 f4 m3 m4. Every 2nd piece under white
//           noise at 10 and 20 dB.
//   +hum, +clicks  every 6th clean take and every 3rd piece: mains hum 20 dB under (12 harmonics at −6 dB/oct, 0.05 Hz
//           off 50 or 60), clicks one every 0.25–0.45 s at 5× the RMS around (ticks and pops, as @audio/denoise's
//           scripts/declick.js makes them).
// Speech and narrations are planned as `type: 'speech'`, music as `'music'` (no deesser).

import { readFileSync, readdirSync, existsSync } from 'fs'
import { homedir } from 'os'

const set = process.argv[2] || 'tune', T = set === 'test'
const { analyze, plan } = await import(process.argv[3] ? new URL(process.argv[3], `file://${process.cwd()}/`) : '../chain.js')
const H = `${homedir()}/.cache/audiojs/data`
const lcg = seed => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 }
const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r())
const pw = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return s / Math.max(1, b - a) }
const ls = (d, ext = '.wav') => existsSync(d) ? readdirSync(d).filter(f => f.endsWith(ext)).sort() : []
const f32 = p => { let b = readFileSync(p); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
function wav(path) {
  let b = readFileSync(path), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), o = 12, fs = 0, ch = 1, bits = 16
  while (o < b.length) {
    let id = b.toString('ascii', o, o + 4), sz = dv.getUint32(o + 4, true)
    if (id === 'fmt ') { ch = dv.getUint16(o + 10, true); fs = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true) }
    if (id === 'data') {
      let n = Math.floor(sz / (bits / 8) / ch), x = new Float32Array(n)
      for (let i = 0; i < n; i++) x[i] = bits === 16 ? dv.getInt16(o + 8 + i * 2 * ch, true) / 32768 : dv.getFloat32(o + 8 + i * 4 * ch, true)
      return { x, fs }
    }
    o += 8 + sz + (sz & 1)
  }
}
// active level: 20 ms frames within 40 dB of the loudest
const asl = (s, fs) => { let L = Math.round(0.02 * fs), p = []; for (let i = 0; i + L <= s.length; i += L) p.push(pw(s, i, i + L)); let mx = Math.max(...p), a = p.filter(v => v > mx * 1e-4); return a.reduce((x, y) => x + y, 0) / a.length }
const mix = (s, n, fs, snr) => { let g = Math.sqrt(asl(s, fs) / pw(n) / 10 ** (snr / 10)); return s.map((v, i) => v + g * n[i]) }

// ---- defects
const white = (n, seed) => { let r = lcg(seed); return Float32Array.from({ length: n }, () => gauss(r)) }
function pink(n, seed) {   // Kellet's filter
  let w = white(n, seed), b = [0, 0, 0, 0, 0, 0, 0]
  return w.map(v => {
    b[0] = 0.99886 * b[0] + v * 0.0555179; b[1] = 0.99332 * b[1] + v * 0.0750759; b[2] = 0.969 * b[2] + v * 0.153852
    b[3] = 0.8665 * b[3] + v * 0.3104856; b[4] = 0.55 * b[4] + v * 0.5329522; b[5] = -0.7616 * b[5] - v * 0.016898
    let y = 0.11 * (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + v * 0.5362); b[6] = v * 0.115926; return y
  })
}
const hum = (n, fs, f0) => { let x = new Float32Array(n); for (let h = 1; h <= 12; h++) for (let i = 0; i < n; i++) x[i] += Math.sin(2 * Math.PI * h * (f0 + 0.05) * i / fs + h) / h; return x }
const kinds = {
  tick: (r, fs) => { let f = 2000 + r() * 6000, t = (0.05 + r() * 0.25) * fs / 1000; return Array.from({ length: Math.ceil(5 * t) }, (_, n) => Math.exp(-n / t) * Math.cos(2 * Math.PI * f * n / fs)) },
  pop: (r, fs) => { let f = 300 + r() * 1200, t = (0.3 + r() * 0.7) * fs / 1000; return Array.from({ length: Math.ceil(5 * t) }, (_, n) => Math.exp(-n / t) * Math.sin(2 * Math.PI * f * n / fs + 0.3)) }
}
function clicked(clean, fs, kind, seed) {
  let r = lcg(seed), x = clean.slice()
  for (let at = Math.round(0.3 * fs); at < clean.length - 0.3 * fs; at += Math.round(fs * (0.25 + r() * 0.2))) {
    let level = Math.max(1e-3, Math.sqrt(pw(clean, at - fs / 100, at + fs / 100))), h = kinds[kind](r, fs), pk = Math.max(...h.map(Math.abs)), sign = r() < 0.5 ? -1 : 1
    for (let j = 0; j < h.length; j++) x[at + j] += sign * 5 * level * h[j] / pk
  }
  return x
}

// ---- material: { x, fs, cls, type }
function* material() {
  let vb = T ? `${H}/vbdemand/clean_testset_wav` : `${H}/vbdemand-train/clean`, vn = T ? `${H}/vbdemand/noisy_testset_wav` : `${H}/vbdemand-train/noisy`
  let speech = ls(vb).filter((_, i) => i % 6 === 0).map(f => ({ name: f, ...wav(`${vb}/${f}`) }))
  for (let s of speech) {
    yield { ...s, cls: 'speech', type: 'speech' }
    if (existsSync(`${vn}/${s.name}`)) yield { ...wav(`${vn}/${s.name}`), cls: 'speech, VoiceBank+DEMAND noisy', type: 'speech' }
  }
  for (let [j, s] of speech.filter((_, i) => i % 3 === 0).entries())
    for (let [k, gen] of [['white', white], ['pink', pink]]) for (let snr of [10, 20])
      yield { fs: s.fs, x: mix(s.x, gen(s.x.length, 100 + j), s.fs, snr), cls: `speech + ${k} noise`, type: 'speech' }
  let sp = `${H}/${T ? 'spoken' : 'spoken-train'}`
  for (let f of ls(sp, '.f32')) { let x = f32(`${sp}/${f}`); for (let a of [10, 40]) if (x.length >= (a + 15) * 48000) yield { x: x.subarray(a * 48000, (a + 15) * 48000), fs: 48000, cls: 'narration', type: 'speech' } }
  let music = []
  if (!T) for (let [n, a, b] of [['vibeace', 5, 15], ['vibeace', 40, 50], ['brahms', 5, 15], ['nutcracker', 5, 15], ['nutcracker', 60, 70], ['trumpet', 0, 6]])
    if (existsSync(`${H}/repair/${n}.f32`)) music.push({ x: f32(`${H}/repair/${n}.f32`).subarray(a * 44100, b * 44100), fs: 44100 })
  if (T) for (let f of ls(`${H}/slakh/mix44`).filter((_, i) => i % 2 === 1)) { let w = wav(`${H}/slakh/mix44/${f}`); music.push({ x: w.x.subarray(30 * w.fs, 40 * w.fs), fs: w.fs }) }
  for (let s of T ? ['female3', 'female4', 'male3', 'male4'] : ['male1', 'female2', 'male2', 'female1'])
    for (let sub of ['excerpts/vibrato', 'excerpts/straight', 'long_tones/forte', 'arpeggios/slow_piano', 'scales/belt']) {
      let d = `${H}/vocalset/FULL/${s}/${sub}`, f = ls(d)[0]
      if (f) { let w = wav(`${d}/${f}`); music.push({ x: w.x.subarray(0, 12 * w.fs), fs: w.fs }) }
    }
  music = music.filter(m => m.x.length >= m.fs)
  for (let m of music) yield { ...m, cls: 'music', type: 'music' }
  for (let [j, m] of music.filter((_, i) => i % 2 === 0).entries()) for (let snr of [10, 20])
    yield { fs: m.fs, x: mix(m.x, white(m.x.length, 300 + j), m.fs, snr), cls: 'music + white noise', type: 'music' }
  let some = [...speech.filter((_, i) => i % 6 === 1).map(s => ({ ...s, k: 'speech' })), ...music.filter((_, i) => i % 3 === 1).map(m => ({ ...m, k: 'music' }))]
  for (let [j, s] of some.entries()) {
    yield { fs: s.fs, x: mix(s.x, hum(s.x.length, s.fs, j % 2 ? 60 : 50), s.fs, 20), cls: `${s.k} + hum`, type: s.k }
    for (let k of ['tick', 'pop']) yield { fs: s.fs, x: clicked(s.x, s.fs, k, 7 + j + k.length), cls: `${s.k} + clicks`, type: s.k }
  }
}

// ---- plan, tally
const stages = ['dehum', 'denoise', 'declick', 'deesser'], repair = ['dehum', 'denoise', 'declick']
let rows = new Map()
for (let it of material()) {
  let names = plan(analyze([it.x], { fs: it.fs }), { type: it.type }).stages.map(s => s.name)
  let r = rows.get(it.cls) ?? { n: 0, none: 0 }
  r.n++
  for (let s of stages) if (names.includes(s)) r[s] = (r[s] || 0) + 1
  if (!repair.some(s => names.includes(s))) r.none++
  rows.set(it.cls, r)
}
const pc = (k, n) => k ? `${Math.round(100 * k / n)}%` : '·'
console.log(`\n${set}: stages plan() puts in, share of takes\n\n| material | n | ${stages.join(' | ')} | nothing repaired |\n|---|---:|${stages.map(() => '---:|').join('')}---:|`)
for (let [k, r] of rows) console.log(`| ${k} | ${r.n} | ${stages.map(s => pc(r[s], r.n)).join(' | ')} | ${pc(r.none, r.n)} |`)
