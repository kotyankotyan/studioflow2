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
        // BPM is informational (tempo display). We do NOT varispeed playback,
        // because changing playbackRate also shifts pitch — surprising for a
        // "tempo" control. (True pitch-preserving stretch needs a phase vocoder.)
        const bpmRatio = 1;
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
        sources.push({ src, clipGain, clipId: clip.id });
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

  // Render mix offline — mirrors the LIVE signal chain so the exported file
  // matches what you hear: per-track 3-band EQ + reverb (convolver) + sweep,
  // then the 5-band master EQ, compressor, limiter, master gain, and finally
  // stereo-width via mid/side processing.
  async renderOffline(tracks, duration, sampleRate = 44100, onProgress) {
    const ch = 2;
    const len = Math.ceil(duration * sampleRate);
    const offCtx = new OfflineAudioContext(ch, len, sampleRate);

    // --- Master chain (5-band EQ → comp → limiter → gain), mirroring live ---
    const eqDefs = [
      ['eqLow', 'lowshelf', 80], ['eqLowMid', 'peaking', 300], ['eqMid', 'peaking', 1000],
      ['eqHighMid', 'peaking', 4000], ['eqHigh', 'highshelf', 10000],
    ];
    const mEQ = eqDefs.map(([key, type, freq]) => {
      const n = offCtx.createBiquadFilter();
      n.type = type; n.frequency.value = freq;
      if (type === 'peaking') n.Q.value = 1;
      n.gain.value = this.masterEQ?.[key]?.gain?.value ?? 0;
      return n;
    });
    const offComp = offCtx.createDynamicsCompressor();
    offComp.threshold.value = this.masterCompressor.threshold.value;
    offComp.knee.value = this.masterCompressor.knee.value;
    offComp.ratio.value = this.masterCompressor.ratio.value;
    offComp.attack.value = this.masterCompressor.attack.value;
    offComp.release.value = this.masterCompressor.release.value;
    const offLimiter = offCtx.createDynamicsCompressor();
    offLimiter.threshold.value = this.masterLimiter.threshold.value;
    offLimiter.knee.value = 0; offLimiter.ratio.value = 20;
    offLimiter.attack.value = 0.001; offLimiter.release.value = 0.1;
    const offMasterGain = offCtx.createGain();
    offMasterGain.gain.value = this.masterGain.gain.value;

    for (let i = 0; i < mEQ.length - 1; i++) mEQ[i].connect(mEQ[i + 1]);
    mEQ[mEQ.length - 1].connect(offComp);
    offComp.connect(offLimiter);
    offLimiter.connect(offMasterGain);
    offMasterGain.connect(offCtx.destination);
    const masterIn = mEQ[0];

    // Shared reverb impulse response for this render
    const irBuf = (typeof SF2Effects !== 'undefined')
      ? SF2Effects.createImpulseResponse(offCtx, 2, 2) : null;

    const bpmRatio = 1; // no varispeed on export (see play())
    const isSoloed = tracks.some(t => t.solo);

    for (const track of tracks) {
      if (track.muted || !track.clips || track.clips.length === 0) continue;
      if (isSoloed && !track.solo) continue;

      const gainNode = offCtx.createGain(); gainNode.gain.value = track.volume ?? 1;
      const panNode = offCtx.createStereoPanner(); panNode.pan.value = track.pan ?? 0;
      const eqLow = offCtx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 200;
      eqLow.gain.value = track.nodes?.eqLow?.gain?.value ?? 0;
      const eqMid = offCtx.createBiquadFilter(); eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1;
      eqMid.gain.value = track.nodes?.eqMid?.gain?.value ?? 0;
      const eqHigh = offCtx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000;
      eqHigh.gain.value = track.nodes?.eqHigh?.gain?.value ?? 0;

      // reverb dry/wet (mirror live convolver mix). Use the stored track.reverb
      // amount — reading the live AudioParam .value is unreliable right after a
      // setTargetAtTime ramp.
      const wetAmt = (track.reverb != null) ? track.reverb : (track.nodes?.reverbWet?.gain?.value ?? 0);
      const reverbDry = offCtx.createGain(); reverbDry.gain.value = 1 - wetAmt * 0.5;
      const reverbWet = offCtx.createGain(); reverbWet.gain.value = wetAmt;
      const reverbMix = offCtx.createGain();
      const sweep = offCtx.createBiquadFilter();
      sweep.type = 'lowpass';
      sweep.frequency.value = track.nodes?.sweepFilter?.frequency?.value ?? 20000;

      gainNode.connect(panNode);
      panNode.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
      eqHigh.connect(reverbDry); reverbDry.connect(reverbMix);
      if (irBuf && reverbWet.gain.value > 0.0001) {
        const conv = offCtx.createConvolver(); conv.buffer = irBuf;
        eqHigh.connect(conv); conv.connect(reverbWet); reverbWet.connect(reverbMix);
      }
      reverbMix.connect(sweep);
      sweep.connect(masterIn);

      // Apply automation lanes (drawn in the automation panel) to the offline
      // params so curves are baked into the export, mirroring live playback.
      const auto = track.automation;
      const schedule = (param, lane, map) => {
        if (!lane || !lane.points || lane.points.length === 0) return;
        const pts = lane.points;
        param.setValueAtTime(map(pts[0].value), 0);
        for (const p of pts) param.linearRampToValueAtTime(map(p.value), Math.max(0, p.time / bpmRatio));
      };
      if (auto) {
        schedule(gainNode.gain, auto.volume, v => v * 1.5);
        schedule(panNode.pan, auto.pan, v => v * 2 - 1);
        schedule(eqMid.gain, auto.eq, v => v * 24 - 12);
        schedule(reverbWet.gain, auto.reverb, v => v);
        schedule(sweep.frequency, auto.filter, v => 200 * Math.pow(100, v));
      }

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

    let result;
    if (onProgress) {
      const interval = setInterval(() => onProgress(Math.min(offCtx.currentTime / duration, 0.99)), 200);
      result = await offCtx.startRendering();
      clearInterval(interval);
      onProgress(1);
    } else {
      result = await offCtx.startRendering();
    }

    // Stereo width via mid/side (post-process), mirroring the mastering panel.
    const width = this._stereoWidth ?? 1;
    if (ch === 2 && Math.abs(width - 1) > 0.001) {
      const L = result.getChannelData(0), R = result.getChannelData(1);
      for (let i = 0; i < L.length; i++) {
        const mid = (L[i] + R[i]) * 0.5, side = (L[i] - R[i]) * 0.5 * width;
        L[i] = mid + side; R[i] = mid - side;
      }
    }
    return result;
  }

  // Mono compatibility check: force the master bus to downmix to mono
  // (channelCount=1 explicit sums L+R per the Web Audio spec). Listening aid
  // only — exports are unaffected.
  setMonoCheck(on) {
    const g = this.masterGain;
    if (!g) return;
    if (on) { g.channelCountMode = 'explicit'; g.channelCount = 1; }
    else { g.channelCountMode = 'max'; g.channelCount = 2; }
    this._monoCheck = !!on;
  }

  setStereoWidth(w) { this._stereoWidth = w; }
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
