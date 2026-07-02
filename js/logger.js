// logger.js - Lightweight logging + global error capture for StudioFlow 2.
// Keeps a ring buffer of recent entries so problems can be inspected after the
// fact (SF2Log.dump() in the console, or SF2Log.download() for a file).
// Loaded before every other script so they can all use it.

(function () {
  const MAX_ENTRIES = 300;
  const entries = [];
  let toastFn = null;   // set by app.js after the DAW is ready

  const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

  function push(level, args) {
    const msg = args.map(a => {
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ');
    entries.push(`[${ts()}] [${level.toUpperCase()}] ${msg}`);
    if (entries.length > MAX_ENTRIES) entries.shift();
    return msg;
  }

  const SF2Log = {
    debug(...a) { push('debug', a); },
    info(...a)  { push('info', a);  console.info('[SF2]', ...a); },
    warn(...a)  { push('warn', a);  console.warn('[SF2]', ...a); },
    error(...a) { const m = push('error', a); console.error('[SF2]', ...a); return m; },

    // Show the user a toast for an error (falls back to console only).
    notify(userMsg, err) {
      if (err) this.error(userMsg, err); else this.error(userMsg);
      if (toastFn) { try { toastFn(userMsg); } catch {} }
    },

    setToast(fn) { toastFn = fn; },

    dump() { return entries.join('\n'); },

    download() {
      const blob = new Blob([entries.join('\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `studioflow2-log-${Date.now()}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
  };

  // ---- global error capture: silent failures become visible ----
  window.addEventListener('error', e => {
    // Resource load errors (script/img) have no error object
    const detail = e.error || `${e.message} @ ${e.filename}:${e.lineno}`;
    SF2Log.error('未処理エラー:', detail);
    if (toastFn) { try { toastFn('エラーが発生しました（F12コンソール参照）'); } catch {} }
  });

  window.addEventListener('unhandledrejection', e => {
    SF2Log.error('未処理のPromise失敗:', e.reason instanceof Error ? e.reason : String(e.reason));
    if (toastFn) { try { toastFn('処理に失敗しました（F12コンソール参照）'); } catch {} }
    e.preventDefault();   // avoid duplicate default console noise; we logged it
  });

  window.SF2Log = SF2Log;
})();
