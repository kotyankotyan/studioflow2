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

window.SF2StemSeparator = { separateStem, separateAllStems, extractMIDIEvents, exportMIDI };
