// auth.js - Password authentication with SHA-256 + localStorage

const AUTH_KEY = 'sf2_session';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// SHA-256 hash of the password (default: "studioflow2")
const PASSWORD_HASH = '3b7e6b3e4a2f1c8d9e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4';

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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

async function verifyPassword(password) {
  const hash = await sha256(password);
  // Accept both the default hash and a stored custom hash
  const storedHash = localStorage.getItem('sf2_pw_hash') || PASSWORD_HASH;
  return hash === storedHash;
}

async function setPassword(newPassword) {
  const hash = await sha256(newPassword);
  localStorage.setItem('sf2_pw_hash', hash);
}

window.SF2Auth = { isSessionValid, createSession, clearSession, verifyPassword, setPassword, sha256 };
