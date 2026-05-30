// mastering.js - Mastering chain and presets

const MASTERING_PRESETS = {
  pop: {
    eq: { low: 1, lowMid: -1, mid: 1, highMid: 0, high: 2 },
    comp: { threshold: -18, ratio: 3, attack: 0.003, release: 0.25 },
    limiter: { ceiling: -0.3, gain: 1.5 },
    stereoWidth: 1.2,
  },
  rock: {
    eq: { low: 3, lowMid: -2, mid: 2, highMid: 1, high: 1 },
    comp: { threshold: -20, ratio: 4, attack: 0.005, release: 0.2 },
    limiter: { ceiling: -0.3, gain: 2 },
    stereoWidth: 1.1,
  },
  hiphop: {
    eq: { low: 4, lowMid: -1, mid: 0, highMid: -1, high: 1 },
    comp: { threshold: -22, ratio: 5, attack: 0.003, release: 0.15 },
    limiter: { ceiling: -0.3, gain: 2.5 },
    stereoWidth: 1.0,
  },
  edm: {
    eq: { low: 3, lowMid: -2, mid: 0, highMid: 1, high: 3 },
    comp: { threshold: -16, ratio: 3, attack: 0.002, release: 0.1 },
    limiter: { ceiling: -0.1, gain: 3 },
    stereoWidth: 1.4,
  },
  jazz: {
    eq: { low: 0, lowMid: 0, mid: 1, highMid: 1, high: 0 },
    comp: { threshold: -24, ratio: 2, attack: 0.02, release: 0.4 },
    limiter: { ceiling: -1, gain: 0 },
    stereoWidth: 1.0,
  },
  classical: {
    eq: { low: 0, lowMid: 0, mid: 0, highMid: 1, high: 1 },
    comp: { threshold: -30, ratio: 1.5, attack: 0.05, release: 0.8 },
    limiter: { ceiling: -1, gain: 0 },
    stereoWidth: 1.1,
  },
  podcast: {
    eq: { low: -3, lowMid: 1, mid: 3, highMid: 1, high: -1 },
    comp: { threshold: -18, ratio: 4, attack: 0.005, release: 0.1 },
    limiter: { ceiling: -1, gain: 2 },
    stereoWidth: 0.8,
  },
  loud: {
    eq: { low: 2, lowMid: -1, mid: 1, highMid: 0, high: 2 },
    comp: { threshold: -12, ratio: 8, attack: 0.001, release: 0.05 },
    limiter: { ceiling: -0.1, gain: 4 },
    stereoWidth: 1.2,
  },
};

class MasteringChain {
  constructor(ctx) {
    this.ctx = ctx;
    this.nodes = this._createNodes();
    this.state = {
      eq: { low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
      comp: { threshold: -24, ratio: 3, attack: 0.003, release: 0.25 },
      limiter: { ceiling: -0.3, gain: 0 },
      stereoWidth: 1.0,
      sunoCleanup: false,
    };
  }

  _createNodes() {
    const ctx = this.ctx;
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 80;

    const eqLowMid = ctx.createBiquadFilter();
    eqLowMid.type = 'peaking'; eqLowMid.frequency.value = 300; eqLowMid.Q.value = 1;

    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1;

    const eqHighMid = ctx.createBiquadFilter();
    eqHighMid.type = 'peaking'; eqHighMid.frequency.value = 4000; eqHighMid.Q.value = 1;

    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 10000;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 8;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -0.3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    // Chain: eqLow → eqLowMid → eqMid → eqHighMid → eqHigh → comp → limiter → masterGain → analyser
    eqLow.connect(eqLowMid);
    eqLowMid.connect(eqMid);
    eqMid.connect(eqHighMid);
    eqHighMid.connect(eqHigh);
    eqHigh.connect(comp);
    comp.connect(limiter);
    limiter.connect(masterGain);
    masterGain.connect(analyser);

    return { eqLow, eqLowMid, eqMid, eqHighMid, eqHigh, comp, limiter, masterGain, analyser };
  }

  get input() { return this.nodes.eqLow; }
  get output() { return this.nodes.analyser; }

  applyPreset(name) {
    const p = MASTERING_PRESETS[name];
    if (!p) return;
    this.setEQ(p.eq);
    this.setCompressor(p.comp);
    this.setLimiter(p.limiter);
    this.setStereoWidth(p.stereoWidth);
  }

  setEQ({ low, lowMid, mid, highMid, high }) {
    const n = this.nodes;
    const t = 0.01;
    n.eqLow.gain.setTargetAtTime(low ?? 0, 0, t);
    n.eqLowMid.gain.setTargetAtTime(lowMid ?? 0, 0, t);
    n.eqMid.gain.setTargetAtTime(mid ?? 0, 0, t);
    n.eqHighMid.gain.setTargetAtTime(highMid ?? 0, 0, t);
    n.eqHigh.gain.setTargetAtTime(high ?? 0, 0, t);
    Object.assign(this.state.eq, { low, lowMid, mid, highMid, high });
  }

  setCompressor({ threshold, ratio, attack, release }) {
    const c = this.nodes.comp;
    const t = 0.01;
    c.threshold.setTargetAtTime(threshold ?? -24, 0, t);
    c.ratio.setTargetAtTime(ratio ?? 3, 0, t);
    c.attack.setTargetAtTime(attack ?? 0.003, 0, t);
    c.release.setTargetAtTime(release ?? 0.25, 0, t);
    Object.assign(this.state.comp, { threshold, ratio, attack, release });
  }

  setLimiter({ ceiling, gain }) {
    const l = this.nodes.limiter;
    const g = this.nodes.masterGain;
    l.threshold.setTargetAtTime(ceiling ?? -0.3, 0, 0.01);
    g.gain.setTargetAtTime(Math.pow(10, (gain ?? 0) / 20), 0, 0.01);
    Object.assign(this.state.limiter, { ceiling, gain });
  }

  setStereoWidth(width) {
    this.state.stereoWidth = width;
    // Stereo width is applied during offline render via mid-side processing
  }

  serialize() { return { ...this.state }; }

  restore(state) {
    if (!state) return;
    if (state.eq) this.setEQ(state.eq);
    if (state.comp) this.setCompressor(state.comp);
    if (state.limiter) this.setLimiter(state.limiter);
    if (state.stereoWidth != null) this.setStereoWidth(state.stereoWidth);
    this.state.sunoCleanup = state.sunoCleanup ?? false;
  }
}

window.SF2Mastering = { MasteringChain, MASTERING_PRESETS };
