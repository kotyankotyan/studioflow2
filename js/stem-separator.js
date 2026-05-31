// stem-separator.js - Stem separation (frequency-band based, browser-only)

// Frequency band boundaries for stem separation
const STEM_BANDS = {
  vocals: { lowCut: 300, highCut: 3400, midBoost: true },
  drums:  { attack: true, transient: true },
  bass:   { lowCut: 20, highCut: 250 },
  other:  { residual: true },
};

// Create a bandpass-separated stem from an AudioBuffer using OfflineAudioContext
async function separateStem(buffer, stemType) {
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const ch = buffer.numberOfChannels;
  const offCtx = new OfflineAudioContext(ch, len, sr);

  const source = offCtx.createBufferSource();
  source.buffer = buffer;

  let lastNode = source;

  if (stemType === 'vocals') {
    // Mid/side: keep mid channel (center-panned vocals)
    // Use highpass + lowpass to isolate vocal range
    const hp = offCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 200; hp.Q.value = 0.7;
    const lp = offCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 6000; lp.Q.value = 0.7;
    source.connect(hp); hp.connect(lp); lastNode = lp;
  } else if (stemType === 'bass') {
    const lp = offCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 250; lp.Q.value = 0.7;
    source.connect(lp); lastNode = lp;
  } else if (stemType === 'drums') {
    // Drums: keep transients, boost attack
    const hp = offCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 60; hp.Q.value = 0.5;
    const comp = offCtx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.ratio.value = 8;
    comp.attack.value = 0.001; comp.release.value = 0.05;
    source.connect(hp); hp.connect(comp); lastNode = comp;
  } else {
    // Other: residual (full range, slight mid cut)
    const notch = offCtx.createBiquadFilter();
    notch.type = 'notch'; notch.frequency.value = 1000; notch.Q.value = 0.3;
    source.connect(notch); lastNode = notch;
  }

  const gain = offCtx.createGain();
  gain.gain.value = 1.2; // Compensate for filtering loss
  lastNode.connect(gain);
  gain.connect(offCtx.destination);
  source.start(0);

  return offCtx.startRendering();
}

// Separate all 4 stems from a buffer
async function separateAllStems(buffer, onProgress) {
  const stems = {};
  const types = ['vocals', 'bass', 'drums', 'other'];
  for (let i = 0; i < types.length; i++) {
    if (onProgress) onProgress(i / types.length, types[i]);
    stems[types[i]] = await separateStem(buffer, types[i]);
  }
  if (onProgress) onProgress(1, 'done');
  return stems;
}

// ===== Model-free 2-stem separation (vocals / instrumental) =====
// Frequency-domain center extraction (ADRess-style): per frequency bin, judge
// how "center-panned & in-phase" the content is (typical for lead vocals) and
// build a soft mask. No ML model, no external data — fully local, license-free.

// In-place iterative radix-2 FFT. inverse=true performs the IFFT (and scales).
function _fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// L/R correlation in [0..1]. ~1 = near-mono (no spatial cue → can't separate).
function stereoCorrelation(buffer) {
  if (buffer.numberOfChannels < 2) return 1;
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  const n = L.length, step = Math.max(1, Math.floor(n / 200000));
  let sLR = 0, sLL = 0, sRR = 0;
  for (let i = 0; i < n; i += step) { sLR += L[i] * R[i]; sLL += L[i] * L[i]; sRR += R[i] * R[i]; }
  return sLR / (Math.sqrt(sLL * sRR) + 1e-12);
}

// Separate a stereo buffer into { vocals, instrumental } AudioBuffers.
// strength 0..1 controls how aggressively centered content is treated as vocal.
// strength 0..1 = selectivity. Higher = cleaner vocal (less instrument leak) but
// a thinner vocal; lower = fuller vocal but more instrument bleed.
async function separateVocalInstrumental(buffer, strength = 0.6, onProgress) {
  const exp = 1.5 + 3 * Math.max(0, Math.min(1, strength)); // 1.5 .. 4.5
  const sr = buffer.sampleRate, len = buffer.length;
  const stereo = buffer.numberOfChannels >= 2;
  const L = buffer.getChannelData(0);
  const R = stereo ? buffer.getChannelData(1) : L;

  const N = 4096, hop = N / 4;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

  // Per-bin vocal-band weight: keep centered bass/kick (<~120Hz) and very high
  // air/cymbals (>~9kHz) OUT of the vocal stem (they belong to the instrumental).
  // Computed symmetrically because bins above N/2 are the mirrored frequencies.
  const ramp = (x, a, b) => x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  const fWeight = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const f = (k <= N / 2 ? k : N - k) * sr / N;
    fWeight[k] = ramp(f, 90, 260) * (1 - ramp(f, 9000, 14000));
  }

  const voL = new Float32Array(len), voR = new Float32Array(len);
  const inL = new Float32Array(len), inR = new Float32Array(len);
  const norm = new Float32Array(len);

  const reL = new Float32Array(N), imL = new Float32Array(N);
  const reR = new Float32Array(N), imR = new Float32Array(N);
  const vRe = new Float32Array(N), vIm = new Float32Array(N);
  const lRe = new Float32Array(N), lIm = new Float32Array(N);
  const rRe = new Float32Array(N), rIm = new Float32Array(N);

  const frames = Math.ceil(len / hop);
  let frame = 0;
  for (let pos = 0; pos < len; pos += hop, frame++) {
    for (let k = 0; k < N; k++) {
      const idx = pos + k;
      const w = win[k];
      reL[k] = idx < len ? L[idx] * w : 0; imL[k] = 0;
      reR[k] = idx < len ? R[idx] * w : 0; imR[k] = 0;
    }
    _fft(reL, imL, false); _fft(reR, imR, false);

    for (let k = 0; k < N; k++) {
      const lr = reL[k], li = imL[k], rr = reR[k], ri = imR[k];
      const magL = Math.hypot(lr, li), magR = Math.hypot(rr, ri);
      const cross = lr * rr + li * ri;                       // Re(L * conj(R))
      const coh = cross / (magL * magR + 1e-9);              // -1..1 (1 = in phase)
      const bal = 2 * magL * magR / (magL * magL + magR * magR + 1e-9); // 1 = equal level
      let m = Math.max(0, coh) * bal;                        // 0..1 center-ness
      m = Math.min(1, Math.pow(m, exp) * fWeight[k]);        // selectivity + vocal band
      const midr = (lr + rr) * 0.5, midi = (li + ri) * 0.5;
      vRe[k] = midr * m; vIm[k] = midi * m;                  // vocals = centered mid
      lRe[k] = lr - midr * m; lIm[k] = li - midi * m;        // instrumental = rest
      rRe[k] = rr - midr * m; rIm[k] = ri - midi * m;
    }
    _fft(vRe, vIm, true); _fft(lRe, lIm, true); _fft(rRe, rIm, true);

    for (let k = 0; k < N; k++) {
      const idx = pos + k;
      if (idx >= len) break;
      const w = win[k];
      voL[idx] += vRe[k] * w; voR[idx] += vRe[k] * w;        // vocal mono -> both ch
      inL[idx] += lRe[k] * w; inR[idx] += rRe[k] * w;
      norm[idx] += w * w;
    }

    if ((frame & 127) === 0) {
      if (onProgress) onProgress(frame / frames);
      await new Promise(r => setTimeout(r, 0));              // yield to keep UI alive
    }
  }
  for (let i = 0; i < len; i++) {
    const n = norm[i] || 1;
    voL[i] /= n; voR[i] /= n; inL[i] /= n; inR[i] /= n;
  }
  const mk = (a, b) => { const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: sr }); buf.copyToChannel(a, 0); buf.copyToChannel(b, 1); return buf; };
  if (onProgress) onProgress(1);
  return { vocals: mk(voL, voR), instrumental: mk(inL, inR) };
}

// MIDI note extraction (amplitude envelope to note events)
function extractMIDIEvents(buffer) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const windowSize = 512;
  const events = [];
  let lastPitch = -1;
  let noteStart = -1;

  for (let i = 0; i < data.length - windowSize; i += windowSize) {
    // Simple pitch detection via zero-crossing rate
    let crossings = 0;
    let rms = 0;
    for (let j = i; j < i + windowSize - 1; j++) {
      if (Math.sign(data[j]) !== Math.sign(data[j + 1])) crossings++;
      rms += data[j] * data[j];
    }
    rms = Math.sqrt(rms / windowSize);
    const freq = (crossings / 2) * sr / windowSize;
    const midi = freq > 20 ? Math.round(12 * Math.log2(freq / 440) + 69) : -1;

    if (rms > 0.02 && midi >= 21 && midi <= 108) {
      if (midi !== lastPitch) {
        if (lastPitch >= 0 && noteStart >= 0) {
          events.push({ note: lastPitch, start: noteStart / sr, end: i / sr, velocity: Math.min(127, Math.round(rms * 400)) });
        }
        noteStart = i;
        lastPitch = midi;
      }
    } else {
      if (lastPitch >= 0 && noteStart >= 0) {
        events.push({ note: lastPitch, start: noteStart / sr, end: i / sr, velocity: Math.min(127, Math.round(rms * 400)) });
      }
      lastPitch = -1; noteStart = -1;
    }
  }
  return events;
}

// Export MIDI events as MIDI file bytes
function exportMIDI(events, bpm = 120) {
  const ticksPerBeat = 480;
  const tempo = Math.round(60000000 / bpm);

  function varLen(n) {
    if (n < 128) return [n];
    const bytes = [];
    bytes.unshift(n & 0x7F);
    n >>= 7;
    while (n > 0) { bytes.unshift((n & 0x7F) | 0x80); n >>= 7; }
    return bytes;
  }

  function timeTicks(sec) { return Math.round(sec * bpm / 60 * ticksPerBeat); }

  // Build track chunk
  const trackEvents = [];
  // Tempo event
  trackEvents.push(0, 0xFF, 0x51, 0x03, (tempo >> 16) & 0xFF, (tempo >> 8) & 0xFF, tempo & 0xFF);

  const sorted = [...events].sort((a, b) => a.start - b.start);
  let lastTick = 0;
  for (const ev of sorted) {
    const onTick = timeTicks(ev.start);
    const offTick = timeTicks(ev.end);
    const onDelta = onTick - lastTick;
    trackEvents.push(...varLen(onDelta), 0x90, ev.note, ev.velocity);
    lastTick = onTick;
    const offDelta = offTick - lastTick;
    trackEvents.push(...varLen(offDelta), 0x80, ev.note, 0);
    lastTick = offTick;
  }
  trackEvents.push(0, 0xFF, 0x2F, 0x00); // End of track

  const header = [0x4D, 0x54, 0x68, 0x64, 0,0,0,6, 0,0, 0,1, (ticksPerBeat >> 8) & 0xFF, ticksPerBeat & 0xFF];
  const trackLen = trackEvents.length;
  const trackHeader = [0x4D, 0x54, 0x72, 0x6B,
    (trackLen >> 24)&0xFF, (trackLen >> 16)&0xFF, (trackLen >> 8)&0xFF, trackLen & 0xFF];

  return new Uint8Array([...header, ...trackHeader, ...trackEvents]);
}

window.SF2StemSeparator = { separateStem, separateAllStems, separateVocalInstrumental, stereoCorrelation, extractMIDIEvents, exportMIDI };
