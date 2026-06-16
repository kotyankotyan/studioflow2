// pro-tools.js - DSP processing (silence cut, fade, LUFS, TruePeak, etc.)

// Find zero crossing near sample index
function findZeroCrossing(data, idx, searchRange = 100) {
  for (let i = 0; i < searchRange; i++) {
    if (idx + i < data.length - 1 && Math.sign(data[idx + i]) !== Math.sign(data[idx + i + 1])) return idx + i;
    if (idx - i >= 0 && Math.sign(data[idx - i]) !== Math.sign(data[idx - i + 1])) return idx - i;
  }
  return idx;
}

// Silence detection and cut
function detectSilence(buffer, sensitivity = 3) {
  const threshold = [0.001, 0.003, 0.005, 0.01, 0.02][sensitivity - 1];
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const windowSize = Math.floor(sr * 0.01); // 10ms windows
  const regions = []; // [{start, end}] of silent regions
  let silenceStart = -1;

  for (let i = 0; i < data.length; i += windowSize) {
    let rms = 0;
    for (let j = i; j < Math.min(i + windowSize, data.length); j++) {
      rms += data[j] * data[j];
    }
    rms = Math.sqrt(rms / windowSize);
    if (rms < threshold) {
      if (silenceStart < 0) silenceStart = i;
    } else {
      if (silenceStart >= 0 && (i - silenceStart) > sr * 0.1) {
        regions.push({ start: silenceStart, end: i });
      }
      silenceStart = -1;
    }
  }
  return regions;
}

// Remove leading/trailing silence from buffer
function trimSilence(buffer, sensitivity = 3) {
  const threshold = [0.001, 0.003, 0.005, 0.01, 0.02][sensitivity - 1];
  const ch = buffer.numberOfChannels;
  const data = buffer.getChannelData(0);
  let start = 0, end = data.length - 1;

  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end]) < threshold) end--;

  start = findZeroCrossing(data, start);
  end = findZeroCrossing(data, end);

  const newLen = end - start + 1;
  const result = new AudioBuffer({ numberOfChannels: ch, length: newLen, sampleRate: buffer.sampleRate });
  for (let c = 0; c < ch; c++) {
    result.copyToChannel(buffer.getChannelData(c).slice(start, end + 1), c);
  }
  return result;
}

// Apply fade in/out to buffer
function applyFade(buffer, type, duration, curve = 'exponential') {
  const sr = buffer.sampleRate;
  const samples = Math.min(Math.floor(duration * sr), buffer.length);
  const ch = buffer.numberOfChannels;
  const result = cloneBuffer(buffer);

  for (let c = 0; c < ch; c++) {
    const data = result.getChannelData(c);
    for (let i = 0; i < samples; i++) {
      let env;
      const t = i / samples;
      if (curve === 'exponential') env = t * t;
      else if (curve === 'scurve') env = t * t * (3 - 2 * t);
      else env = t; // linear

      if (type === 'in') data[i] *= env;
      else if (type === 'out') data[buffer.length - 1 - i] *= env;
    }
  }
  return result;
}

function cloneBuffer(buffer) {
  const result = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    result.copyToChannel(buffer.getChannelData(c).slice(), c);
  }
  return result;
}

// LUFS measurement (ITU-R BS.1770)
function measureLUFS(buffer) {
  const sr = buffer.sampleRate;
  const ch = buffer.numberOfChannels;

  // K-weighting filter coefficients (simplified for 44.1kHz)
  function kWeight(data) {
    const out = new Float32Array(data.length);
    // Stage 1: high-shelf pre-filter
    const b0 = 1.53512485958697, b1 = -2.69169618940638, b2 = 1.19839281085285;
    const a1 = -1.69065929318241, a2 = 0.73248077421585;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    // Stage 2: highpass
    const b0h = 1.0, b1h = -2.0, b2h = 1.0;
    const a1h = -1.99004745483398, a2h = 0.99007225036621;
    x1 = 0; x2 = 0; y1 = 0; y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x0 = out[i];
      const y0 = b0h * x0 + b1h * x1 + b2h * x2 - a1h * y1 - a2h * y2;
      out[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }

  // Mean square of each channel after K-weighting
  const windowSamples = Math.floor(sr * 0.4); // 400ms
  const hopSamples = Math.floor(sr * 0.1);    // 100ms hop
  const gatingThreshold = -70; // LUFS absolute gate
  const blocks = [];

  const channelData = [];
  for (let c = 0; c < Math.min(ch, 2); c++) {
    channelData.push(kWeight(buffer.getChannelData(c)));
  }

  for (let start = 0; start + windowSamples <= buffer.length; start += hopSamples) {
    let sum = 0;
    for (const data of channelData) {
      for (let i = start; i < start + windowSamples; i++) {
        sum += data[i] * data[i];
      }
    }
    const meanSq = sum / (windowSamples * channelData.length);
    const lufs = -0.691 + 10 * Math.log10(Math.max(meanSq, 1e-10));
    if (lufs > gatingThreshold) blocks.push(meanSq);
  }

  if (blocks.length === 0) return -70;

  // Relative gate: -10 LU below ungated mean
  const ungatedMean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const relThreshold = ungatedMean * Math.pow(10, -1); // -10 LU
  const gated = blocks.filter(b => b > relThreshold);
  if (gated.length === 0) return -70;

  const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
  return -0.691 + 10 * Math.log10(Math.max(mean, 1e-10));
}

// Normalize buffer to target LUFS
function normalizeLUFS(buffer, targetLUFS = -14) {
  const measured = measureLUFS(buffer);
  const gainDB = targetLUFS - measured;
  const gainLin = Math.pow(10, gainDB / 20);
  const result = cloneBuffer(buffer);
  for (let c = 0; c < result.numberOfChannels; c++) {
    const data = result.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= gainLin;
  }
  return result;
}

// True Peak measurement (4x oversampling)
function measureTruePeak(buffer) {
  const oversample = 4;
  const ch = buffer.numberOfChannels;
  let peak = 0;
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    // Simple upsampling by linear interpolation
    for (let i = 0; i < data.length - 1; i++) {
      for (let k = 0; k < oversample; k++) {
        const t = k / oversample;
        const v = Math.abs(data[i] + (data[i + 1] - data[i]) * t);
        if (v > peak) peak = v;
      }
    }
  }
  return 20 * Math.log10(Math.max(peak, 1e-10));
}

// True Peak limiter
function applyTruePeakLimiter(buffer, ceilingDB = -1) {
  const ceiling = Math.pow(10, ceilingDB / 20);
  const tp = Math.pow(10, measureTruePeak(buffer) / 20);
  if (tp <= ceiling) return buffer;
  const gainLin = ceiling / tp;
  const result = cloneBuffer(buffer);
  for (let c = 0; c < result.numberOfChannels; c++) {
    const data = result.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= gainLin;
  }
  return result;
}

// Peak normalize
function peakNormalize(buffer, targetDB = -0.3) {
  const target = Math.pow(10, targetDB / 20);
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak === 0) return buffer;
  const gainLin = target / peak;
  const result = cloneBuffer(buffer);
  for (let c = 0; c < result.numberOfChannels; c++) {
    const data = result.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= gainLin;
  }
  return result;
}

// Detect energy-based split points
function detectSplitPoints(buffer, numSections = 4) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const windowSize = Math.floor(sr * 0.05); // 50ms windows
  const energies = [];
  for (let i = 0; i < data.length; i += windowSize) {
    let e = 0;
    for (let j = i; j < Math.min(i + windowSize, data.length); j++) e += data[j] * data[j];
    energies.push({ idx: i, e: e / windowSize });
  }
  // Find peaks in energy (onset detection)
  const peaks = [];
  for (let i = 2; i < energies.length - 2; i++) {
    const e = energies[i].e;
    if (e > energies[i-1].e && e > energies[i-2].e && e > energies[i+1].e && e > energies[i+2].e) {
      peaks.push({ time: energies[i].idx / sr, strength: e });
    }
  }
  peaks.sort((a, b) => b.strength - a.strength);
  const splits = peaks.slice(0, numSections - 1).map(p => p.time);
  splits.sort((a, b) => a - b);
  return [0, ...splits, buffer.duration];
}

// FFT-based EQ matching (5 band)
function computeEQMatch(referenceBuffer, targetBuffer) {
  const sr = referenceBuffer.sampleRate;
  const fftSize = 2048;
  const bands = [
    { name: 'Low', f: 80 },
    { name: 'LowMid', f: 300 },
    { name: 'Mid', f: 1000 },
    { name: 'HighMid', f: 4000 },
    { name: 'High', f: 10000 },
  ];

  function getSpectrum(buffer) {
    const data = buffer.getChannelData(0);
    const spectrum = new Float32Array(fftSize / 2);
    const hop = fftSize;
    let count = 0;
    for (let start = 0; start + fftSize < data.length; start += hop) {
      for (let i = 0; i < fftSize / 2; i++) {
        // Simplified: just average amplitude per bin
        spectrum[i] += Math.abs(data[start + i]);
      }
      count++;
    }
    if (count > 0) for (let i = 0; i < spectrum.length; i++) spectrum[i] /= count;
    return spectrum;
  }

  const refSpec = getSpectrum(referenceBuffer);
  const tgtSpec = getSpectrum(targetBuffer);

  return bands.map(band => {
    const bin = Math.floor(band.f / (sr / fftSize));
    const range = Math.max(1, Math.floor(bin * 0.3));
    let refSum = 0, tgtSum = 0;
    for (let i = Math.max(0, bin - range); i < Math.min(refSpec.length, bin + range); i++) {
      refSum += refSpec[i];
      tgtSum += tgtSpec[i];
    }
    const ratio = tgtSum > 0 ? refSum / tgtSum : 1;
    const gainDB = Math.max(-12, Math.min(12, 20 * Math.log10(Math.max(ratio, 1e-10))));
    return { name: band.name, f: band.f, gain: gainDB };
  });
}

// BPM detection (autocorrelation)
function detectBPM(buffer) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const windowSize = Math.min(sr * 10, data.length); // 10s window
  const minBPM = 60, maxBPM = 200;
  const minLag = Math.floor(sr * 60 / maxBPM);
  const maxLag = Math.floor(sr * 60 / minBPM);

  // Onset envelope
  const envSize = Math.floor(windowSize / 512);
  const env = new Float32Array(envSize);
  for (let i = 0; i < envSize; i++) {
    let e = 0;
    for (let j = i * 512; j < Math.min((i + 1) * 512, windowSize); j++) e += data[j] * data[j];
    env[i] = Math.sqrt(e / 512);
  }

  // Autocorrelation on envelope
  const minLagEnv = Math.floor(minLag / 512);
  const maxLagEnv = Math.floor(maxLag / 512);
  let bestLag = minLagEnv, bestCorr = -1;

  for (let lag = minLagEnv; lag < maxLagEnv && lag < envSize; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < envSize; i++) corr += env[i] * env[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  const lagSamples = bestLag * 512;
  return Math.round(sr * 60 / lagSamples);
}

// In-place iterative radix-2 FFT (inverse scales by N).
function _fftPV(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// Pitch-preserving time-stretch (phase vocoder). ratio = outLen/inLen
// (>1 = longer/slower, <1 = shorter/faster). Pitch is unchanged.
async function timeStretch(buffer, ratio, onProgress) {
  if (!isFinite(ratio) || Math.abs(ratio - 1) < 0.003) return buffer;
  const N = 2048, Ha = N >> 2, Hs = Math.max(1, Math.round(Ha * ratio));
  const sr = buffer.sampleRate, ch = buffer.numberOfChannels, len = buffer.length;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const omega = new Float32Array(N);
  for (let k = 0; k < N; k++) omega[k] = 2 * Math.PI * k / N;     // expected phase advance / sample
  const numFrames = Math.max(1, Math.floor((len - N) / Ha) + 1);
  const outLen = (numFrames - 1) * Hs + N;
  const out = new AudioBuffer({ numberOfChannels: ch, length: outLen, sampleRate: sr });

  const re = new Float32Array(N), im = new Float32Array(N);
  const mag = new Float32Array(N), phase = new Float32Array(N), prevPhase = new Float32Array(N), sumPhase = new Float32Array(N);
  const norm = new Float32Array(outLen);
  const TWO_PI = 2 * Math.PI;

  for (let c = 0; c < ch; c++) {
    const inp = buffer.getChannelData(c), o = out.getChannelData(c);
    prevPhase.fill(0); sumPhase.fill(0);
    for (let f = 0; f < numFrames; f++) {
      const start = f * Ha;
      for (let k = 0; k < N; k++) { const idx = start + k; re[k] = idx < len ? inp[idx] * win[k] : 0; im[k] = 0; }
      _fftPV(re, im, false);
      for (let k = 0; k < N; k++) { mag[k] = Math.hypot(re[k], im[k]); phase[k] = Math.atan2(im[k], re[k]); }
      if (f === 0) { for (let k = 0; k < N; k++) sumPhase[k] = phase[k]; }
      else {
        for (let k = 0; k < N; k++) {
          let d = phase[k] - prevPhase[k] - omega[k] * Ha;
          d -= TWO_PI * Math.round(d / TWO_PI);                 // wrap to [-pi,pi]
          sumPhase[k] += Hs * (omega[k] + d / Ha);              // accumulate at synthesis hop
        }
      }
      for (let k = 0; k < N; k++) { prevPhase[k] = phase[k]; re[k] = mag[k] * Math.cos(sumPhase[k]); im[k] = mag[k] * Math.sin(sumPhase[k]); }
      _fftPV(re, im, true);
      const os = f * Hs;
      for (let k = 0; k < N; k++) { const i = os + k; if (i < outLen) { o[i] += re[k] * win[k]; if (c === 0) norm[i] += win[k] * win[k]; } }
      if ((f & 31) === 0 && onProgress) { onProgress((c * numFrames + f) / (ch * numFrames)); await new Promise(r => setTimeout(r, 0)); }
    }
  }
  for (let c = 0; c < ch; c++) { const o = out.getChannelData(c); for (let i = 0; i < outLen; i++) { const n = norm[i] || 1; o[i] /= n; } }
  if (onProgress) onProgress(1);
  return out;
}

// Vocal enhancement (clarity): high-pass rumble, presence boost (~4kHz),
// air (~10kHz) and gentle compression. Returns a processed AudioBuffer.
async function enhanceVocal(buffer) {
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 95;
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 4000; pres.Q.value = 1; pres.gain.value = 4;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 10000; air.gain.value = 2.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 6; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
  const makeup = ctx.createGain(); makeup.gain.value = 1.15;
  src.connect(hp); hp.connect(pres); pres.connect(air); air.connect(comp); comp.connect(makeup); makeup.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

// Drum enhancement for a separated drum stem. Boosts kick (60-90Hz) and snare
// (body 150-250Hz + crack 2-5kHz) with peaking EQ, and adds punch via a parallel
// fast compressor blended back in (transient emphasis). All amounts 0..1.
//   kick:   0..1  -> up to +6 dB @ ~75Hz
//   snare:  0..1  -> up to +5 dB @ 200Hz and +5 dB @ 3.5kHz
//   attack: 0..1  -> parallel-compressed punch blend (0 = none)
async function enhanceDrums(buffer, opts = {}) {
  const kick = Math.max(0, Math.min(1, opts.kick ?? 0.35));
  const snare = Math.max(0, Math.min(1, opts.snare ?? 0.35));
  const attack = Math.max(0, Math.min(1, opts.attack ?? 0.3));
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

  // --- main (EQ) path ---
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 30; hp.Q.value = 0.7; // clean sub rumble
  const kickEq = ctx.createBiquadFilter(); kickEq.type = 'peaking'; kickEq.frequency.value = 75; kickEq.Q.value = 1.1; kickEq.gain.value = kick * 5.3;     // up to ~+6dB at center (filter shape adds a touch)
  const snBody = ctx.createBiquadFilter(); snBody.type = 'peaking'; snBody.frequency.value = 200; snBody.Q.value = 1.0; snBody.gain.value = snare * 5;     // up to +5dB
  const snCrack = ctx.createBiquadFilter(); snCrack.type = 'peaking'; snCrack.frequency.value = 3500; snCrack.Q.value = 0.9; snCrack.gain.value = snare * 5; // up to +5dB
  src.connect(hp); hp.connect(kickEq); kickEq.connect(snBody); snBody.connect(snCrack);

  const dry = ctx.createGain(); dry.gain.value = 1;
  snCrack.connect(dry); dry.connect(ctx.destination);

  // --- parallel punch path (fast compressor on a second source) ---
  if (attack > 0.001) {
    const src2 = ctx.createBufferSource(); src2.buffer = buffer;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -28; comp.knee.value = 4; comp.ratio.value = 8;
    comp.attack.value = 0.002; comp.release.value = 0.12;
    const wet = ctx.createGain(); wet.gain.value = attack * 0.6;   // blend amount (parallel)
    src2.connect(comp); comp.connect(wet); wet.connect(ctx.destination);
    src2.start(0);
  }
  src.start(0);
  return ctx.startRendering();
}

// Krumhansl-Schmuckler key detection
function detectKey(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const fftSize = 8192;
  const chroma = new Float32Array(12);

  // Accumulate chroma features
  for (let start = 0; start + fftSize < data.length; start += fftSize) {
    for (let i = 0; i < fftSize; i++) {
      const freq = (i / fftSize) * sr;
      if (freq < 27.5 || freq > 4186) continue;
      const midi = 12 * Math.log2(freq / 440) + 69;
      const pc = Math.round(midi) % 12;
      if (pc >= 0 && pc < 12) chroma[pc] += Math.abs(data[start + i]);
    }
  }

  // KS profiles
  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function correlation(a, b) {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db + 1e-10);
  }

  let bestKey = 'C', bestScore = -2;
  for (let i = 0; i < 12; i++) {
    const rotated = [...chroma.slice(i), ...chroma.slice(0, i)];
    const major = correlation(rotated, majorProfile);
    const minor = correlation(rotated, minorProfile);
    if (major > bestScore) { bestScore = major; bestKey = noteNames[i] + ' Major'; }
    if (minor > bestScore) { bestScore = minor; bestKey = noteNames[i] + 'm'; }
  }
  return bestKey;
}

window.SF2ProTools = {
  findZeroCrossing,
  detectSilence,
  trimSilence,
  applyFade,
  cloneBuffer,
  measureLUFS,
  normalizeLUFS,
  measureTruePeak,
  applyTruePeakLimiter,
  peakNormalize,
  detectSplitPoints,
  computeEQMatch,
  detectBPM,
  detectKey,
  enhanceVocal,
  enhanceDrums,
  timeStretch,
};
