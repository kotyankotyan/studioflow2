// audio-engine.js - Web Audio graph, playback, and offline rendering

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.tracks = [];
    this.masterCompressor = null;
    this.masterEQ = null;
    this.masterLimiter = null;
    this.masterGain = null;
    this.masterAnalyser = null;
    this.masterChain = null;

    this._isPlaying = false;
    this._playStartTime = 0;
    this._playOffset = 0;
    this._loopEnabled = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._activeSources = new Map(); // trackId → [sourceNode]
    this._animFrameId = null;
    this._bpm = 120;
    this._originalBpm = 120;

    this.onTimeUpdate = null; // callback(currentTime)
    this.onPlaybackEnd = null;
  }

  async init() {
    this.ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    this._buildMasterChain();
    return this.ctx;
  }

  _buildMasterChain() {
    const ctx = this.ctx;

    // 5-band master EQ
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 80;
    const eqLowMid = ctx.createBiquadFilter();
    eqLowMid.type = 'peaking'; eqLowMid.frequency.value = 300; eqLowMid.Q.value = 1;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1;
    const eqHighMid = ctx.createBiquadFilter();
    eqHighMid.type = 'peaking'; eqHighMid.frequency.value = 4000; eqHighMid.Q.value = 1;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 10000;

    const masterCompressor = ctx.createDynamicsCompressor();
    masterCompressor.threshold.value = -24;
    masterCompressor.knee.value = 8;
    masterCompressor.ratio.value = 3;
    masterCompressor.attack.value = 0.003;
    masterCompressor.release.value = 0.25;

    const masterLimiter = ctx.createDynamicsCompressor();
    masterLimiter.threshold.value = -0.3;
    masterLimiter.knee.value = 0;
    masterLimiter.ratio.value = 20;
    masterLimiter.attack.value = 0.001;
    masterLimiter.release.value = 0.1;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;

    const masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 2048;

    // Chain
    eqLow.connect(eqLowMid);
    eqLowMid.connect(eqMid);
    eqMid.connect(eqHighMid);
    eqHighMid.connect(eqHigh);
    eqHigh.connect(masterCompressor);
    masterCompressor.connect(masterLimiter);
    masterLimiter.connect(masterGain);
    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);

    this.masterEQ = { eqLow, eqLowMid, eqMid, eqHighMid, eqHigh };
    this.masterCompressor = masterCompressor;
    this.masterLimiter = masterLimiter;
    this.masterGain = masterGain;
    this.masterAnalyser = masterAnalyser;
    this._masterChainInput = eqLow;
  }

  // Create nodes for a track and connect to master chain
  createTrackNodes(track) {
    const ctx = this.ctx;

    const gainNode = ctx.createGain();
    gainNode.gain.value = track.volume ?? 1;

    const panNode = ctx.createStereoPanner();
    panNode.pan.value = track.pan ?? 0;

    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 200;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000;

    const convolver = ctx.createConvolver();
    const reverbDry = ctx.createGain(); reverbDry.gain.value = 1;
    const reverbWet = ctx.createGain(); reverbWet.gain.value = 0;
    const reverbMix = ctx.createGain(); reverbMix.gain.value = 1;

    const sweepFilter = ctx.createBiquadFilter();
    sweepFilter.type = 'lowpass'; sweepFilter.frequency.value = 20000;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    // Set reverb IR
    const irBuf = SF2Effects.createImpulseResponse(ctx, 2, 2);
    convolver.buffer = irBuf;

    // Signal chain:
    // gainNode → panNode → eqLow → eqMid → eqHigh → reverbDry/wet merge → sweepFilter → analyser → master
    gainNode.connect(panNode);
    panNode.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(reverbDry);
    eqHigh.connect(convolver);
    convolver.connect(reverbWet);
    reverbDry.connect(reverbMix);
    reverbWet.connect(reverbMix);
    reverbMix.connect(sweepFilter);
    sweepFilter.connect(analyser);
    analyser.connect(this._masterChainInput);

    return { gainNode, panNode, eqLow, eqMid, eqHigh, convolver, reverbDry, reverbWet, reverbMix, sweepFilter, analyser };
  }

  disconnectTrackNodes(nodes) {
    if (!nodes) return;
    Object.values(nodes).forEach(n => { try { n.disconnect(); } catch(e) {} });
  }

  play(tracks, offset = 0) {
    if (this._isPlaying) this.stop();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this._playOffset = offset;
    this._playStartTime = this.ctx.currentTime;
    this._isPlaying = true;

    for (const track of tracks) {
      if (track.muted || !track.nodes) continue;
      const isSoloed = tracks.some(t => t.solo);
      if (isSoloed && !track.solo) continue;

      const sources = [];
      for (const clip of track.clips || []) {
        if (clip.startTime + clip.duration < offset) continue;
        if (clip.startTime > (this._loopEnabled ? this._loopEnd : Infinity)) continue;

        const src = this.ctx.createBufferSource();
        src.buffer = clip.buffer;
        const bpmRatio = this._bpm / this._originalBpm;
        src.playbackRate.value = bpmRatio;

        const clipGain = this.ctx.createGain();
        clipGain.gain.value = clip._gain ?? 1;
        src.connect(clipGain);
        clipGain.connect(track.nodes.gainNode);

        const clipStart = clip.startTime;
        const clipOffset = clip.offset ?? 0;
        let when, intraOffset, dur;

        if (offset > clipStart) {
          when = this.ctx.currentTime;
          intraOffset = (offset - clipStart) / bpmRatio + clipOffset;
          dur = (clip.duration - (offset - clipStart)) / bpmRatio;
        } else {
          when = this.ctx.currentTime + (clipStart - offset) / bpmRatio;
          intraOffset = clipOffset;
          dur = clip.duration / bpmRatio;
        }

        if (dur <= 0) continue;
        src.start(when, intraOffset, dur);
        sources.push({ src, clipGain });
      }
      if (sources.length > 0) this._activeSources.set(track.id, sources);
    }

    this._startTimeUpdate();
  }

  stop() {
    this._isPlaying = false;
    if (this._animFrameId) { cancelAnimationFrame(this._animFrameId); this._animFrameId = null; }

    for (const sources of this._activeSources.values()) {
      for (const { src, clipGain } of sources) {
        try { src.stop(); } catch(e) {}
        try { src.disconnect(); clipGain.disconnect(); } catch(e) {}
      }
    }
    this._activeSources.clear();
  }

  get currentTime() {
    if (!this._isPlaying) return this._playOffset;
    return this._playOffset + (this.ctx.currentTime - this._playStartTime);
  }

  seekTo(time) {
    this._playOffset = time;
    if (this._isPlaying) {
      // Will be restarted by the DAW with new offset
    }
  }

  _startTimeUpdate() {
    const tick = () => {
      if (!this._isPlaying) return;
      let t = this.currentTime;
      if (this._loopEnabled && t >= this._loopEnd) {
        // Loop back
        this.stop();
        this._playOffset = this._loopStart;
        this._pendingLoop = true;
        if (this.onLoopRestart) this.onLoopRestart(this._loopStart);
        return;
      }
      if (this.onTimeUpdate) this.onTimeUpdate(t);
      this._animFrameId = requestAnimationFrame(tick);
    };
    this._animFrameId = requestAnimationFrame(tick);
  }

  // Render mix offline
  async renderOffline(tracks, duration, sampleRate = 44100, onProgress) {
    const ch = 2;
    const len = Math.ceil(duration * sampleRate);
    const offCtx = new OfflineAudioContext(ch, len, sampleRate);

    // Build master chain in offline context
    const offEQ = offCtx.createBiquadFilter(); offEQ.type = 'lowshelf'; offEQ.frequency.value = 80;
    const offComp = offCtx.createDynamicsCompressor();
    offComp.threshold.value = this.masterCompressor.threshold.value;
    offComp.ratio.value = this.masterCompressor.ratio.value;
    offComp.attack.value = this.masterCompressor.attack.value;
    offComp.release.value = this.masterCompressor.release.value;
    const offLimiter = offCtx.createDynamicsCompressor();
    offLimiter.threshold.value = this.masterLimiter.threshold.value;
    offLimiter.ratio.value = 20;
    offLimiter.attack.value = 0.001;
    offLimiter.release.value = 0.1;
    const offMasterGain = offCtx.createGain();
    offMasterGain.gain.value = this.masterGain.gain.value;

    offEQ.connect(offComp);
    offComp.connect(offLimiter);
    offLimiter.connect(offMasterGain);
    offMasterGain.connect(offCtx.destination);

    const bpmRatio = this._bpm / this._originalBpm;

    for (const track of tracks) {
      if (track.muted || !track.clips || track.clips.length === 0) continue;

      // Create offline track nodes
      const gainNode = offCtx.createGain(); gainNode.gain.value = track.volume ?? 1;
      const panNode = offCtx.createStereoPanner(); panNode.pan.value = track.pan ?? 0;
      const offEQLow = offCtx.createBiquadFilter(); offEQLow.type = 'lowshelf'; offEQLow.frequency.value = 200;
      offEQLow.gain.value = track.nodes?.eqLow?.gain?.value ?? 0;
      const offEQMid = offCtx.createBiquadFilter(); offEQMid.type = 'peaking'; offEQMid.frequency.value = 1000;
      offEQMid.gain.value = track.nodes?.eqMid?.gain?.value ?? 0;
      const offEQHigh = offCtx.createBiquadFilter(); offEQHigh.type = 'highshelf'; offEQHigh.frequency.value = 4000;
      offEQHigh.gain.value = track.nodes?.eqHigh?.gain?.value ?? 0;

      gainNode.connect(panNode);
      panNode.connect(offEQLow);
      offEQLow.connect(offEQMid);
      offEQMid.connect(offEQHigh);
      offEQHigh.connect(offEQ);

      for (const clip of track.clips) {
        const src = offCtx.createBufferSource();
        src.buffer = clip.buffer;
        src.playbackRate.value = bpmRatio;
        const clipGain = offCtx.createGain();
        clipGain.gain.value = clip._gain ?? 1;
        src.connect(clipGain);
        clipGain.connect(gainNode);
        const when = clip.startTime / bpmRatio;
        const dur = clip.duration / bpmRatio;
        src.start(when, clip.offset ?? 0, dur);
      }
    }

    if (onProgress) {
      const interval = setInterval(() => {
        const pct = offCtx.currentTime / duration;
        onProgress(Math.min(pct, 0.99));
      }, 200);
      const result = await offCtx.startRendering();
      clearInterval(interval);
      if (onProgress) onProgress(1);
      return result;
    }
    return offCtx.startRendering();
  }

  setBPM(bpm) { this._bpm = bpm; }
  setOriginalBPM(bpm) { this._originalBpm = bpm; }
  setLoop(enabled, start = 0, end = Infinity) {
    this._loopEnabled = enabled;
    this._loopStart = start;
    this._loopEnd = end;
  }

  setMasterVolume(v) { if (this.masterGain) this.masterGain.gain.setTargetAtTime(v, 0, 0.01); }
  setMasterEQ(band, value) {
    const node = this.masterEQ[band];
    if (node) node.gain.setTargetAtTime(value, 0, 0.01);
  }
}

window.SF2AudioEngine = { AudioEngine };
