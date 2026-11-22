/** Sound: produced samples for effects and ambience, plus a synthesised whistle and exhaust beat. Starts only after a user gesture. */
const FILES = {
  click: '/assets/audio/click.ogg', coin: '/assets/audio/coin.ogg', explosion: '/assets/audio/explosion.ogg', thud: '/assets/audio/thud.ogg',
  hit: '/assets/audio/hit.ogg', whoosh: '/assets/audio/whoosh.ogg', wind: '/assets/audio/ambience_wind.ogg', forest: '/assets/audio/ambience_forest.ogg',
  music: '/assets/audio/music.ogg',
} as const;
type Name = keyof typeof FILES;

class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Name, AudioBuffer>();
  private loops: AudioBufferSourceNode[] = [];
  private musicGain: GainNode | null = null;
  enabled = true; music = true;
  private chuffAt = 0;

  /** Call from a click/tap handler. */
  async unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = this.enabled ? 0.8 : 0; this.master.connect(this.ctx.destination);
    await Promise.all((Object.keys(FILES) as Name[]).map(async (n) => {
      try { const r = await fetch(FILES[n]); this.buffers.set(n, await this.ctx!.decodeAudioData(await r.arrayBuffer())); } catch { /* a missing sound is not fatal */ }
    }));
    this.startLoops();
  }
  private startLoops() {
    if (!this.ctx || !this.master || this.loops.length) return;
    const loop = (n: Name, vol: number) => {
      const b = this.buffers.get(n); if (!b) return null;
      const src = this.ctx!.createBufferSource(); src.buffer = b; src.loop = true;
      const g = this.ctx!.createGain(); g.gain.value = vol; src.connect(g).connect(this.master!); src.start(); this.loops.push(src);
      return g;
    };
    loop('wind', 0.16); loop('forest', 0.2);
    this.musicGain = loop('music', this.music ? 0.22 : 0);
  }
  setEnabled(on: boolean) { this.enabled = on; if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05); }
  setMusic(on: boolean) { this.music = on; if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(on ? 0.22 : 0, this.ctx.currentTime, 0.3); }

  play(n: Name, vol = 0.6, rate = 1) {
    const b = this.buffers.get(n);
    if (!b || !this.ctx || !this.master || !this.enabled) return;
    const src = this.ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = vol; src.connect(g).connect(this.master); src.start();
  }
  /** A two-chime steam whistle. */
  whistle(vol = 0.2) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    for (const [f, d] of [[620, 0], [744, 0], [932, 0.02]] as Array<[number, number]>) {
      const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(f * 0.94, t + d); o.frequency.linearRampToValueAtTime(f, t + d + 0.12);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(vol / 3, t + d + 0.06); g.gain.setValueAtTime(vol / 3, t + d + 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.95);
      o.connect(g).connect(this.master); o.start(t + d); o.stop(t + d + 1);
    }
  }
  /** One beat of exhaust; call every frame with the engine's speed and how near the camera is (0..1). */
  chuff(now: number, speed: number, near: number) {
    if (!this.ctx || !this.master || !this.enabled || speed < 1 || near <= 0.02) return;
    const interval = Math.max(0.11, 0.42 - speed * 0.006);
    if (now - this.chuffAt < interval) return;
    this.chuffAt = now;
    const t = this.ctx.currentTime, len = 0.09;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * len), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 0.7;
    const g = this.ctx.createGain(); g.gain.value = 0.22 * near;
    src.connect(f).connect(g).connect(this.master); src.start(t);
  }
}
export const audio = new Audio();
