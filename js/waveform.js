// waveform.js - Waveform drawing utilities

function drawWaveform(canvas, buffer, color = '#4a9eff', bg = 'transparent') {
  if (!canvas || !buffer) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }

  const ch = buffer.numberOfChannels;
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / W);
  const mid = H / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    const start = x * step;
    for (let i = start; i < start + step && i < data.length; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x, mid + min * mid);
    ctx.lineTo(x, mid + max * mid);
  }
  ctx.stroke();
}

function drawWaveformFilled(canvas, buffer, color = '#4a9eff', bg = '#0d1b2a') {
  if (!canvas || !buffer) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / W);
  const mid = H / 2;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + 'cc');
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, color + 'cc');
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let x = 0; x < W; x++) {
    let max = 0;
    const start = x * step;
    for (let i = start; i < start + step && i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
    ctx.lineTo(x, mid - max * mid);
  }
  for (let x = W - 1; x >= 0; x--) {
    let max = 0;
    const start = x * step;
    for (let i = start; i < start + step && i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
    ctx.lineTo(x, mid + max * mid);
  }
  ctx.closePath();
  ctx.fill();
}

// Draw mini waveform for part cards
function drawMiniWaveform(canvas, buffer, color = '#4a9eff') {
  drawWaveformFilled(canvas, buffer, color, '#0d1b2a');
}

// Real-time analyser bar visualization
function drawAnalyserBars(canvas, analyser, color = '#4a9eff') {
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const bufLen = analyser.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);
  analyser.getByteFrequencyData(dataArr);

  ctx.clearRect(0, 0, W, H);
  const barW = W / bufLen * 2.5;
  let x = 0;
  for (let i = 0; i < bufLen; i++) {
    const barH = (dataArr[i] / 255) * H;
    const grad = ctx.createLinearGradient(0, H - barH, 0, H);
    grad.addColorStop(0, '#e94560');
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, '#22c55e');
    ctx.fillStyle = grad;
    ctx.fillRect(x, H - barH, barW - 1, barH);
    x += barW + 1;
    if (x > W) break;
  }
}

// Spectrum analyser (canvas 320x120)
function drawSpectrum(canvas, analyser) {
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const bufLen = analyser.frequencyBinCount;
  const data = new Float32Array(bufLen);
  analyser.getFloatFrequencyData(data);

  ctx.fillStyle = '#0d1b2a';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#ffffff11';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach(y => {
    ctx.beginPath(); ctx.moveTo(0, H * y); ctx.lineTo(W, H * y); ctx.stroke();
  });

  ctx.beginPath();
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < W; i++) {
    const idx = Math.floor(i / W * bufLen);
    const db = data[idx];
    const norm = Math.max(0, (db + 100) / 100);
    const y = H - norm * H;
    i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
  }
  ctx.stroke();
}

window.SF2Waveform = { drawWaveform, drawWaveformFilled, drawMiniWaveform, drawAnalyserBars, drawSpectrum };
