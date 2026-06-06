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

// Convert any image File/Blob (PNG/JPEG/WebP…) to a downscaled JPEG Uint8Array.
async function imageToJpeg(file, maxSize = 800, quality = 0.85) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

function _concat(arrs) {
  let total = 0; for (const a of arrs) total += a.length;
  const out = new Uint8Array(total); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ID3v2.3 text frame (UTF-16LE w/ BOM → handles Japanese).
function _id3Text(id, text) {
  if (!text) return new Uint8Array(0);
  const body = new Uint8Array(1 + 2 + text.length * 2 + 2);
  body[0] = 0x01;                       // encoding: UTF-16 with BOM
  body[1] = 0xFF; body[2] = 0xFE;       // BOM (little endian)
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); body[3 + i * 2] = c & 0xff; body[4 + i * 2] = (c >> 8) & 0xff; }
  const enc = new TextEncoder();
  const frame = new Uint8Array(10 + body.length);
  frame.set(enc.encode(id), 0);
  const sz = body.length;
  frame[4] = (sz >>> 24) & 0xff; frame[5] = (sz >>> 16) & 0xff; frame[6] = (sz >>> 8) & 0xff; frame[7] = sz & 0xff;
  frame.set(body, 10);
  return frame;
}

// ID3v2.3 APIC (front cover) frame from JPEG bytes.
function _id3Apic(jpeg) {
  if (!jpeg) return new Uint8Array(0);
  const enc = new TextEncoder();
  const mime = enc.encode('image/jpeg\0');
  const head = new Uint8Array(1 + mime.length + 2);
  head[0] = 0x00; head.set(mime, 1); head[1 + mime.length] = 0x03; head[2 + mime.length] = 0x00; // enc, mime\0, type=cover, desc\0
  const body = _concat([head, jpeg]);
  const frame = new Uint8Array(10 + body.length);
  frame.set(enc.encode('APIC'), 0);
  const sz = body.length;
  frame[4] = (sz >>> 24) & 0xff; frame[5] = (sz >>> 16) & 0xff; frame[6] = (sz >>> 8) & 0xff; frame[7] = sz & 0xff;
  frame.set(body, 10);
  return frame;
}

// Build a complete ID3v2.3 tag (optional title/artist/album + cover).
function buildID3(meta = {}, jpeg = null) {
  const frames = _concat([
    _id3Text('TIT2', meta.title), _id3Text('TPE1', meta.artist), _id3Text('TALB', meta.album), _id3Apic(jpeg),
  ]);
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode('ID3'), 0); header[3] = 3; header[4] = 0; header[5] = 0;
  const sz = frames.length;
  header[6] = (sz >>> 21) & 0x7f; header[7] = (sz >>> 14) & 0x7f; header[8] = (sz >>> 7) & 0x7f; header[9] = sz & 0x7f;
  return _concat([header, frames]);
}

// MP3 encode via lamejs. Returns Uint8Array of MP3 bytes.
async function encodeMP3(buffer, kbps = 256, onProgress) {
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) throw new Error('MP3エンコーダ未読込');
  let buf = buffer;
  if (![32000, 44100, 48000].includes(buf.sampleRate)) buf = await resampleBuffer(buf, 44100);
  const ch = Math.min(2, buf.numberOfChannels), sr = buf.sampleRate;
  const enc = new lamejs.Mp3Encoder(ch, sr, kbps);
  const toI16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; } return o; };
  const L = toI16(buf.getChannelData(0)), R = ch > 1 ? toI16(buf.getChannelData(1)) : null;
  const block = 1152, n = L.length, parts = [];
  for (let i = 0; i < n; i += block) {
    const lc = L.subarray(i, i + block);
    const mp3 = ch > 1 ? enc.encodeBuffer(lc, R.subarray(i, i + block)) : enc.encodeBuffer(lc);
    if (mp3.length > 0) parts.push(new Uint8Array(mp3.buffer, mp3.byteOffset, mp3.length));
    if (((i / block) & 63) === 0) { if (onProgress) onProgress(i / n); await new Promise(r => setTimeout(r, 0)); }
  }
  const end = enc.flush(); if (end.length > 0) parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length));
  if (onProgress) onProgress(1);
  return _concat(parts);
}

// Prepend an ID3v2 tag (title/artist/album + cover) to MP3 bytes.
function addMP3Tag(mp3, meta, jpeg) {
  return _concat([buildID3(meta, jpeg), mp3]);
}

// Append album art to a WAV (as a RIFF "id3 " chunk holding an ID3v2 APIC).
function addWAVCoverArt(wavBuf, jpeg) {
  const wav = new Uint8Array(wavBuf);
  const tag = buildID3({}, jpeg);
  const pad = tag.length % 2;
  const chunk = new Uint8Array(8 + tag.length + pad);
  chunk.set(new TextEncoder().encode('id3 '), 0);
  new DataView(chunk.buffer).setUint32(4, tag.length, true);
  chunk.set(tag, 8);
  const out = new Uint8Array(wav.length + chunk.length);
  out.set(wav, 0); out.set(chunk, wav.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true); // fix RIFF size
  return out.buffer;
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
  imageToJpeg,
  addWAVCoverArt,
  buildID3,
  encodeMP3,
  addMP3Tag,
  encodeViaMediaRecorder,
  resampleBuffer,
  download,
};
