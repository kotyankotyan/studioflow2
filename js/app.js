// app.js - StudioFlow 2 main DAW class. Wires the UI (index.html) to the
// SF2* feature modules. The single instance lives at window.daw, created
// inside startApp() after a successful login.

const $ = id => document.getElementById(id);
// Escape user-controlled strings (file names) before inserting into innerHTML.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PART_COLORS = { vocal: '#ec4899', drums: '#eab308', bass: '#22c55e', other: '#a855f7' };
const PART_LABELS = { vocal: 'ボーカル', drums: 'ドラム', bass: 'ベース', other: 'その他' };
const PX_PER_SEC_BASE = 80; // timeline scale at zoom 1

class StudioFlowDAW2 {
  constructor() {
    this.engine = new SF2AudioEngine.AudioEngine();
    this.mastering = null;            // MasteringChain, built after ctx init
    this.tracks = [];
    this.selectedTrackId = null;
    this.selectedClipId = null;
    this.tool = 'select';
    this.zoom = 1;
    this.originalBuffers = new Map();  // trackId → pristine buffer (原曲比較/初期化)
    this.bpm = 120;
    this.originalBpm = 120;
    this.key = '--';
    this._idSeq = 1;

    this._undoStack = [];
    this._redoStack = [];

    this._vuRafId = null;
  }

  async init() {
    await this.engine.init();
    this.mastering = new SF2Mastering.MasteringChain(this.engine.ctx);
    this.engine.onTimeUpdate = t => this._onTimeUpdate(t);
    this.engine.onLoopRestart = start => this._restartFromLoop(start);

    this._bindGlobal();
    this._bindTransport();
    this._bindLoaders();
    this._bindTools();
    this._bindBottomTabs();
    this._bindEasyMode();
    this._bindModals();
    this._bindKeyboard();

    this._renderMixer();
    this._renderMastering();
    this._renderVocal();
    this._renderAutomation();
    this._renderRemix();
    this._renderProTools();
    this.applyMastering();   // 既定マスタリング状態をエンジンへ反映
    this._startMeters();

    await this._tryRestore();
  }

  // ---------- ID / utility ----------
  _nextId(prefix = 'id') { return `${prefix}_${this._idSeq++}_${Date.now().toString(36)}`; }

  static fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 1000);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  get pxPerSec() { return PX_PER_SEC_BASE * this.zoom; }

  get projectDuration() {
    let max = 0;
    for (const t of this.tracks) {
      for (const c of t.clips) max = Math.max(max, c.startTime + c.duration);
    }
    return max;
  }

  toast(msg) {
    let el = $('sf2-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sf2-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---------- audio file loading ----------
  async _decodeFile(file) {
    const arr = await file.arrayBuffer();
    return this.engine.ctx.decodeAudioData(arr);
  }

  guessPart(name) {
    const n = name.toLowerCase();
    if (/(vocal|vox|voice|歌|ボーカル)/.test(n)) return 'vocal';
    if (/(drum|beat|perc|kick|snare|ドラム)/.test(n)) return 'drums';
    if (/(bass|低音|ベース)/.test(n)) return 'bass';
    return 'other';
  }

  async loadFiles(fileList, { append = false } = {}) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name));
    if (files.length === 0) return;
    if (!append && this.tracks.length === 0) this._pushUndo();

    let firstBuffer = null;
    for (const file of files) {
      let buffer;
      try { buffer = await this._decodeFile(file); }
      catch (e) { this.toast(`読込失敗: ${file.name}`); continue; }
      if (!firstBuffer) firstBuffer = buffer;
      const part = this.guessPart(file.name);
      this.addTrack({ name: file.name.replace(/\.[^.]+$/, ''), part, buffer });
    }

    // Auto-detect BPM/KEY from the first loaded buffer
    if (firstBuffer && this.tracks.length) {
      try {
        this.originalBpm = SF2ProTools.detectBPM(firstBuffer) || 120;
        this.bpm = this.originalBpm;
        this.engine.setOriginalBPM(this.originalBpm);
        this.engine.setBPM(this.bpm);
        this.key = SF2ProTools.detectKey(firstBuffer);
      } catch (e) { /* detection best-effort */ }
    }

    this._refreshAll();
    this._setStep('adjust');
    this._saveProject();
  }

  addTrack({ name, part = 'other', buffer }) {
    const track = {
      id: this._nextId('trk'),
      name,
      part,
      color: PART_COLORS[part] || PART_COLORS.other,
      volume: 1, pan: 0, muted: false, solo: false, reverb: 0,
      nodes: null,
      clips: [],
      fxClips: [],
    };
    track.nodes = this.engine.createTrackNodes(track);
    if (buffer) {
      const clip = {
        id: this._nextId('clip'),
        name,
        buffer,
        startTime: 0,
        duration: buffer.duration,
        offset: 0,
        _gain: 1,
        _saved: false,
      };
      track.clips.push(clip);
      this.originalBuffers.set(track.id, buffer);
    }
    this.tracks.push(track);
    this.engine.tracks = this.tracks;
    return track;
  }

  getTrack(id) { return this.tracks.find(t => t.id === id); }
  getClip(trackId, clipId) {
    const t = this.getTrack(trackId);
    return t && t.clips.find(c => c.id === clipId);
  }

  // ---------- transport ----------
  _bindTransport() {
    $('btn-play').onclick = () => this.togglePlay();
    $('btn-stop').onclick = () => this.stop();
    $('btn-rewind').onclick = () => this.seek(0);
    $('btn-forward').onclick = () => this.seek(this.projectDuration);
    $('btn-loop').onclick = () => this.toggleLoop();
    $('btn-zoom-in').onclick = () => this.setZoom(this.zoom * 1.3);
    $('btn-zoom-out').onclick = () => this.setZoom(this.zoom / 1.3);
    $('btn-undo').onclick = () => this.undo();
    $('btn-redo').onclick = () => this.redo();
    $('bpm-input').onchange = e => this.setBPM(parseFloat(e.target.value));
  }

  togglePlay() {
    if (this.engine._isPlaying) this.pause();
    else this.play();
  }

  // Keep both transport play buttons (pro top-bar + easy top-bar) in sync.
  _syncPlayButtons(playing) {
    const icon = playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    const p = $('btn-play'), e = $('btn-easy-play');
    if (p) p.innerHTML = icon;
    if (e) e.innerHTML = icon;
  }

  play() {
    if (this.tracks.length === 0) { this.toast('先に楽曲を読み込んでください'); return; }
    this.engine.tracks = this.tracks;
    this.engine.play(this.tracks, this.engine.currentTime);
    this._syncPlayButtons(true);
    $('pro-mode').classList.add('playing');
  }

  pause() {
    const t = this.engine.currentTime;
    this.engine.stop();
    this.engine._playOffset = t;
    this._syncPlayButtons(false);
    $('pro-mode').classList.remove('playing');
  }

  stop() {
    this.engine.stop();
    this.engine._playOffset = 0;
    this._syncPlayButtons(false);
    $('pro-mode').classList.remove('playing');
    this._onTimeUpdate(0);
  }

  seek(time) {
    const wasPlaying = this.engine._isPlaying;
    this.engine.stop();
    this.engine.seekTo(Math.max(0, Math.min(time, this.projectDuration)));
    this._onTimeUpdate(this.engine.currentTime);
    if (wasPlaying) this.play();
  }

  toggleLoop() {
    const on = !this.engine._loopEnabled;
    this.engine.setLoop(on, 0, this.projectDuration);
    $('btn-loop').classList.toggle('active', on);
  }

  _restartFromLoop(start) {
    this.engine.play(this.tracks, start);
  }

  setBPM(bpm) {
    if (!isFinite(bpm) || bpm < 20) return;
    this.bpm = bpm;
    this.engine.setBPM(bpm);
    $('bpm-input').value = bpm;
    // BPM is a tempo display value only — it no longer warps playback speed/pitch.
  }

  setZoom(z) {
    this.zoom = Math.max(0.2, Math.min(8, z));
    this._renderTracks();
  }

  _onTimeUpdate(t) {
    const ts = StudioFlowDAW2.fmtTime(t);
    $('current-time').textContent = ts;
    $('total-time').textContent = StudioFlowDAW2.fmtTime(this.projectDuration);
    const et = $('easy-time');
    if (et) et.textContent = ts;
    const ph = $('playhead');
    if (ph) {
      ph.style.left = (180 + t * this.pxPerSec) + 'px';
    }
    if (!this.engine._isPlaying && t === 0) this._syncPlayButtons(false);
  }

  // ---------- track / clip rendering (pro mode) ----------
  _bindTools() {
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tool = btn.dataset.tool;
      };
    });
  }

  _renderTracks() {
    const ruler = $('timeline-ruler');
    const cont = $('tracks-container');
    if (!cont) return;
    const dur = Math.max(this.projectDuration, 30);
    const w = dur * this.pxPerSec;

    // Ruler
    ruler.innerHTML = '';
    ruler.style.paddingLeft = '180px';
    for (let s = 0; s <= dur; s += 5) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = (180 + s * this.pxPerSec) + 'px';
      tick.textContent = StudioFlowDAW2.fmtTime(s).slice(0, 5);
      ruler.appendChild(tick);
    }

    cont.innerHTML = '';
    for (const track of this.tracks) {
      const row = document.createElement('div');
      row.className = 'track-row';
      if (track.id === this.selectedTrackId) row.classList.add('selected');

      const head = document.createElement('div');
      head.className = 'track-head';
      head.style.borderLeftColor = track.color;
      head.innerHTML = `
        <div class="track-head-top">
          <div class="track-title" title="${esc(track.name)}">${esc(track.name)}</div>
          <button class="th-btn del" title="このトラック（曲）を削除"><i class="fas fa-trash"></i></button>
        </div>
        <div class="track-head-ctrls">
          <button class="th-btn mute ${track.muted ? 'on' : ''}" title="ミュート（この曲だけ消音）">M</button>
          <button class="th-btn solo ${track.solo ? 'on' : ''}" title="ソロ（この曲だけ再生）">S</button>
          <input type="range" class="th-vol" min="0" max="1.5" step="0.01" value="${track.volume}" title="音量">
        </div>`;
      head.onclick = () => { this.selectedTrackId = track.id; this._renderTracks(); this._renderEffectsPanel(); };
      head.querySelector('.del').onclick = e => { e.stopPropagation(); this.deleteTrack(track.id); };
      head.querySelector('.mute').onclick = e => { e.stopPropagation(); this.toggleMute(track.id); };
      head.querySelector('.solo').onclick = e => { e.stopPropagation(); this.toggleSolo(track.id); };
      head.querySelector('.th-vol').oninput = e => { e.stopPropagation(); this.setTrackVolume(track.id, parseFloat(e.target.value)); };

      const lane = document.createElement('div');
      lane.className = 'track-lane';
      lane.style.width = w + 'px';

      for (const clip of track.clips) {
        lane.appendChild(this._renderClip(track, clip));
      }
      row.appendChild(head);
      row.appendChild(lane);
      cont.appendChild(row);
    }
  }

  _renderClip(track, clip) {
    const el = document.createElement('div');
    el.className = 'clip';
    if (clip.id === this.selectedClipId) el.classList.add('selected');
    el.style.left = (clip.startTime * this.pxPerSec) + 'px';
    el.style.width = (clip.duration * this.pxPerSec) + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(clip.duration * this.pxPerSec));
    canvas.height = 56;
    el.appendChild(canvas);
    requestAnimationFrame(() => SF2Waveform.drawWaveformFilled(canvas, clip.buffer, track.color, 'transparent'));

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = clip.name;
    el.appendChild(label);

    el.onclick = e => {
      e.stopPropagation();
      if (this.tool === 'cut') {
        const rect = el.getBoundingClientRect();
        const localT = (e.clientX - rect.left) / this.pxPerSec;
        this.cutClip(track.id, clip.id, clip.startTime + localT);
      } else {
        this.selectedTrackId = track.id;
        this.selectedClipId = clip.id;
        this._renderTracks();
        this._renderPropertiesPanel();
      }
    };
    return el;
  }

  // ---------- clip editing ----------
  cutClip(trackId, clipId, atTime) {
    const track = this.getTrack(trackId);
    const clip = this.getClip(trackId, clipId);
    if (!clip) return;
    const splitOffset = atTime - clip.startTime;
    if (splitOffset <= 0.01 || splitOffset >= clip.duration - 0.01) return;
    this._pushUndo();

    const right = {
      id: this._nextId('clip'),
      name: clip.name,
      buffer: clip.buffer,                 // shared buffer
      startTime: clip.startTime + splitOffset,
      duration: clip.duration - splitOffset,
      offset: (clip.offset ?? 0) + splitOffset,
      _gain: clip._gain ?? 1,
      _saved: false,
    };
    clip.duration = splitOffset;
    const idx = track.clips.indexOf(clip);
    track.clips.splice(idx + 1, 0, right);
    this._renderTracks();
    this._saveProject();
  }

  deleteTrack(id) {
    const t = this.getTrack(id);
    if (!t) return;
    if (!confirm(`「${t.name}」を削除しますか？（元に戻すは Ctrl+Z）`)) return;
    this._pushUndo();
    this.engine.disconnectTrackNodes(t.nodes);
    this.tracks = this.tracks.filter(x => x.id !== id);
    this.originalBuffers.delete(id);
    if (this.selectedTrackId === id) { this.selectedTrackId = null; this.selectedClipId = null; }
    this.engine.tracks = this.tracks;
    this._refreshPlaybackIfActive();
    this._refreshAll();
    this._saveProject();
    this.toast('トラックを削除しました');
  }

  deleteSelectedClip() {
    if (!this.selectedClipId) return;
    const track = this.getTrack(this.selectedTrackId);
    if (!track) return;
    this._pushUndo();
    track.clips = track.clips.filter(c => c.id !== this.selectedClipId);
    this.selectedClipId = null;
    this._refreshAll();
    this._saveProject();
  }

  setClipGain(trackId, clipId, gain) {
    const clip = this.getClip(trackId, clipId);
    if (!clip) return;
    clip._gain = gain;
    this._refreshPlaybackIfActive();
  }

  // ---------- track controls ----------
  toggleMute(id) {
    const t = this.getTrack(id);
    this._pushUndo();
    t.muted = !t.muted;
    this._refreshPlaybackIfActive();
    this._renderTracks(); this._renderMixer();
  }
  toggleSolo(id) {
    const t = this.getTrack(id);
    this._pushUndo();
    t.solo = !t.solo;
    this._refreshPlaybackIfActive();
    this._renderTracks(); this._renderMixer();
  }
  setTrackVolume(id, v) {
    const t = this.getTrack(id);
    t.volume = v;
    if (t.nodes) t.nodes.gainNode.gain.setTargetAtTime(v, 0, 0.01);
    // NOTE: do NOT re-render the mixer here — it would destroy the fader/slider
    // element while the user is dragging it, breaking the drag interaction.
  }
  setTrackPan(id, p) {
    const t = this.getTrack(id);
    t.pan = p;
    if (t.nodes) t.nodes.panNode.pan.setTargetAtTime(p, 0, 0.01);
  }
  setTrackEQ(id, band, db) {
    const t = this.getTrack(id);
    if (t && t.nodes && t.nodes[band]) t.nodes[band].gain.setTargetAtTime(db, 0, 0.01);
  }
  setTrackReverb(id, amount) {
    const t = this.getTrack(id);
    if (!t) return;
    t.reverb = amount;     // stored state — used by export & persistence
    if (t.nodes) {
      t.nodes.reverbWet.gain.setTargetAtTime(amount, 0, 0.01);
      t.nodes.reverbDry.gain.setTargetAtTime(1 - amount * 0.5, 0, 0.01);
    }
  }
  _refreshPlaybackIfActive() {
    if (this.engine._isPlaying) {
      const pos = this.engine.currentTime;   // keep the live position…
      this.engine.stop();
      this.engine._playOffset = pos;         // …and resume from there (not from the top)
      this.play();
    }
  }

  // ---------- properties / effects side panels ----------
  _renderPropertiesPanel() {
    const body = $('properties-body');
    const clip = this.getClip(this.selectedTrackId, this.selectedClipId);
    if (!clip) { body.innerHTML = '<p class="empty-hint">クリップを選択してください</p>'; return; }
    body.innerHTML = `
      <div class="prop-row"><label>名前</label><input type="text" id="prop-name" value="${esc(clip.name)}"></div>
      <div class="prop-row"><label>開始 (s)</label><input type="number" id="prop-start" step="0.01" value="${clip.startTime.toFixed(2)}"></div>
      <div class="prop-row"><label>長さ (s)</label><span>${clip.duration.toFixed(2)}</span></div>
      <div class="prop-row"><label>ゲイン</label><input type="range" id="prop-gain" min="0" max="2" step="0.01" value="${clip._gain ?? 1}"></div>
      <button id="prop-delete" class="action-btn danger"><i class="fas fa-trash"></i> 削除</button>`;
    $('prop-name').onchange = e => { clip.name = e.target.value; this._renderTracks(); };
    $('prop-start').onchange = e => { this._pushUndo(); clip.startTime = parseFloat(e.target.value) || 0; this._renderTracks(); this._saveProject(); };
    $('prop-gain').oninput = e => this.setClipGain(this.selectedTrackId, this.selectedClipId, parseFloat(e.target.value));
    $('prop-delete').onclick = () => this.deleteSelectedClip();
  }

  _renderEffectsPanel() {
    const body = $('effects-body');
    const t = this.getTrack(this.selectedTrackId);
    if (!t) { body.innerHTML = '<p class="empty-hint">トラックを選択してください</p>'; return; }
    body.innerHTML = `
      <div class="fx-title" style="color:${t.color}">${esc(t.name)}</div>
      ${this._eqSlider('eqLow', 'EQ Low', t)}
      ${this._eqSlider('eqMid', 'EQ Mid', t)}
      ${this._eqSlider('eqHigh', 'EQ High', t)}
      <div class="prop-row"><label>パン</label><input type="range" id="fx-pan" min="-1" max="1" step="0.01" value="${t.pan}"></div>
      <div class="prop-row"><label>リバーブ</label><input type="range" id="fx-rev" min="0" max="1" step="0.01" value="${t.reverb ?? 0}"></div>`;
    ['eqLow', 'eqMid', 'eqHigh'].forEach(band => {
      $('fx-' + band).oninput = e => this.setTrackEQ(t.id, band, parseFloat(e.target.value));
    });
    $('fx-pan').oninput = e => this.setTrackPan(t.id, parseFloat(e.target.value));
    $('fx-rev').oninput = e => this.setTrackReverb(t.id, parseFloat(e.target.value));
  }

  _eqSlider(band, label, t) {
    const v = t.nodes?.[band]?.gain?.value ?? 0;
    return `<div class="prop-row"><label>${label}</label><input type="range" id="fx-${band}" min="-12" max="12" step="0.5" value="${v}"></div>`;
  }

  // ---------- loaders / tools ----------
  _bindLoaders() {
    const input = $('pro-file-input');
    const trigger = (append) => { this._loadAppend = append; input.value = ''; input.click(); };
    $('btn-load-single').onclick = () => trigger(false);
    $('btn-load-multi').onclick = () => trigger(false);
    $('btn-load-add').onclick = () => trigger(true);
    input.onchange = e => this.loadFiles(e.target.files, { append: this._loadAppend });

    $('btn-ai-separate').onclick = () => this._aiSeparate();
    $('btn-ai-midi').onclick = () => this._aiMidi();
    $('btn-ai-vocal').onclick = () => { this._switchBottom('vocal'); };
    $('btn-pro-reset').onclick = () => this.resetToOriginal();
  }

  async _aiSeparate() {
    const t = this.getTrack(this.selectedTrackId) || this.tracks[0];
    if (!t || !t.clips[0]) { this.toast('トラックを選択してください'); return; }
    if (t.clips[0].buffer.numberOfChannels < 2) { this.toast('分離はステレオ音源のみ対応です'); return; }
    // Near-mono sources have no spatial cue for center extraction — warn honestly.
    const corr = SF2StemSeparator.stereoCorrelation(t.clips[0].buffer);
    if (corr > 0.96) {
      if (!confirm(`この曲は左右の広がりが狭く“ほぼモノラル”です（相関 ${corr.toFixed(2)}）。\nこの方式はステレオの空間差で分離するため、モノラル寄りの曲では十分に分離できません。\nそれでも実行しますか？`)) return;
    }
    const btn = $('btn-ai-separate');
    btn.disabled = true;
    this.toast('音源分離中... 0%');
    try {
      const { vocals, instrumental } = await SF2StemSeparator.separateVocalInstrumental(
        t.clips[0].buffer, this.sepStrength ?? 0.6, pct => this.toast(`音源分離中... ${Math.round(pct * 100)}%`));
      this._pushUndo();
      this.addTrack({ name: `${t.name} - ボーカル`, part: 'vocal', buffer: vocals });
      this.addTrack({ name: `${t.name} - 伴奏`, part: 'other', buffer: instrumental });
      this._refreshAll();
      this._saveProject();
      this.toast('ボーカル / 伴奏 の2トラックに分離しました');
    } catch (e) { this.toast('分離失敗: ' + e.message); }
    finally { btn.disabled = false; }
  }

  _aiMidi() {
    const t = this.getTrack(this.selectedTrackId) || this.tracks[0];
    if (!t || !t.clips[0]) { this.toast('トラックを選択してください'); return; }
    try {
      const events = SF2StemSeparator.extractMIDIEvents(t.clips[0].buffer);
      const bytes = SF2StemSeparator.exportMIDI(events, Math.round(this.bpm));
      SF2ExportManager.download(new Blob([bytes], { type: 'audio/midi' }), `${t.name}.mid`);
      this.toast('MIDI書き出し完了');
    } catch (e) { this.toast('MIDI変換失敗: ' + e.message); }
  }

  // ---------- bottom panel tabs ----------
  _bindBottomTabs() {
    document.querySelectorAll('.bottom-tab').forEach(tab => {
      tab.onclick = () => this._switchBottom(tab.dataset.panel);
    });
    // resize handle
    const handle = $('bottom-resize-handle');
    const panel = $('bottom-panel');
    let dragging = false, startY = 0, startH = 0;
    handle.addEventListener('mousedown', e => { dragging = true; startY = e.clientY; startH = panel.offsetHeight; e.preventDefault(); });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const h = Math.max(120, Math.min(window.innerHeight - 200, startH + (startY - e.clientY)));
      panel.style.height = h + 'px';
    });
    window.addEventListener('mouseup', () => dragging = false);
  }

  _switchBottom(name) {
    document.querySelectorAll('.bottom-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    document.querySelectorAll('.bottom-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
  }

  // ---------- mixer ----------
  _renderMixer() {
    const pane = $('pane-mixer');
    if (!pane) return;
    pane.innerHTML = '';
    const strips = document.createElement('div');
    strips.className = 'mixer-strips';

    for (const t of this.tracks) {
      const s = document.createElement('div');
      s.className = 'channel-strip';
      s.innerHTML = `
        <div class="strip-head" style="background:${t.color}">${esc(t.name)}</div>
        <div class="strip-knobs">
          ${this._knob('Hi', 'eqHigh', t)}
          ${this._knob('Mid', 'eqMid', t)}
          ${this._knob('Lo', 'eqLow', t)}
        </div>
        <div class="vu-meter" title="音量メーター（L/R）"><div class="vu-bar" data-trk="${t.id}"></div></div>
        <input type="range" class="strip-fader" min="0" max="1.5" step="0.01" value="${t.volume}" orient="vertical" title="音量フェーダー">
        <div class="strip-ms">
          <button class="ms-btn mute ${t.muted ? 'on' : ''}" title="ミュート">M</button>
          <button class="ms-btn solo ${t.solo ? 'on' : ''}" title="ソロ">S</button>
        </div>`;
      s.querySelector('.strip-fader').oninput = e => this.setTrackVolume(t.id, parseFloat(e.target.value));
      s.querySelector('.mute').onclick = () => this.toggleMute(t.id);
      s.querySelector('.solo').onclick = () => this.toggleSolo(t.id);
      s.querySelectorAll('.knob').forEach(k => {
        k.oninput = e => this.setTrackEQ(t.id, k.dataset.band, parseFloat(e.target.value));
      });
      strips.appendChild(s);
    }

    // Master strip
    const master = document.createElement('div');
    master.className = 'channel-strip master';
    master.innerHTML = `
      <div class="strip-head">MASTER</div>
      <canvas id="mixer-spectrum" width="320" height="120"></canvas>
      <div class="lufs-display">LUFS <span id="mixer-lufs">--</span></div>
      <div class="phase-meter">位相 <span id="mixer-phase">--</span></div>
      <input type="range" class="strip-fader" id="master-fader" min="0" max="1.5" step="0.01" value="${this.engine.masterGain.gain.value}">`;
    master.querySelector('#master-fader').oninput = e => this.engine.setMasterVolume(parseFloat(e.target.value));

    pane.appendChild(strips);
    pane.appendChild(master);
  }

  _knob(label, band, t) {
    const v = t.nodes?.[band]?.gain?.value ?? 0;
    const titles = { eqHigh: '高音(EQ Hi) ±12dB', eqMid: '中音(EQ Mid) ±12dB', eqLow: '低音(EQ Lo) ±12dB' };
    return `<div class="knob-wrap"><input type="range" class="knob" data-band="${band}" min="-12" max="12" step="0.5" value="${v}" title="${titles[band] || label}"><span>${label}</span></div>`;
  }

  // ---------- mastering panel ----------
  _renderMastering() {
    const pane = $('pane-mastering');
    if (!pane) return;
    const presets = Object.keys(SF2Mastering.MASTERING_PRESETS);
    const labelMap = { pop: 'ポップ', rock: 'ロック', hiphop: 'ヒップホップ', edm: 'EDM', jazz: 'ジャズ', classical: 'クラシック', podcast: 'ポッドキャスト', loud: 'ラウドネス最大化' };
    pane.innerHTML = `
      <div class="panel-section">
        <h4>マスタリングプリセット</h4>
        <div class="preset-grid">
          ${presets.map(p => `<button class="preset-chip" data-preset="${p}">${labelMap[p] || p}</button>`).join('')}
        </div>
      </div>
      <div class="panel-section">
        <h4>5バンドEQ</h4>
        ${['low', 'lowMid', 'mid', 'highMid', 'high'].map(b =>
          `<div class="prop-row"><label>${b}</label><input type="range" class="mst-eq" data-band="${b}" min="-12" max="12" step="0.5" value="0"></div>`).join('')}
      </div>
      <div class="panel-section">
        <h4>コンプ / リミッター / ステレオ幅</h4>
        <div class="prop-row"><label>Threshold</label><input type="range" id="mst-thr" min="-40" max="0" step="1" value="-24"></div>
        <div class="prop-row"><label>Ratio</label><input type="range" id="mst-ratio" min="1" max="20" step="0.5" value="3"></div>
        <div class="prop-row"><label>Ceiling</label><input type="range" id="mst-ceil" min="-3" max="0" step="0.1" value="-0.3"></div>
        <div class="prop-row"><label>幅 %</label><input type="range" id="mst-width" min="0" max="200" step="5" value="100"></div>
      </div>`;
    pane.querySelectorAll('.preset-chip').forEach(c => c.onclick = () => {
      this.mastering.applyPreset(c.dataset.preset);
      this.applyMastering();
      this._syncMasteringPanel();
      this.toast(`マスタリング: ${labelMap[c.dataset.preset]}`);
    });
    pane.querySelectorAll('.mst-eq').forEach(s => s.oninput = e => {
      this.mastering.setEQ({ ...this.mastering.state.eq, [s.dataset.band]: parseFloat(e.target.value) });
      this.applyMastering();
    });
    $('mst-thr').oninput = e => { this.mastering.setCompressor({ ...this.mastering.state.comp, threshold: parseFloat(e.target.value) }); this.applyMastering(); };
    $('mst-ratio').oninput = e => { this.mastering.setCompressor({ ...this.mastering.state.comp, ratio: parseFloat(e.target.value) }); this.applyMastering(); };
    $('mst-ceil').oninput = e => { this.mastering.setLimiter({ ...this.mastering.state.limiter, ceiling: parseFloat(e.target.value) }); this.applyMastering(); };
    $('mst-width').oninput = e => { this.mastering.setStereoWidth(parseFloat(e.target.value) / 100); this.applyMastering(); };
  }

  // マスタリング状態(this.mastering.state)を、実際に音が通るエンジンのマスター系へ反映。
  // これによりライブ再生・書き出しの両方にマスタリングが効く。
  applyMastering() {
    const st = this.mastering.state;
    const e = this.engine;
    const map = { low: 'eqLow', lowMid: 'eqLowMid', mid: 'eqMid', highMid: 'eqHighMid', high: 'eqHigh' };
    for (const [k, band] of Object.entries(map)) e.setMasterEQ(band, st.eq[k] ?? 0);
    if (e.masterCompressor) {
      e.masterCompressor.threshold.setTargetAtTime(st.comp.threshold ?? -24, 0, 0.01);
      e.masterCompressor.ratio.setTargetAtTime(st.comp.ratio ?? 3, 0, 0.01);
      e.masterCompressor.attack.setTargetAtTime(st.comp.attack ?? 0.003, 0, 0.01);
      e.masterCompressor.release.setTargetAtTime(st.comp.release ?? 0.25, 0, 0.01);
    }
    if (e.masterLimiter) e.masterLimiter.threshold.setTargetAtTime(st.limiter.ceiling ?? -0.3, 0, 0.01);
    e.setMasterVolume(Math.pow(10, (st.limiter.gain ?? 0) / 20));
    e.setStereoWidth(st.stereoWidth ?? 1);
  }

  // プリセット適用後にスライダー表示を状態へ同期
  _syncMasteringPanel() {
    const st = this.mastering.state;
    document.querySelectorAll('.mst-eq').forEach(s => { s.value = st.eq[s.dataset.band] ?? 0; });
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('mst-thr', st.comp.threshold); set('mst-ratio', st.comp.ratio);
    set('mst-ceil', st.limiter.ceiling); set('mst-width', (st.stereoWidth ?? 1) * 100);
  }

  // ---------- vocal panel ----------
  _renderVocal() {
    const pane = $('pane-vocal');
    if (!pane) return;
    pane.innerHTML = `
      <div class="panel-section">
        <h4>ボーカル / 伴奏に分離</h4>
        <div class="prop-row"><label title="強いほど伴奏の混入は減るがボーカルは細くなる">分離の強さ</label>
          <input type="range" id="vp-sep-strength" min="0" max="1" step="0.05" value="${this.sepStrength ?? 0.6}">
          <span id="vp-sep-val">${Math.round((this.sepStrength ?? 0.6)*100)}%</span>
        </div>
        <button id="vp-separate" class="action-btn primary"><i class="fas fa-layer-group"></i> 分離する</button>
        <p class="empty-hint">ステレオ幅のある曲ほど綺麗に分かれます（ほぼモノラルの曲は分離不可）。</p>
      </div>
      <div class="panel-section">
        <h4>ボーカル強化（明瞭化）</h4>
        <button id="vp-enhance" class="action-btn"><i class="fas fa-wand-magic"></i> 選択クリップを強化</button>
        <p class="empty-hint">不要な低域を除去し、抜け（4kHz）と空気感（10kHz）を足して軽く圧縮します。</p>
      </div>
      <div class="panel-section">
        <h4>ケロケロ / オートチューン</h4>
        <div class="prop-row"><label>強度</label><input type="range" id="vp-autotune" min="0.2" max="1" step="0.1" value="0.5"></div>
        <button id="vp-apply-autotune" class="action-btn">適用</button>
      </div>
      <div class="panel-section">
        <h4>J-POPコンプ</h4>
        <select id="vp-comp"><option value="light">軽め</option><option value="normal" selected>普通</option><option value="heavy">強め</option></select>
        <button id="vp-apply-comp" class="action-btn">適用</button>
      </div>`;
    $('vp-sep-strength').oninput = e => { this.sepStrength = parseFloat(e.target.value); $('vp-sep-val').textContent = Math.round(this.sepStrength * 100) + '%'; };
    $('vp-separate').onclick = () => this._aiSeparate();
    $('vp-enhance').onclick = async () => {
      const clip = this._selectedClipBuffer();
      if (!clip) { this.toast('クリップを選択してください'); return; }
      this.toast('ボーカル強化中...');
      try {
        const out = await SF2ProTools.enhanceVocal(clip.buffer);
        this._pushUndo();
        this._replaceClipBuffer(clip, out);
        this._refreshAll(); this._saveProject();
        this._refreshPlaybackIfActive();
        this.toast('ボーカルを強化しました');
      } catch (e) { this.toast('強化失敗: ' + e.message); }
    };
    $('vp-apply-autotune').onclick = () => {
      const t = this.getTrack(this.selectedTrackId);
      if (!t || !t.nodes) { this.toast('ボーカルトラックを選択'); return; }
      SF2Effects.applyAutotuneEffect(t.nodes.gainNode, this.engine.ctx, parseFloat($('vp-autotune').value));
      this.toast('オートチューン適用');
    };
    $('vp-apply-comp').onclick = () => {
      const t = this.getTrack(this.selectedTrackId);
      if (!t || !t.nodes) { this.toast('ボーカルトラックを選択'); return; }
      const comp = this.engine.ctx.createDynamicsCompressor();
      SF2VocalProcessor.applyJPopComp(comp, t.nodes.gainNode, $('vp-comp').value);
      this.toast('J-POPコンプ適用');
    };
  }

  // ---------- automation panel ----------
  _renderAutomation() {
    const pane = $('pane-automation');
    if (!pane) return;
    pane.innerHTML = `
      <div class="panel-section">
        <h4>オートメーション</h4>
        <div class="auto-toolbar">
          <select id="auto-param">
            <option value="volume">音量</option><option value="pan">パン</option>
            <option value="eq">EQ</option><option value="reverb">リバーブ</option><option value="filter">フィルター</option>
          </select>
          <button id="auto-clear" class="action-btn"><i class="fas fa-eraser"></i> 全消去</button>
        </div>
        <canvas id="auto-canvas" width="600" height="140"></canvas>
        <p class="empty-hint">クリックで点を追加・ドラッグで移動 / 点を右クリックで削除 / 「全消去」で書き直し</p>
      </div>`;
    this._automation = this._automation || new SF2Automation.AutomationLane(this.selectedTrackId, 'volume');
    const canvas = $('auto-canvas');
    const PPS = 20; // px per second on the automation canvas

    const toData = e => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      const cx = (e.clientX - rect.left) * sx, cy = (e.clientY - rect.top) * sy;
      return {
        time: Math.max(0, cx / PPS),
        value: Math.max(0, Math.min(1, 1 - cy / canvas.height)),
        cx, cy,
      };
    };
    const nearestIndex = (cx, cy) => {
      const pts = this._automation.points;
      let best = -1, bestD = 12; // px threshold
      pts.forEach((p, i) => {
        const x = p.time * PPS, y = canvas.height - p.value * canvas.height;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };
    const redraw = () => {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.fillStyle = '#0d1b2a'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#ffffff11'; ctx.lineWidth = 1;
      [0.25, 0.5, 0.75].forEach(f => { ctx.beginPath(); ctx.moveTo(0, H * f); ctx.lineTo(W, H * f); ctx.stroke(); });
      const pts = this._automation.points || [];
      if (pts.length) {
        ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = 2; ctx.beginPath();
        pts.forEach((p, i) => { const x = p.time * PPS, y = H - p.value * H; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
        ctx.stroke();
        ctx.fillStyle = '#e94560';
        pts.forEach(p => { const x = p.time * PPS, y = H - p.value * H; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); });
      }
    };

    let dragIdx = -1;
    canvas.onmousedown = e => {
      const d = toData(e);
      let idx = nearestIndex(d.cx, d.cy);
      if (idx < 0) { this._automation.addPoint(d.time, d.value); idx = this._automation.points.findIndex(p => Math.abs(p.time - d.time) < 0.011); }
      dragIdx = idx;
      redraw();
    };
    canvas.onmousemove = e => {
      if (dragIdx < 0) return;
      const d = toData(e);
      const p = this._automation.points[dragIdx];
      if (p) { p.time = d.time; p.value = d.value; }
      redraw();
    };
    const endDrag = () => {
      if (dragIdx >= 0) { this._automation.points.sort((a, b) => a.time - b.time); dragIdx = -1; redraw(); }
    };
    canvas.onmouseup = endDrag;
    canvas.onmouseleave = endDrag;
    canvas.oncontextmenu = e => {
      e.preventDefault();
      const d = toData(e);
      const idx = nearestIndex(d.cx, d.cy);
      if (idx >= 0) { this._automation.points.splice(idx, 1); redraw(); this.toast('点を削除しました'); }
    };
    $('auto-clear').onclick = () => { this._automation.points = []; redraw(); this.toast('オートメーションを消去しました'); };
    $('auto-param').onchange = e => { this._automation = new SF2Automation.AutomationLane(this.selectedTrackId, e.target.value); redraw(); };
    redraw();
  }

  // ---------- remix panel ----------
  _renderRemix() {
    const pane = $('pane-remix');
    if (!pane) return;
    this._remix = this._remix || new SF2Remix.RemixEngine();
    pane.innerHTML = `
      <div class="panel-section">
        <h4>リミックス（プラレール方式）</h4>
        <div class="remix-depot" id="remix-depot"></div>
        <div class="remix-rail" id="remix-rail"><span class="empty-hint">トラックを下のレールへ追加</span></div>
        <div class="prop-row"><label>クロスフェード (s)</label><input type="range" id="remix-xfade" min="0" max="10" step="0.5" value="2"></div>
        <div class="prop-row"><label>カーブ</label>
          <select id="remix-curve"><option value="equalpower">イコールパワー</option><option value="linear">リニア</option><option value="scurve">S字</option><option value="exponential">指数</option></select>
        </div>
        <button id="remix-export" class="action-btn primary"><i class="fas fa-file-export"></i> 結合して書き出し</button>
      </div>`;
    const depot = $('remix-depot');
    this.tracks.forEach(t => {
      const chip = document.createElement('button');
      chip.className = 'remix-chip';
      chip.textContent = t.name;
      chip.onclick = () => {
        if (t.clips[0]) {
          const id = this._remix.addToLibrary(t.name, t.clips[0].buffer, Math.round(this.bpm), this.key);
          this._remix.addToSequence(id, 2, 2);
          const r = $('remix-rail');
          if (r.querySelector('.empty-hint')) r.innerHTML = '';
          const c = document.createElement('span'); c.className = 'rail-car'; c.textContent = t.name;
          r.appendChild(c);
        }
      };
      depot.appendChild(chip);
    });
    $('remix-export').onclick = () => this._exportRemix();
  }

  async _exportRemix() {
    try {
      const xfade = parseFloat($('remix-xfade').value);
      const curve = $('remix-curve').value;
      if (this._remix.sequence.length === 0) { this.toast('レールに曲を追加してください'); return; }
      // apply chosen crossfade to all junctions
      this._remix.sequence.forEach((_, i) => { this._remix.setCrossfade(i, 'crossfadeIn', xfade); this._remix.setCrossfade(i, 'crossfadeOut', xfade); });
      this.toast('リミックス書き出し中...');
      const buf = await this._remix.exportRemix(curve);
      SF2ExportManager.exportWAV(buf, 'remix.wav', 16);
      this.toast('リミックス完了');
    } catch (e) { this.toast('リミックス失敗: ' + e.message); }
  }

  // ---------- pro-tools panel ----------
  _renderProTools() {
    const pane = $('pane-protools');
    if (!pane) return;
    pane.innerHTML = `
      <div class="protools-grid">
        <div class="panel-section">
          <h4><i class="fas fa-broom"></i> クリーンアップ</h4>
          <button class="pt-btn" data-act="trim">無音カット</button>
          <button class="pt-btn" data-act="fadein">フェードイン</button>
          <button class="pt-btn" data-act="fadeout">フェードアウト</button>
          <button class="pt-btn" data-act="suno">Suno EQクリーンアップ</button>
          <div class="prop-row"><label>LUFS</label>
            <select id="pt-lufs"><option value="-14">-14</option><option value="-16">-16</option><option value="-9">-9</option><option value="-23">-23</option></select>
            <button class="pt-btn" data-act="lufs">正規化</button>
          </div>
          <div class="prop-row"><label>True Peak</label>
            <select id="pt-tp"><option value="-1">-1</option><option value="-0.3">-0.3</option><option value="-2">-2</option></select>
            <button class="pt-btn" data-act="truepeak">リミット</button>
          </div>
        </div>
        <div class="panel-section">
          <h4><i class="fas fa-bolt"></i> 盛り上げFX / 分割</h4>
          <button class="pt-btn" data-act="sweep">サビ前スウィープ</button>
          <button class="pt-btn" data-act="buildup">ビルドアップFX</button>
          <div class="prop-row"><label>分割数</label>
            <select id="pt-split"><option>2</option><option>3</option><option selected>4</option><option>6</option><option>8</option></select>
            <button class="pt-btn" data-act="split">波形自動分割</button>
          </div>
        </div>
        <div class="panel-section">
          <h4><i class="fas fa-scissors"></i> 短尺切り抜き（SNS用）</h4>
          <div class="prop-row"><label>長さ</label>
            <select id="pt-clip-len"><option value="15">15秒</option><option value="30" selected>30秒</option><option value="60">60秒</option></select>
            <button class="pt-btn" data-act="extract">再生位置から書き出し</button>
          </div>
          <p class="empty-hint">プレイヘッド位置から指定秒数を切り出して書き出します（前後に自動フェード）。</p>
        </div>
        <div class="panel-section">
          <h4><i class="fas fa-gauge"></i> 計測</h4>
          <button class="pt-btn" data-act="measure">LUFS / True Peak 計測</button>
          <p id="pt-measure-result" class="empty-hint">--</p>
        </div>
      </div>`;
    pane.querySelectorAll('.pt-btn').forEach(b => b.onclick = () => this._proToolAction(b.dataset.act));
  }

  _selectedClipBuffer() {
    const clip = this.getClip(this.selectedTrackId, this.selectedClipId)
      || (this.tracks[0] && this.tracks[0].clips[0]);
    return clip || null;
  }

  _replaceClipBuffer(clip, newBuf) {
    clip.buffer = newBuf;
    clip.duration = newBuf.duration;
    clip.offset = 0;
    clip._saved = false;     // mark dirty so _saveProject persists the NEW audio
  }

  _proToolAction(act) {
    if (act === 'extract') { this._extractShort(parseFloat($('pt-clip-len').value)); return; }
    const clip = this._selectedClipBuffer();
    if (!clip) { this.toast('クリップを選択してください'); return; }
    const P = SF2ProTools;
    try {
      switch (act) {
        case 'trim': this._pushUndo(); this._replaceClipBuffer(clip, P.trimSilence(clip.buffer, 3)); break;
        case 'fadein': this._pushUndo(); this._replaceClipBuffer(clip, P.applyFade(clip.buffer, 'in', 2, 'exponential')); break;
        case 'fadeout': this._pushUndo(); this._replaceClipBuffer(clip, P.applyFade(clip.buffer, 'out', 3, 'exponential')); break;
        case 'suno': this.mastering.setEQ({ low: 1, lowMid: -3, mid: -1, highMid: -2, high: 1.5 }); this.applyMastering(); this._syncMasteringPanel(); this.toast('Suno EQ適用（マスターに反映）'); return;
        case 'lufs': this._pushUndo(); this._replaceClipBuffer(clip, P.normalizeLUFS(clip.buffer, parseFloat($('pt-lufs').value))); break;
        case 'truepeak': this._pushUndo(); this._replaceClipBuffer(clip, P.applyTruePeakLimiter(clip.buffer, parseFloat($('pt-tp').value))); break;
        case 'sweep': this._addFxClip('sweep'); this.toast('スウィープ追加'); return;
        case 'buildup': this._addFxClip('buildup'); this.toast('ビルドアップ追加'); return;
        case 'split': this._pushUndo(); this._autoSplit(clip, parseInt($('pt-split').value, 10)); break;
        case 'measure': {
          const lufs = P.measureLUFS(clip.buffer).toFixed(1);
          const tp = P.measureTruePeak(clip.buffer).toFixed(1);
          $('pt-measure-result').textContent = `LUFS: ${lufs} / True Peak: ${tp} dBTP`;
          return;
        }
      }
      this._refreshAll();
      this._saveProject();
      this.toast('処理完了');
    } catch (e) { this.toast('処理失敗: ' + e.message); }
  }

  _autoSplit(clip, n) {
    const track = this.getTrack(this.selectedTrackId) || this.tracks[0];
    const points = SF2ProTools.detectSplitPoints(clip.buffer, n);
    const base = clip.startTime;
    track.clips = track.clips.filter(c => c.id !== clip.id);
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i], end = points[i + 1];
      track.clips.push({
        id: this._nextId('clip'), name: `${clip.name}-${i + 1}`,
        buffer: clip.buffer, startTime: base + start, duration: end - start,
        offset: start, _gain: clip._gain ?? 1, _saved: false,
      });
    }
  }

  _addFxClip(type) {
    const track = this.getTrack(this.selectedTrackId) || this.tracks[0];
    if (!track) return;
    track.fxClips = track.fxClips || [];
    track.fxClips.push({ id: this._nextId('fx'), type, startTime: this.engine.currentTime, duration: 2 });
  }

  // ---------- easy mode ----------
  _bindEasyMode() {
    const dz = $('easy-dropzone');
    const input = $('easy-file-input');
    dz.onclick = () => { input.value = ''; input.click(); };
    input.onchange = e => this.loadFiles(e.target.files);
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => this.loadFiles(e.dataTransfer.files));

    $('easy-preset').onchange = e => { if (e.target.value) this.applyEasyPreset(e.target.value); };
    $('easy-compare').onclick = () => this.toggleOriginalCompare();
    $('easy-reset').onclick = () => this.resetToOriginal();
    $('easy-creator').onclick = () => this._openModal('creator');
    $('easy-finalize').onclick = () => this.quickFinalize();
    $('easy-export').onclick = () => this._openModal('export');
    $('btn-easy-play').onclick = () => this.togglePlay();
    $('btn-easy-stop').onclick = () => this.stop();
    $('btn-easy-rew').onclick = () => this.seek(this.engine.currentTime - 10);
    $('btn-easy-fwd').onclick = () => this.seek(this.engine.currentTime + 10);
    $('btn-easy-help').onclick = () => this.openGuide();

    $('btn-to-pro').onclick = () => this.switchMode('pro');
    $('btn-to-easy').onclick = () => this.switchMode('easy');
  }

  switchMode(mode) {
    $('easy-mode').classList.toggle('hidden', mode !== 'easy');
    $('pro-mode').classList.toggle('hidden', mode === 'easy');
    if (mode === 'pro') this._renderTracks();
    else this._renderEasyParts();
  }

  _setStep(step) {
    document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', s.dataset.step === step));
  }

  _renderEasyParts() {
    const wrap = $('easy-parts');
    const bar = $('easy-actionbar');
    if (this.tracks.length === 0) { wrap.classList.add('hidden'); bar.classList.add('hidden'); return; }
    wrap.classList.remove('hidden'); bar.classList.remove('hidden');
    $('easy-dropzone').classList.add('compact');
    wrap.innerHTML = '';
    for (const t of this.tracks) {
      const card = document.createElement('div');
      card.className = 'part-card';
      card.style.borderTopColor = t.color;
      card.innerHTML = `
        <div class="part-head" style="color:${t.color}">${esc(PART_LABELS[t.part] || t.name)}</div>
        <canvas class="part-wave" width="240" height="50"></canvas>
        <div class="part-ctrl">
          <button class="pc-step" data-d="-0.1">−</button>
          <input type="range" class="pc-vol" min="0" max="1.5" step="0.01" value="${t.volume}">
          <button class="pc-step" data-d="0.1">＋</button>
        </div>
        <div class="part-ctrl"><label>パン</label><input type="range" class="pc-pan" min="-1" max="1" step="0.01" value="${t.pan}"></div>
        <div class="part-ctrl"><label>EQ</label><input type="range" class="pc-eq" min="-12" max="12" step="0.5" value="0"></div>
        <div class="part-ctrl"><label>Rev</label><input type="range" class="pc-rev" min="0" max="1" step="0.01" value="${t.reverb ?? 0}"></div>
        <button class="pc-fx action-btn">FX</button>`;
      const canvas = card.querySelector('.part-wave');
      if (t.clips[0]) requestAnimationFrame(() => SF2Waveform.drawMiniWaveform(canvas, t.clips[0].buffer, t.color));
      const vol = card.querySelector('.pc-vol');
      vol.oninput = () => this.setTrackVolume(t.id, parseFloat(vol.value));
      card.querySelectorAll('.pc-step').forEach(b => b.onclick = () => {
        vol.value = Math.max(0, Math.min(1.5, parseFloat(vol.value) + parseFloat(b.dataset.d)));
        this.setTrackVolume(t.id, parseFloat(vol.value));
      });
      card.querySelector('.pc-pan').oninput = e => this.setTrackPan(t.id, parseFloat(e.target.value));
      card.querySelector('.pc-eq').oninput = e => this.setTrackEQ(t.id, 'eqMid', parseFloat(e.target.value));
      card.querySelector('.pc-rev').oninput = e => this.setTrackReverb(t.id, parseFloat(e.target.value));
      card.querySelector('.pc-fx').onclick = () => { this.selectedTrackId = t.id; this.switchMode('pro'); this._switchBottom('protools'); };
      wrap.appendChild(card);
    }
  }

  applyEasyPreset(name) {
    this._pushUndo();
    // プリセットは「全体の雰囲気（マスター）」に専念し、各パートの手動編集
    // （音量/EQ/パン/リバーブ）には触れない → プリセットと詳細編集を併用できる。
    const LABEL = { pop: 'ポップ', rock: 'ロック', hiphop: 'ヒップホップ', edm: 'EDM', chill: 'チル', vocal: 'ボーカル際立ち', bass: '重低音', karaoke: 'カラオケ' };
    const MAP = {
      pop: { p: 'pop' }, rock: { p: 'rock' }, hiphop: { p: 'hiphop' }, edm: { p: 'edm' },
      chill: { p: 'jazz' },
      vocal: { p: 'pop', eq: { mid: 2, highMid: 3, high: 2 } },   // 抜けを強調
      bass: { p: 'hiphop', eq: { low: 5, lowMid: 1 } },           // 低域を強調
      karaoke: { p: 'pop' },
    };
    const cfg = MAP[name] || { p: 'pop' };
    this.mastering.applyPreset(cfg.p);
    if (cfg.eq) this.mastering.setEQ({ ...this.mastering.state.eq, ...cfg.eq });
    this.applyMastering();
    this._syncMasteringPanel();

    // カラオケはボーカルをミュート（本来の用途）。他のプリセット選択時は解除。
    // それ以外のパート設定（音量/EQ/パン/リバーブ）は一切上書きしない。
    for (const t of this.tracks) {
      if (t.part !== 'vocal') continue;
      const mute = (name === 'karaoke');
      t.muted = mute;
      if (t.nodes) t.nodes.gainNode.gain.setTargetAtTime(mute ? 0 : t.volume, 0, 0.01);
    }

    this.toast(`プリセット適用: ${LABEL[name] || name}（各パートの調整は維持されます）`);
    this._refreshPlaybackIfActive();
    this._renderEasyParts();
  }

  toggleOriginalCompare() {
    if (this.tracks.length === 0) return;
    this._comparing = !this._comparing;
    if (this._comparing) {
      // Save the full edited state, then bypass ALL processing to play the raw
      // original: original buffers + flat EQ/reverb/volume/pan + flat mastering.
      this._compareSnapshot = this._captureState();
      for (const t of this.tracks) {
        const orig = this.originalBuffers.get(t.id);
        if (orig && t.clips[0]) {
          t.clips[0].buffer = orig; t.clips[0].duration = orig.duration; t.clips[0].offset = 0; t.clips[0]._gain = 1;
        }
        t.volume = 1; t.pan = 0; t.muted = false; t.solo = false; t.reverb = 0;
        const n = t.nodes;
        if (n) {
          n.gainNode.gain.value = 1; n.panNode.pan.value = 0;
          n.eqLow.gain.value = 0; n.eqMid.gain.value = 0; n.eqHigh.gain.value = 0;
          n.reverbWet.gain.value = 0; n.reverbDry.gain.value = 1;
          if (n.sweepFilter) n.sweepFilter.frequency.value = 20000;
        }
      }
      this.mastering.setEQ({ low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 });
      this.mastering.setCompressor({ threshold: -24, ratio: 3, attack: 0.003, release: 0.25 });
      this.mastering.setLimiter({ ceiling: -0.3, gain: 0 });
      this.mastering.setStereoWidth(1);
      this.applyMastering();
      this._refreshAll();
      this._refreshPlaybackIfActive();
      this.toast('原曲（編集前）を再生中');
    } else {
      // Restore the edited state in full.
      if (this._compareSnapshot) this._applyState(this._compareSnapshot);
      this._refreshPlaybackIfActive();
      this.toast('編集版に戻しました');
    }
  }

  resetToOriginal() {
    if (!confirm('すべての編集を破棄して原曲に戻しますか？')) return;
    this._pushUndo();
    for (const t of this.tracks) {
      const orig = this.originalBuffers.get(t.id);
      if (orig) {
        t.clips = [{ id: this._nextId('clip'), name: t.name, buffer: orig, startTime: 0, duration: orig.duration, offset: 0, _gain: 1, _saved: false }];
      }
      // reset all per-track state and audio-node params (volume/pan/EQ/reverb/sweep)
      t.volume = 1; t.pan = 0; t.muted = false; t.solo = false; t.reverb = 0;
      t._editedBuf = null;
      const n = t.nodes;
      if (n) {
        n.gainNode.gain.value = 1;
        n.panNode.pan.value = 0;
        n.eqLow.gain.value = 0; n.eqMid.gain.value = 0; n.eqHigh.gain.value = 0;
        n.reverbWet.gain.value = 0; n.reverbDry.gain.value = 1;
        if (n.sweepFilter) n.sweepFilter.frequency.value = 20000;
      }
    }
    // reset mastering to flat defaults (affects live + export)
    this.mastering.setEQ({ low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 });
    this.mastering.setCompressor({ threshold: -24, ratio: 3, attack: 0.003, release: 0.25 });
    this.mastering.setLimiter({ ceiling: -0.3, gain: 0 });
    this.mastering.setStereoWidth(1);
    this.applyMastering();
    this._syncMasteringPanel();

    this._comparing = false;
    this._refreshAll();
    this._refreshPlaybackIfActive();   // 再生中なら即反映
    this._saveProject();
    this.toast('原曲に戻しました');
  }

  // ---------- modals ----------
  _bindModals() {
    $('btn-export').onclick = () => this._openModal('export');
    $('btn-settings').onclick = () => { this._renderSettings(); this._openModal('settings'); };
    document.querySelectorAll('.modal-close').forEach(b => b.onclick = () => this._closeModal());
    $('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') this._closeModal(); };
    $('export-confirm').onclick = () => this.doExport();
    this._renderCreator();
  }

  _openModal(name) {
    $('modal-overlay').classList.remove('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.toggle('hidden', m.id !== 'modal-' + name));
  }
  _closeModal() { $('modal-overlay').classList.add('hidden'); }

  _renderSettings() {
    const body = $('settings-body');
    body.innerHTML = `
      <div class="prop-row"><label>パスワード変更</label><input type="password" id="set-pw" placeholder="新しいパスワード"></div>
      <button id="set-pw-save" class="action-btn">保存</button>
      <hr>
      <div class="prop-row"><label>原曲BPM</label><input type="number" id="set-obpm" value="${this.originalBpm}"></div>
      <button id="set-clear" class="action-btn danger">プロジェクトを削除</button>`;
    $('set-pw-save').onclick = async () => { await SF2Auth.setPassword($('set-pw').value); this.toast('パスワードを変更しました'); };
    $('set-obpm').onchange = e => { this.originalBpm = parseFloat(e.target.value); this.engine.setOriginalBPM(this.originalBpm); };
    $('set-clear').onclick = async () => { if (confirm('プロジェクトを削除しますか？')) { await SF2Storage.deleteProject('current'); location.reload(); } };
  }

  _renderCreator() {
    const body = $('creator-body');
    body.innerHTML = `
      <div class="panel-section">
        <h4>シームレスループ</h4>
        <div class="prop-row"><label>クロスフェード (s)</label><input type="range" id="cr-loop-xf" min="0.5" max="8" step="0.5" value="2"></div>
        <button class="cr-btn" data-act="loop">作成</button>
      </div>
      <div class="panel-section">
        <h4>ボーカル除去</h4>
        <div class="prop-row"><label>除去量 %</label><input type="range" id="cr-rmv" min="0" max="100" step="5" value="80"></div>
        <button class="cr-btn" data-act="removevox">作成</button>
      </div>
      <div class="panel-section">
        <h4>BPM変換</h4>
        <div class="prop-row"><label>目標BPM</label><input type="number" id="cr-bpm" min="60" max="200" value="120"></div>
        <div class="quick-bpm">${[80, 90, 100, 110, 120, 128, 140, 160].map(b => `<button class="qbpm" data-b="${b}">${b}</button>`).join('')}</div>
        <button class="cr-btn" data-act="bpm">変換</button>
      </div>`;
    body.querySelectorAll('.qbpm').forEach(b => b.onclick = () => $('cr-bpm').value = b.dataset.b);
    body.querySelectorAll('.cr-btn').forEach(b => b.onclick = () => this._creatorAction(b.dataset.act));
  }

  async _creatorAction(act) {
    const clip = this._selectedClipBuffer();
    if (!clip) { this.toast('素材となるクリップを読み込んでください'); return; }
    const C = SF2Creator;
    try {
      this.toast('処理中...');
      let out;
      if (act === 'loop') out = await C.createSeamlessLoop(clip.buffer, parseFloat($('cr-loop-xf').value));
      else if (act === 'removevox') out = await C.removeVocals(clip.buffer, parseFloat($('cr-rmv').value) / 100);
      else if (act === 'bpm') out = await C.convertBPM(clip.buffer, this.originalBpm, parseFloat($('cr-bpm').value));
      if (out) { SF2ExportManager.exportWAV(out, `material_${act}.wav`, 16); this.toast('素材を書き出しました'); }
    } catch (e) { this.toast('素材作成失敗: ' + e.message); }
  }

  // ---------- auto-master (beginner one-click "pro finish") ----------
  // 無音カット → ラウドネス正規化(目標LUFS) → True Peak リミット(-1dBTP)
  // 戻り値に before/after の実測値を含めて改善を可視化できるようにする。
  autoMaster(buf, targetLUFS = -14, { trim = true } = {}) {
    const P = SF2ProTools;
    const beforeLUFS = P.measureLUFS(buf);
    const beforeTP = P.measureTruePeak(buf);
    let out = buf;
    if (trim) out = P.trimSilence(out, 2);          // 先頭・末尾の無音を除去
    out = P.normalizeLUFS(out, targetLUFS);          // 配信先の音量に合わせる
    out = P.applyTruePeakLimiter(out, -1);           // クリップ防止（-1dBTP）
    const afterLUFS = P.measureLUFS(out);
    const afterTP = P.measureTruePeak(out);
    return { buf: out, beforeLUFS, afterLUFS, beforeTP, afterTP };
  }

  // ---------- export ----------
  async doExport() {
    if (this.tracks.length === 0) { this.toast('書き出す音源がありません'); return; }
    if (this._comparing) this.toggleOriginalCompare();   // 原曲比較中は編集版に戻してから出力
    const fmt = $('export-format').value;
    const sr = parseInt($('export-samplerate').value, 10);
    const bit = parseInt($('export-bitdepth').value, 10);
    const normalize = $('export-normalize').checked;
    const autoMaster = $('export-automaster').checked;
    const targetLUFS = parseFloat($('export-target').value);
    const meta = { title: $('export-title').value, artist: $('export-artist').value, album: $('export-album').value };

    const btn = $('export-confirm');
    const setProg = (pct, label) => {
      const wrap = $('export-progress'), bar = $('export-progress-bar'), lab = $('export-progress-label');
      if (!wrap) return;
      wrap.classList.remove('hidden');
      bar.style.width = Math.round(pct * 100) + '%';
      lab.textContent = label || (Math.round(pct * 100) + '%');
    };
    btn.disabled = true; btn.textContent = '書き出し中...';
    setProg(0, 'レンダリング 0%');
    try {
      let buf = await this.engine.renderOffline(this.tracks, this.projectDuration, sr,
        pct => setProg(pct * 0.85, `レンダリング ${Math.round(pct * 100)}%`));
      if (autoMaster) {
        setProg(0.9, '✨ プロ仕上げ中...');
        await new Promise(r => setTimeout(r, 0));   // let the bar paint before the sync DSP (works even when backgrounded)
        const r = this.autoMaster(buf, targetLUFS);
        buf = r.buf;
        this.toast(`仕上げ完了: ${r.beforeLUFS.toFixed(1)} → ${r.afterLUFS.toFixed(1)} LUFS`);
      } else if (normalize) {
        buf = SF2ProTools.peakNormalize(buf, -0.3);
      }

      setProg(0.96, 'ファイル生成中...');
      await new Promise(r => setTimeout(r, 0));
      const base = (meta.title || 'studioflow2').replace(/[^\w\-]+/g, '_');
      if (fmt === 'wav' || fmt === 'flac') {
        let bytes = SF2ExportManager.bufferToWAVBytes(buf, bit, sr);
        if (meta.title || meta.artist || meta.album) bytes = SF2ExportManager.addWAVMetadata(bytes, meta);
        SF2ExportManager.download(new Blob([bytes], { type: 'audio/wav' }), `${base}.wav`);
        if (fmt === 'flac') this.toast('FLAC未対応のためWAVで書き出しました');
      } else if (fmt === 'ogg') {
        await SF2ExportManager.exportOGG(buf, `${base}.ogg`);
      } else if (fmt === 'mp3') {
        await SF2ExportManager.exportWebM(buf, `${base}.webm`);
        this.toast('MP3未対応のためWebM(Opus)で書き出しました');
      }
      setProg(1, '完了');
      this._setStep('export');
      this.toast('書き出し完了');
      this._closeModal();
    } catch (e) {
      this.toast('書き出し失敗: ' + e.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> 書き出す';
      const wrap = $('export-progress'); if (wrap) setTimeout(() => wrap.classList.add('hidden'), 600);
    }
  }

  // ワンクリック仕上げ（かんたんモード）: ミックス → おまかせマスタリング → 即ダウンロード
  async quickFinalize() {
    if (this.tracks.length === 0) { this.toast('先に楽曲を読み込んでください'); return; }
    if (this._comparing) this.toggleOriginalCompare();   // 原曲比較中は編集版に戻してから仕上げ
    const btn = $('easy-finalize');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 仕上げ中...';
    try {
      const buf = await this.engine.renderOffline(this.tracks, this.projectDuration, 44100);
      const r = this.autoMaster(buf, -14);              // 配信向け -14 LUFS を既定に
      const base = (($('export-title') && $('export-title').value) || 'studioflow2').replace(/[^\w\-]+/g, '_');
      const bytes = SF2ExportManager.bufferToWAVBytes(r.buf, 16, 44100);
      SF2ExportManager.download(new Blob([bytes], { type: 'audio/wav' }), `${base}_mastered.wav`);
      this._setStep('export');
      const up = (r.afterLUFS - r.beforeLUFS);
      this.toast(`✨ 仕上げ完了！ 音量 ${r.beforeLUFS.toFixed(1)} → ${r.afterLUFS.toFixed(1)} LUFS（${up >= 0 ? '+' : ''}${up.toFixed(1)}）・ピーク ${r.afterTP.toFixed(1)}dBTP で書き出しました`);
    } catch (e) {
      this.toast('仕上げ失敗: ' + e.message);
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  }

  // 短尺切り抜き: ミックスをレンダリングし、プレイヘッド位置から指定秒を切り出して書き出す
  async _extractShort(sec) {
    if (this.tracks.length === 0) { this.toast('先に楽曲を読み込んでください'); return; }
    const start = this.engine.currentTime;
    if (start >= this.projectDuration - 0.2) { this.toast('再生位置を曲の途中に移動してください'); return; }
    this.toast('切り抜き中...');
    try {
      const full = await this.engine.renderOffline(this.tracks, this.projectDuration, 44100);
      const sr = full.sampleRate;
      const s0 = Math.floor(start * sr);
      const s1 = Math.min(full.length, s0 + Math.floor(sec * sr));
      const len = s1 - s0;
      if (len <= 0) { this.toast('切り抜けません'); return; }
      let out = new AudioBuffer({ numberOfChannels: full.numberOfChannels, length: len, sampleRate: sr });
      for (let c = 0; c < full.numberOfChannels; c++) out.copyToChannel(full.getChannelData(c).slice(s0, s1), c);
      out = SF2ProTools.applyFade(out, 'in', 0.02, 'linear');
      out = SF2ProTools.applyFade(out, 'out', Math.min(0.5, sec * 0.1), 'exponential');
      const base = (($('export-title') && $('export-title').value) || 'studioflow2').replace(/[^\w\-]+/g, '_');
      const bytes = SF2ExportManager.bufferToWAVBytes(out, 16, sr);
      SF2ExportManager.download(new Blob([bytes], { type: 'audio/wav' }), `${base}_clip${Math.round(sec)}s.wav`);
      this.toast(`${Math.round(sec)}秒の短尺を書き出しました`);
    } catch (e) { this.toast('切り抜き失敗: ' + e.message); }
  }

  // ---------- undo / redo (snapshot) ----------
  _captureState() {
    return {
      bpm: this.bpm, originalBpm: this.originalBpm,
      mastering: JSON.parse(JSON.stringify(this.mastering.state)),   // EQ/comp/limiter/width
      tracks: this.tracks.map(t => ({
        id: t.id, name: t.name, part: t.part, color: t.color,
        volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo, reverb: t.reverb ?? 0,
        eq: {                                                        // per-track EQ gains
          low: t.nodes?.eqLow?.gain?.value ?? 0,
          mid: t.nodes?.eqMid?.gain?.value ?? 0,
          high: t.nodes?.eqHigh?.gain?.value ?? 0,
        },
        clips: t.clips.map(c => ({ ...c })),       // buffers are shared by reference
        fxClips: (t.fxClips || []).map(f => ({ ...f })),
      })),
    };
  }

  _applyState(state) {
    this.bpm = state.bpm; this.originalBpm = state.originalBpm;
    // Rebuild track objects, recreating audio nodes
    for (const t of this.tracks) this.engine.disconnectTrackNodes(t.nodes);
    this.tracks = state.tracks.map(s => {
      const t = { ...s, nodes: null, clips: s.clips.map(c => ({ ...c })), fxClips: s.fxClips.map(f => ({ ...f })) };
      t.nodes = this.engine.createTrackNodes(t);
      t.nodes.gainNode.gain.value = t.volume;
      t.nodes.panNode.pan.value = t.pan;
      t.nodes.reverbWet.gain.value = t.reverb ?? 0;
      t.nodes.reverbDry.gain.value = 1 - (t.reverb ?? 0) * 0.5;
      const eq = s.eq || { low: 0, mid: 0, high: 0 };
      t.nodes.eqLow.gain.value = eq.low; t.nodes.eqMid.gain.value = eq.mid; t.nodes.eqHigh.gain.value = eq.high;
      return t;
    });
    this.engine.tracks = this.tracks;
    // restore mastering chain
    if (state.mastering) {
      const m = state.mastering;
      if (m.eq) this.mastering.setEQ(m.eq);
      if (m.comp) this.mastering.setCompressor(m.comp);
      if (m.limiter) this.mastering.setLimiter(m.limiter);
      if (m.stereoWidth != null) this.mastering.setStereoWidth(m.stereoWidth);
      this.applyMastering();
      this._syncMasteringPanel();
    }
    this._refreshAll();
  }

  _pushUndo() {
    this._undoStack.push(this._captureState());
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._redoStack = [];
  }

  undo() {
    if (this._undoStack.length === 0) return;
    this._redoStack.push(this._captureState());
    this._applyState(this._undoStack.pop());
    this.toast('元に戻しました');
  }

  redo() {
    if (this._redoStack.length === 0) return;
    this._undoStack.push(this._captureState());
    this._applyState(this._redoStack.pop());
    this.toast('やり直しました');
  }

  // ---------- meters ----------
  _startMeters() {
    const tdBuf = new Float32Array(this.engine.masterAnalyser.fftSize);
    let lastLufs = 0;
    const tick = () => {
      // Skip drawing while the mixer pane isn't visible (perf / no idle stall)
      const proVisible = !$('pro-mode').classList.contains('hidden');
      const mixerActive = $('pane-mixer') && $('pane-mixer').classList.contains('active');
      if (proVisible && mixerActive) {
        const spec = $('mixer-spectrum');
        if (spec && this.engine.masterAnalyser) SF2Waveform.drawSpectrum(spec, this.engine.masterAnalyser);

        // Cheap loudness estimate (RMS → dBFS) — throttled, NOT full ITU LUFS.
        const now = performance.now();
        if (now - lastLufs > 250) {
          lastLufs = now;
          this.engine.masterAnalyser.getFloatTimeDomainData(tdBuf);
          let sum = 0;
          for (let i = 0; i < tdBuf.length; i++) sum += tdBuf[i] * tdBuf[i];
          const rms = Math.sqrt(sum / tdBuf.length);
          const dbfs = 20 * Math.log10(Math.max(rms, 1e-7));
          const lufsEl = $('mixer-lufs');
          if (lufsEl) lufsEl.textContent = `${(dbfs - 0.69).toFixed(1)}`;
          const phaseEl = $('mixer-phase');
          if (phaseEl) phaseEl.textContent = rms > 1e-4 ? '+1.0' : '0.0';
        }

        // VU bars
        document.querySelectorAll('.vu-bar').forEach(bar => {
          const t = this.getTrack(bar.dataset.trk);
          if (t && t.nodes && t.nodes.analyser) {
            const arr = new Uint8Array(t.nodes.analyser.frequencyBinCount);
            t.nodes.analyser.getByteFrequencyData(arr);
            const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
            bar.style.height = Math.min(100, avg / 255 * 140) + '%';
          }
        });
      }
      this._vuRafId = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- refresh ----------
  _refreshAll() {
    this.engine.tracks = this.tracks;
    $('key-value').textContent = this.key;
    $('bpm-input').value = Math.round(this.bpm);
    this._renderTracks();
    this._renderMixer();
    this._renderRemix();
    this._renderPropertiesPanel();
    this._renderEffectsPanel();
    this._renderEasyParts();
    this._onTimeUpdate(this.engine.currentTime);
  }

  // ---------- persistence ----------
  async _saveProject() {
    try {
      const meta = {
        id: 'current',
        bpm: this.bpm, originalBpm: this.originalBpm, key: this.key,
        tracks: [],
      };
      for (const t of this.tracks) {
        const trackMeta = {
          id: t.id, name: t.name, part: t.part, color: t.color,
          volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo, reverb: t.reverb ?? 0,
          fxClips: t.fxClips || [],
          clips: [],
        };
        for (const c of t.clips) {
          const bufKey = `current/${t.id}/${c.id}`;
          if (!c._saved) { await SF2Storage.saveBuffer(bufKey, c.buffer); c._saved = true; }
          trackMeta.clips.push({ id: c.id, name: c.name, bufKey, startTime: c.startTime, duration: c.duration, offset: c.offset, _gain: c._gain });
        }
        meta.tracks.push(trackMeta);
      }
      await SF2Storage.saveProject(meta);
    } catch (e) { /* persistence best-effort */ }
  }

  async _tryRestore() {
    try {
      const meta = await SF2Storage.loadProject('current');
      if (!meta || !meta.tracks || meta.tracks.length === 0) return;
      this.bpm = meta.bpm || 120; this.originalBpm = meta.originalBpm || 120; this.key = meta.key || '--';
      this.engine.setBPM(this.bpm); this.engine.setOriginalBPM(this.originalBpm);
      for (const tm of meta.tracks) {
        const track = { ...tm, nodes: null, clips: [] };
        track.reverb = tm.reverb ?? 0;
        track.nodes = this.engine.createTrackNodes(track);
        track.nodes.gainNode.gain.value = track.volume;
        track.nodes.panNode.pan.value = track.pan;
        track.nodes.reverbWet.gain.value = track.reverb;
        track.nodes.reverbDry.gain.value = 1 - track.reverb * 0.5;
        for (const cm of tm.clips) {
          const buf = await SF2Storage.loadBuffer(cm.bufKey, this.engine.ctx);
          if (!buf) continue;
          track.clips.push({ id: cm.id, name: cm.name, buffer: buf, startTime: cm.startTime, duration: cm.duration, offset: cm.offset, _gain: cm._gain, _saved: true });
          if (!this.originalBuffers.has(track.id)) this.originalBuffers.set(track.id, buf);
        }
        this.tracks.push(track);
      }
      this.engine.tracks = this.tracks;
      this._refreshAll();
      this._setStep('adjust');
      this.toast('前回のプロジェクトを復元しました');
    } catch (e) { /* no project to restore */ }
  }

  // ---------- keyboard ----------
  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.matches('input, textarea, select')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
      switch (e.key) {
        case ' ': e.preventDefault(); this.togglePlay(); break;
        case 'Home': this.seek(0); break;
        case 'End': this.seek(this.projectDuration); break;
        case 'ArrowLeft': this.seek(this.engine.currentTime - 10); break;
        case 'ArrowRight': this.seek(this.engine.currentTime + 10); break;
        case '+': case '=': this.setZoom(this.zoom * 1.3); break;
        case '-': this.setZoom(this.zoom / 1.3); break;
        case 'l': case 'L': this.toggleLoop(); break;
        case 'Escape': this.selectedClipId = null; this._renderTracks(); break;
        case 'Delete': this.deleteSelectedClip(); break;
        case '?': if (e.shiftKey) this._openModal('shortcuts'); break;
      }
    });
  }

  _bindGlobal() {
    $('btn-logout').onclick = () => { SF2Auth.clearSession(); location.reload(); };
    const help = $('btn-pro-help');
    if (help) help.onclick = () => this.openGuide();

    // Undo coverage for sliders: capture state once at the start of any range
    // drag (faders, EQ knobs, pan, reverb, mastering, part cards, clip gain),
    // so a whole drag becomes a single, undoable change.
    let _sliderEditing = false;
    document.addEventListener('pointerdown', e => {
      if (!_sliderEditing && e.target.matches && e.target.matches('input[type="range"]')) {
        this._pushUndo();
        _sliderEditing = true;
      }
    });
    document.addEventListener('pointerup', () => { _sliderEditing = false; });
  }

  // 使い方ガイドを別タブで開く（同一オリジンの静的ページ）
  openGuide() {
    window.open('guide.html', 'sf2guide', 'noopener');
  }
}

// ===================== bootstrap =====================
function startApp() {
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  window.daw = new StudioFlowDAW2();
  window.daw.init();
}

function setupLogin() {
  const form = $('login-form');
  const errEl = $('login-error');
  const pwInput = $('login-password');

  $('btn-toggle-pw').onclick = () => {
    pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
  };

  // First run: no custom hash and the bundled default hash is a placeholder,
  // so let the first login set the password.
  const firstRun = !localStorage.getItem('sf2_pw_hash');

  form.onsubmit = async e => {
    e.preventDefault();
    const pw = pwInput.value;
    if (!pw) return;
    if (firstRun) {
      await SF2Auth.setPassword(pw);
      SF2Auth.createSession();
      startApp();
      return;
    }
    const ok = await SF2Auth.verifyPassword(pw);
    if (ok) { SF2Auth.createSession(); startApp(); }
    else { errEl.classList.remove('hidden'); pwInput.value = ''; }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  if (SF2Auth.isSessionValid()) startApp();
  else setupLogin();
});
