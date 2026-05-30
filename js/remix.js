// remix.js - Plarail-style remix (song library + drag/drop ordering + crossfade export)

class RemixEngine {
  constructor() {
    this.library = []; // {id, name, buffer, duration, bpm, key}
    this.sequence = []; // {id, name, buffer, crossfadeIn, crossfadeOut}
    this._nextId = 1;
  }

  addToLibrary(name, buffer, bpm = 120, key = '') {
    const id = this._nextId++;
    this.library.push({ id, name, buffer, duration: buffer.duration, bpm, key });
    return id;
  }

  removeFromLibrary(id) {
    this.library = this.library.filter(s => s.id !== id);
    this.sequence = this.sequence.filter(s => s.id !== id);
  }

  addToSequence(id, crossfadeIn = 2, crossfadeOut = 2) {
    const song = this.library.find(s => s.id === id);
    if (!song) return;
    this.sequence.push({ ...song, crossfadeIn, crossfadeOut });
  }

  removeFromSequence(idx) {
    this.sequence.splice(idx, 1);
  }

  moveInSequence(fromIdx, toIdx) {
    const item = this.sequence.splice(fromIdx, 1)[0];
    this.sequence.splice(toIdx, 0, item);
  }

  setCrossfade(idx, type, value) {
    if (this.sequence[idx]) {
      this.sequence[idx][type] = value; // type: 'crossfadeIn' or 'crossfadeOut'
    }
  }

  getTotalDuration() {
    if (this.sequence.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.sequence.length; i++) {
      total += this.sequence[i].duration;
      if (i < this.sequence.length - 1) {
        const fade = Math.min(this.sequence[i].crossfadeOut, this.sequence[i + 1].crossfadeIn);
        total -= fade;
      }
    }
    return total;
  }

  // Export the full remix as a single AudioBuffer
  async exportRemix(curveType = 'equalpower', onProgress) {
    if (this.sequence.length === 0) throw new Error('Sequence is empty');

    const sr = this.sequence[0].buffer.sampleRate;
    const ch = this.sequence[0].buffer.numberOfChannels;
    const totalSamples = Math.ceil(this.getTotalDuration() * sr);

    const offCtx = new OfflineAudioContext(ch, Math.max(1, totalSamples), sr);

    let writePos = 0;
    for (let i = 0; i < this.sequence.length; i++) {
      if (onProgress) onProgress(i / this.sequence.length);
      const song = this.sequence[i];
      const src = offCtx.createBufferSource();
      src.buffer = song.buffer;

      const gainNode = offCtx.createGain();
      src.connect(gainNode);
      gainNode.connect(offCtx.destination);

      const startTime = writePos / sr;
      const duration = song.buffer.duration;

      // Fade in
      if (i > 0 && song.crossfadeIn > 0) {
        const fadeIn = Math.min(song.crossfadeIn, duration * 0.5);
        gainNode.gain.setValueAtTime(0, startTime);
        this._rampGain(offCtx, gainNode, startTime, startTime + fadeIn, 0, 1, curveType);
      } else {
        gainNode.gain.setValueAtTime(1, startTime);
      }

      // Fade out
      if (i < this.sequence.length - 1 && song.crossfadeOut > 0) {
        const fadeOut = Math.min(song.crossfadeOut, duration * 0.5);
        const fadeStart = startTime + duration - fadeOut;
        this._rampGain(offCtx, gainNode, fadeStart, startTime + duration, 1, 0, curveType);
      }

      src.start(startTime);

      // Next song starts where this one fades out
      const overlap = i < this.sequence.length - 1
        ? Math.min(song.crossfadeOut, this.sequence[i + 1].crossfadeIn)
        : 0;
      writePos += Math.round((duration - overlap) * sr);
    }

    const result = await offCtx.startRendering();
    if (onProgress) onProgress(1);
    return result;
  }

  _rampGain(offCtx, gainNode, t0, t1, v0, v1, curveType) {
    gainNode.gain.setValueAtTime(v0, t0);
    switch (curveType) {
      case 'equalpower': {
        const steps = Math.ceil((t1 - t0) * offCtx.sampleRate / 128);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const g = curveType === 'equalpower' ? Math.cos(t * Math.PI / 2) * v0 + Math.sin(t * Math.PI / 2) * v1 : 0;
          gainNode.gain.setValueAtTime(g, t0 + t * (t1 - t0));
        }
        break;
      }
      case 'scurve': {
        const steps = Math.ceil((t1 - t0) * offCtx.sampleRate / 128);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const s = t * t * (3 - 2 * t);
          gainNode.gain.setValueAtTime(v0 + (v1 - v0) * s, t0 + t * (t1 - t0));
        }
        break;
      }
      case 'exponential':
        if (v0 > 0 && v1 > 0) {
          gainNode.gain.exponentialRampToValueAtTime(v1, t1);
        } else {
          gainNode.gain.linearRampToValueAtTime(v1, t1);
        }
        break;
      default: // linear
        gainNode.gain.linearRampToValueAtTime(v1, t1);
    }
  }

  serialize() {
    return {
      library: this.library.map(s => ({ id: s.id, name: s.name, duration: s.duration, bpm: s.bpm, key: s.key })),
      sequence: this.sequence.map(s => ({ id: s.id, crossfadeIn: s.crossfadeIn, crossfadeOut: s.crossfadeOut })),
      _nextId: this._nextId,
    };
  }
}

window.SF2Remix = { RemixEngine };
