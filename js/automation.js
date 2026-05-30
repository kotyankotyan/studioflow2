// automation.js - Automation curve drawing and playback

class AutomationLane {
  constructor(trackId, param, label) {
    this.trackId = trackId;
    this.param = param; // 'volume' | 'pan' | 'eqLow' | 'eqMid' | 'eqHigh' | 'reverb' | 'filter'
    this.label = label;
    this.points = []; // [{time, value}] sorted by time
    this.canvas = null;
    this.isDragging = false;
    this._dragIdx = -1;
  }

  addPoint(time, value) {
    const existing = this.points.findIndex(p => Math.abs(p.time - time) < 0.01);
    if (existing >= 0) {
      this.points[existing].value = value;
    } else {
      this.points.push({ time, value });
      this.points.sort((a, b) => a.time - b.time);
    }
  }

  removePoint(time) {
    this.points = this.points.filter(p => Math.abs(p.time - time) > 0.05);
  }

  getValueAt(time) {
    if (this.points.length === 0) return this._defaultValue();
    if (this.points.length === 1) return this.points[0].value;
    if (time <= this.points[0].time) return this.points[0].value;
    if (time >= this.points[this.points.length - 1].time) return this.points[this.points.length - 1].value;
    // Linear interpolation between nearest points
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i], b = this.points[i + 1];
      if (time >= a.time && time <= b.time) {
        const t = (time - a.time) / (b.time - a.time);
        return a.value + (b.value - a.value) * t;
      }
    }
    return this._defaultValue();
  }

  _defaultValue() {
    if (this.param === 'volume') return 1;
    if (this.param === 'pan') return 0;
    return 0;
  }

  applyToAudioParam(audioParam, startTime, duration, ctx) {
    if (this.points.length === 0) return;
    audioParam.cancelScheduledValues(startTime);
    for (const pt of this.points) {
      const absTime = startTime + pt.time;
      if (absTime < startTime || absTime > startTime + duration) continue;
      audioParam.linearRampToValueAtTime(pt.value, absTime);
    }
  }

  draw(canvas, duration, pixelsPerSec, scrollX = 0) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = 'rgba(168,85,247,0.08)';
    ctx.fillRect(0, 0, W, H);

    // Center line
    const mid = this._paramToY(this._defaultValue(), H);
    ctx.strokeStyle = '#ffffff22';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
    ctx.setLineDash([]);

    if (this.points.length === 0) return;

    // Curve
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (const pt of this.points) {
      const x = pt.time * pixelsPerSec - scrollX;
      const y = this._paramToY(pt.value, H);
      if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    // Control points
    for (const pt of this.points) {
      const x = pt.time * pixelsPerSec - scrollX;
      const y = this._paramToY(pt.value, H);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#a855f7';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _paramToY(value, H) {
    // Normalize value to [0,1] for Y
    let norm;
    if (this.param === 'volume') norm = 1 - value; // 0..1 → flip
    else if (this.param === 'pan') norm = (1 - value) / 2; // -1..1 → 0..1
    else norm = 0.5 - value / 24; // EQ ±12dB
    return Math.max(2, Math.min(H - 2, norm * H));
  }

  _yToParam(y, H) {
    const norm = y / H;
    if (this.param === 'volume') return Math.max(0, Math.min(2, 1 - norm));
    if (this.param === 'pan') return Math.max(-1, Math.min(1, 1 - norm * 2));
    return Math.max(-12, Math.min(12, (0.5 - norm) * 24));
  }

  serialize() {
    return { trackId: this.trackId, param: this.param, label: this.label, points: [...this.points] };
  }

  static deserialize(data) {
    const lane = new AutomationLane(data.trackId, data.param, data.label);
    lane.points = data.points || [];
    return lane;
  }
}

window.SF2Automation = { AutomationLane };
