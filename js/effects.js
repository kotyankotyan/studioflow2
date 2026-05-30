// effects.js - Effect processing (EQ, reverb, compressor, etc.)

function createImpulseResponse(ctx, duration = 2, decay = 2) {
  const sr = ctx.sampleRate;
  const len = sr * duration;
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function applyEQPreset(track, preset) {
  const presets = {
    pop:   { low: 2, mid: 1, high: 3 },
    rock:  { low: 4, mid: -1, high: 2 },
    hiphop:{ low: 5, mid: 0, high: 1 },
    edm:   { low: 4, mid: -2, high: 4 },
    chill: { low: 1, mid: 0, high: 1 },
    vocal: { low: -2, mid: 3, high: 2 },
    bass:  { low: 6, mid: -1, high: -1 },
    karaoke:{ low: 0, mid: -10, high: 0 },
  };
  const p = presets[preset];
  if (!p || !track.nodes) return;
  track.nodes.eqLow.gain.setTargetAtTime(p.low, 0, 0.01);
  track.nodes.eqMid.gain.setTargetAtTime(p.mid, 0, 0.01);
  track.nodes.eqHigh.gain.setTargetAtTime(p.high, 0, 0.01);
}

function applySunoCleanupEQ(masterEQ) {
  // Cuts muddy low-mids and harshness typical of Suno AI output
  if (!masterEQ) return;
  masterEQ.low.gain.setTargetAtTime(1, 0, 0.01);
  masterEQ.lowMid.gain.setTargetAtTime(-3, 0, 0.01);
  masterEQ.mid.gain.setTargetAtTime(-1, 0, 0.01);
  masterEQ.highMid.gain.setTargetAtTime(-2, 0, 0.01);
  masterEQ.high.gain.setTargetAtTime(1.5, 0, 0.01);
}

// Vocal pitch shifting (simplified: uses playback rate on a buffer source)
function createPitchNode(ctx, semitones) {
  // Returns a config object; actual pitch shift applied via source.detune
  return { detune: semitones * 100 };
}

// Autotune/Vocoder effect (simplified using oscillator modulation)
function applyAutotuneEffect(gainNode, ctx, intensity = 0.5) {
  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 110;
  oscGain.gain.value = intensity * 0.02;
  osc.connect(oscGain);
  oscGain.connect(gainNode);
  osc.start();
  return { osc, oscGain, stop: () => { try { osc.stop(); } catch(e) {} } };
}

// Sweep filter for buildup FX
function createSweepFilter(ctx) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 20000;
  filter.Q.value = 1;
  return filter;
}

function animateSweep(filter, ctx, duration = 2, direction = 'up') {
  const now = ctx.currentTime;
  filter.frequency.cancelScheduledValues(now);
  if (direction === 'up') {
    filter.frequency.setValueAtTime(200, now);
    filter.frequency.exponentialRampToValueAtTime(20000, now + duration);
    filter.Q.setValueAtTime(8, now);
    filter.Q.linearRampToValueAtTime(1, now + duration);
  } else {
    filter.frequency.setValueAtTime(20000, now);
    filter.frequency.exponentialRampToValueAtTime(200, now + duration);
  }
}

// Riser synth for buildup
function createRiserBuffer(ctx, duration = 2, sr = 44100) {
  const len = sr * duration;
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const freq = 80 * Math.pow(2, t / duration * 3);
      const env = i / len;
      data[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.3 +
                (Math.random() * 2 - 1) * env * 0.1;
    }
  }
  return buf;
}

window.SF2Effects = {
  createImpulseResponse,
  applyEQPreset,
  applySunoCleanupEQ,
  createPitchNode,
  applyAutotuneEffect,
  createSweepFilter,
  animateSweep,
  createRiserBuffer,
};
