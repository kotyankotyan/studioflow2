// vocal-processor.js - Vocal enhancement and processing

// Mid/Side separation
function midSideSplit(buffer) {
  if (buffer.numberOfChannels < 2) return { mid: buffer, side: null };
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const mid = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: sr });
  const side = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: sr });
  const midData = mid.getChannelData(0);
  const sideData = side.getChannelData(0);
  for (let i = 0; i < len; i++) {
    midData[i] = (L[i] + R[i]) * 0.5;
    sideData[i] = (L[i] - R[i]) * 0.5;
  }
  return { mid, side };
}

// Mid/Side merge back to stereo
function midSideMerge(mid, side, midGain = 1, sideGain = 1) {
  const len = mid.length;
  const sr = mid.sampleRate;
  const result = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: sr });
  const midData = mid.getChannelData(0);
  const sideData = side ? side.getChannelData(0) : new Float32Array(len);
  const L = result.getChannelData(0);
  const R = result.getChannelData(1);
  for (let i = 0; i < len; i++) {
    L[i] = midData[i] * midGain + sideData[i] * sideGain;
    R[i] = midData[i] * midGain - sideData[i] * sideGain;
  }
  return result;
}

// Vocal removal via mid/side (removes center-panned vocals)
function removeVocalMidSide(buffer, removeAmount = 0.8) {
  if (buffer.numberOfChannels < 2) return buffer;
  const { mid, side } = midSideSplit(buffer);
  // Reduce mid (vocals typically center-panned) while keeping side (stereo instruments)
  return midSideMerge(mid, side, 1 - removeAmount, 1);
}

// J-POP compression styles
const JPOP_COMP_STYLES = {
  light:  { threshold: -24, ratio: 2,  attack: 0.01,  release: 0.3,  gain: 1 },
  normal: { threshold: -20, ratio: 3,  attack: 0.005, release: 0.2,  gain: 2 },
  heavy:  { threshold: -16, ratio: 5,  attack: 0.002, release: 0.15, gain: 3 },
};

function applyJPopComp(compressorNode, gainNode, style = 'normal') {
  const s = JPOP_COMP_STYLES[style];
  if (!s) return;
  compressorNode.threshold.setTargetAtTime(s.threshold, 0, 0.01);
  compressorNode.ratio.setTargetAtTime(s.ratio, 0, 0.01);
  compressorNode.attack.setTargetAtTime(s.attack, 0, 0.01);
  compressorNode.release.setTargetAtTime(s.release, 0, 0.01);
  gainNode.gain.setTargetAtTime(Math.pow(10, s.gain / 20), 0, 0.01);
}

// Simple pitch correction (snaps to nearest semitone)
// Returns a gain/detune configuration for use with AudioBufferSourceNode
function autotunePitch(detectedCentOffset, strength = 0.5) {
  // detectedCentOffset: how many cents off from nearest note
  const correctedCents = detectedCentOffset * (1 - strength);
  return -detectedCentOffset + correctedCents; // How much to adjust
}

// Vocoder-style effect via oscillator
function createVocoderEffect(ctx, frequency = 110, intensity = 0.5) {
  const carrier = ctx.createOscillator();
  carrier.type = 'sawtooth';
  carrier.frequency.value = frequency;

  const carrierGain = ctx.createGain();
  carrierGain.gain.value = intensity;

  carrier.connect(carrierGain);
  carrier.start();

  return {
    node: carrierGain,
    setFrequency: f => carrier.frequency.setTargetAtTime(f, ctx.currentTime, 0.01),
    setIntensity: v => carrierGain.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
    stop: () => { try { carrier.stop(); } catch(e) {} },
  };
}

// Stereo width control (mid-side)
function createStereoWidthNode(ctx, width = 1.0) {
  // width: 0=mono, 1=normal, 2=extra wide
  const merger = ctx.createChannelMerger(2);
  const splitter = ctx.createChannelSplitter(2);
  const midGain = ctx.createGain();
  const sideGain = ctx.createGain();
  midGain.gain.value = 1;
  sideGain.gain.value = width;

  return {
    input: splitter,
    output: merger,
    setWidth: w => { sideGain.gain.setTargetAtTime(w, ctx.currentTime, 0.01); },
  };
}

window.SF2VocalProcessor = {
  midSideSplit,
  midSideMerge,
  removeVocalMidSide,
  applyJPopComp,
  autotunePitch,
  createVocoderEffect,
  createStereoWidthNode,
  JPOP_COMP_STYLES,
};
