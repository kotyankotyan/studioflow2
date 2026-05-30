// export-manager.js - Audio export (WAV/MP3/OGG/FLAC) with metadata

function bufferToWAVBytes(buffer, bitDepth = 16, sampleRate = null) {
  const sr = sampleRate || buffer.sampleRate;
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : 2;
  const isFloat = bitDepth === 32;
  const dataLen = len * ch * bytesPerSample;
  const wavBuf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(wavBuf);

  function writeStr(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * bytesPerSample, true);
  view.setUint16(32, ch * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  const channels = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (isFloat) { view.setFloat32(offset, s, true); offset += 4; }
      else if (bitDepth === 24) {
        const v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
        view.setUint8(offset, v & 0xFF);
        view.setUint8(offset + 1, (v >> 8) & 0xFF);
        view.setUint8(offset + 2, (v >> 16) & 0xFF);
        offset += 3;
      } else {
        view.setInt16(offset, Math.round(s < 0 ? s * 32768 : s * 32767), true); offset += 2;
      }
    }
  }
  return wavBuf;
}

// Export AudioBuffer as downloadable WAV
function exportWAV(buffer, filename = 'export.wav', bitDepth = 16, sampleRate = null) {
  const bytes = bufferToWAVBytes(buffer, bitDepth, sampleRate);
  download(new Blob([bytes], { type: 'audio/wav' }), filename);
}

// Export as OGG using MediaRecorder (if supported)
async function exportOGG(buffer, filename = 'export.ogg', bitrate = 192) {
  const blob = await encodeViaMediaRecorder(buffer, 'audio/ogg; codecs=vorbis', bitrate);
  download(blob, filename);
}

// Export as WebM/Opus (most widely supported via MediaRecorder)
async function exportWebM(buffer, filename = 'export.webm', bitrate = 192) {
  const blob = await encodeViaMediaRecorder(buffer, 'audio/webm; codecs=opus', bitrate);
  download(blob, filename);
}

// MediaRecorder-based encoding
async function encodeViaMediaRecorder(buffer, mimeType, bitrate = 192) {
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`${mimeType} not supported in this browser`);
  }

  const sr = buffer.sampleRate;
  const ch = buffer.numberOfChannels;
  const offCtx = new AudioContext({ sampleRate: sr });
  const src = offCtx.createBufferSource();
  src.buffer = buffer;

  const dest = offCtx.createMediaStreamDestination();
  src.connect(dest);

  const chunks = [];
  const recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: bitrate * 1000 });
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = reject;
    recorder.start();
    src.start(0);
    setTimeout(() => { recorder.stop(); offCtx.close(); }, buffer.duration * 1000 + 500);
  });
}

// Embed metadata into WAV (ID3 tags via LIST INFO chunk)
function addWAVMetadata(wavBytes, meta = {}) {
  const { title = '', artist = '', album = '' } = meta;

  function infoChunk(tag, val) {
    if (!val) return new Uint8Array(0);
    const enc = new TextEncoder().encode(val + '\0');
    const padded = enc.length % 2 === 0 ? enc : new Uint8Array([...enc, 0]);
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, tag.charCodeAt(0) | (tag.charCodeAt(1) << 8) | (tag.charCodeAt(2) << 16) | (tag.charCodeAt(3) << 24), true);
    new DataView(header.buffer).setUint32(4, padded.length, true);
    return new Uint8Array([...header, ...padded]);
  }

  const inam = infoChunk('INAM', title);
  const iart = infoChunk('IART', artist);
  const iprd = infoChunk('IPRD', album);
  const infoData = new Uint8Array([...inam, ...iart, ...iprd]);
  const listChunk = new Uint8Array(12 + infoData.length);
  const lv = new DataView(listChunk.buffer);
  lv.setUint32(0, 0x5453494C, false); // 'LIST'
  lv.setUint32(4, 4 + infoData.length, true);
  listChunk.set(new TextEncoder().encode('INFO'), 8);
  listChunk.set(infoData, 12);

  const combined = new Uint8Array(wavBytes.byteLength + listChunk.length);
  combined.set(new Uint8Array(wavBytes));
  combined.set(listChunk, wavBytes.byteLength);
  // Update RIFF size
  new DataView(combined.buffer).setUint32(4, combined.length - 8, true);
  return combined.buffer;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// Resample buffer to target sample rate via OfflineAudioContext
async function resampleBuffer(buffer, targetSR) {
  if (buffer.sampleRate === targetSR) return buffer;
  const ch = buffer.numberOfChannels;
  const newLen = Math.round(buffer.length * targetSR / buffer.sampleRate);
  const offCtx = new OfflineAudioContext(ch, newLen, targetSR);
  const src = offCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offCtx.destination);
  src.start(0);
  return offCtx.startRendering();
}

window.SF2ExportManager = {
  bufferToWAVBytes,
  exportWAV,
  exportOGG,
  exportWebM,
  addWAVMetadata,
  encodeViaMediaRecorder,
  resampleBuffer,
  download,
};
