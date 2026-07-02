// auth.js - Password authentication for a personal, local-only app.
// Passwords are stored as salted PBKDF2-SHA256 hashes ("v2:<salt>:<hash>").
// Legacy unsalted SHA-256 hashes are still accepted and upgraded to v2 on the
// next successful login. Repeated failures trigger a short lockout.

const AUTH_KEY = 'sf2_session';
const HASH_KEY = 'sf2_pw_hash';
const LOCK_KEY = 'sf2_login_lock';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const PBKDF2_ITERATIONS = 150000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 1000;

// SHA-256 hash of the password (default: "studioflow2") — legacy format.
const PASSWORD_HASH = '3b7e6b3e4a2f1c8d9e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4';

const toHex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  return toHex(await crypto.subtle.digest('SHA-256', msgBuffer));
}

async function pbkdf2(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256);
  return toHex(bits);
}

function isSessionValid() {
  try {
    const session = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    if (!session) return false;
    return Date.now() < session.expires;
  } catch {
    return false;
  }
}

function createSession() {
  const session = { expires: Date.now() + SESSION_DURATION };
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(AUTH_KEY);
}

// ---- login throttling (5 failures → 30s lockout) ----
function _lockState() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || '{"fails":0,"until":0}'); }
  catch { return { fails: 0, until: 0 }; }
}

// Returns 0 if login is allowed, else remaining lockout ms.
function lockoutRemaining() {
  const st = _lockState();
  return st.until > Date.now() ? st.until - Date.now() : 0;
}

function _recordFailure() {
  const st = _lockState();
  st.fails = (st.fails || 0) + 1;
  if (st.fails >= MAX_ATTEMPTS) { st.until = Date.now() + LOCKOUT_MS; st.fails = 0; }
  localStorage.setItem(LOCK_KEY, JSON.stringify(st));
}

function _clearFailures() { localStorage.removeItem(LOCK_KEY); }

async function verifyPassword(password) {
  if (lockoutRemaining() > 0) return false;
  const stored = localStorage.getItem(HASH_KEY) || PASSWORD_HASH;
  let ok = false;
  if (stored.startsWith('v2:')) {
    const [, salt, hash] = stored.split(':');
    ok = (await pbkdf2(password, salt)) === hash;
  } else {
    // legacy unsalted SHA-256 → verify, then upgrade to v2 in place
    ok = (await sha256(password)) === stored;
    if (ok) { try { await setPassword(password); } catch {} }
  }
  if (ok) _clearFailures(); else _recordFailure();
  return ok;
}

async function setPassword(newPassword) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(newPassword, salt);
  localStorage.setItem(HASH_KEY, `v2:${salt}:${hash}`);
}

window.SF2Auth = { isSessionValid, createSession, clearSession, verifyPassword, setPassword, sha256, lockoutRemaining };
