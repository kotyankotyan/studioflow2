// creator.js - Material creation (loop, vocal removal, BPM conversion)

// Create a seamless loop from a buffer
async function createSeamlessLoop(buffer, crossfadeDuration = 2, endPoint = null) {
  const sr = buffer.sampleRate;
  const ch = buffer.numberOfChannels;
  const crossfadeSamples = Math.floor(crossfadeDuration * sr);
  const loopEnd = endPoint ? Math.floor(endPoint * sr) : buffer.length;
  const loopLen = Math.min(loopEnd, buffer.length);

  if (loopLen < crossfadeSamples * 2) throw new Error('Buffer too short for crossfade');

  const resultLen = loopLen;
  const result = new AudioBuffer({ numberOfChannels: ch, length: resultLen, sampleRate: sr });

  for (let c = 0; c < ch; c++) {
    const src = buffer.getChannelData(c);
    const dst = result.getChannelData(c);
    // Copy main body
    for (let i = 0; i < loopLen; i++) dst[i] = src[i];
    // Crossfade: blend end with beginning
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const endIdx = loopLen - crossfadeSamples + i;
      // S-curve crossfade
      const env = t * t * (3 - 2 * t);
      dst[endIdx] = src[endIdx] * (1 - env) + src[i] * env;
    }
  }
  return result;
}

// BPM conversion via time-stretching (resampling based, simplified)
async function convertBPM(buffer, originalBPM, targetBPM) {
  const ratio = originalBPM / targetBPM;
  const sr = buffer.sampleRate;
  const ch = buffer.numberOfChannels;
  const newLen = Math.round(buffer.length * ratio);

  // Use OfflineAudioContext with playbackRate for time stretching
  const offCtx = new OfflineAudioContext(ch, newLen, sr);
  const source = offCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = targetBPM / originalBPM;
  source.connect(offCtx.destination);
  source.start(0);
  return offCtx.startRendering();
}

// Vocal removal (karaoke). Uses the spectral center-extraction separator for a
// far cleaner instrumental when the source is stereo; falls back to mid/side.
async function removeVocals(buffer, removeAmount = 0.8) {
  if (buffer.numberOfChannels >= 2 && window.SF2StemSeparator?.separateVocalInstrumental) {
    const { instrumental } = await window.SF2StemSeparator.separateVocalInstrumental(buffer, removeAmount);
    return instrumental;
  }
  return window.SF2VocalProcessor.removeVocalMidSide(buffer, removeAmount);
}

// Stem separation for creator
async function separateStems(buffer, onProgress) {
  return window.SF2StemSeparator.separateAllStems(buffer, onProgress);
}

// Export loop as WAV blob
function bufferToWAV(buffer, bitDepth = 16) {
  const ch = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : 2;
  const dataLen = len * ch * bytesPerSample;
  const wavBuf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(wavBuf);

  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // PCM or IEEE float
  view.setUint16(22, ch, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * bytesPerSample, true);
  view.setUint16(32, ch * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  const channels = [];
  for (let c = 0; c < ch; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bitDepth === 32) {
        view.setFloat32(offset, s, true); offset += 4;
      } else if (bitDepth === 24) {
        const v = Math.round(s * 8388607);
        view.setUint8(offset, v & 0xFF);
        view.setUint8(offset + 1, (v >> 8) & 0xFF);
        view.setUint8(offset + 2, (v >> 16) & 0xFF);
        offset += 3;
      } else {
        view.setInt16(offset, Math.round(s * 32767), true); offset += 2;
      }
    }
  }
  return new Blob([wavBuf], { type: 'audio/wav' });
}

window.SF2Creator = { createSeamlessLoop, convertBPM, removeVocals, separateStems, bufferToWAV };
