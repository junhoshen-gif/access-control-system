// ─────────────────────────────────────────────────────────────────────────────
// Firebase Configuration
// Auth is used everywhere. File/product operations go through the Render
// server, but several pages (register/login profile writes, status/diag
// health checks) still talk to the Realtime Database directly via the
// client SDK — those calls need databaseURL to know which DB to hit.
// ─────────────────────────────────────────────────────────────────────────────
export const firebaseConfig = {
  apiKey:            "AIzaSyBmFB_qE4BYU3HA1bruC8nm0P1pnRFy7gM",
  authDomain:        "access-control-system-335f5.firebaseapp.com",
  databaseURL:       "https://access-control-system-335f5-default-rtdb.firebaseio.com",
  projectId:         "access-control-system-335f5",
  storageBucket:     "access-control-system-335f5.appspot.com",
  messagingSenderId: "551173243790",
  appId:             "1:551173243790:web:6116b77f164c1e67d81adf"
};

// ─────────────────────────────────────────────────────────────────────────────
// Render server URL  (all DB + file operations go through here)
// ─────────────────────────────────────────────────────────────────────────────
export const RENDER_SERVER_URL = "https://fileaccess-ecpay.onrender.com";

// ─────────────────────────────────────────────────────────────────────────────
// Safari-compatible fetch timeout helper
// ─────────────────────────────────────────────────────────────────────────────
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers  — now proxy through Render server → Windows EXE
//
// All calls require a Firebase ID token for auth.
// The Render server verifies the token, then forwards to the Windows EXE.
//
// API mirrors the old Firebase REST shape so admin.html needs minimal changes:
//   dbGet(auth, "files")               → GET  /db/files
//   dbGet(auth, "admins/uid")          → GET  /db/admins/uid
//   dbSet(auth, "users/uid", {...})    → PUT  /db/users/uid
//   dbDelete(auth, "logs")             → DELETE /db/logs
//   dbPatch(auth, "", {updates})       → POST /db/   (multi-path)
//   dbPush(auth, "logs", {...})        → POST /db/logs
// ─────────────────────────────────────────────────────────────────────────────

async function getIdToken(auth) {
  try {
    const user = auth.currentUser;
    if (user) return await user.getIdToken();
  } catch (_) {}
  return null;
}

export async function dbGet(auth, dbPath) {
  const token = await getIdToken(auth);
  const url   = `${RENDER_SERVER_URL}/db/${dbPath}`;
  const res   = await fetchWithTimeout(url, {
    headers: token ? { "Authorization": `Bearer ${token}` } : {}
  }, 15000);
  if (!res.ok) throw new Error(`DB GET ${dbPath} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function dbDelete(auth, dbPath) {
  const token = await getIdToken(auth);
  const url   = `${RENDER_SERVER_URL}/db/${dbPath}`;
  const res   = await fetchWithTimeout(url, {
    method: "DELETE",
    headers: token ? { "Authorization": `Bearer ${token}` } : {}
  }, 15000);
  if (!res.ok) throw new Error(`DB DELETE ${dbPath} → ${res.status}`);
  return res.json();
}

export async function dbPatch(auth, dbPath, value) {
  const token = await getIdToken(auth);
  // Empty path = multi-path update → POST /db/
  const url = dbPath
    ? `${RENDER_SERVER_URL}/db/${dbPath}`
    : `${RENDER_SERVER_URL}/db/`;
  const method = dbPath ? "PATCH" : "POST";
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    },
    body: JSON.stringify(value)
  }, 15000);
  if (!res.ok) throw new Error(`DB PATCH ${dbPath} → ${res.status}`);
  return res.json();
}

export async function dbPush(auth, dbPath, value) {
  const token = await getIdToken(auth);
  const url   = `${RENDER_SERVER_URL}/db/${dbPath}`;
  const res   = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    },
    body: JSON.stringify(value)
  }, 15000);
  if (!res.ok) throw new Error(`DB POST ${dbPath} → ${res.status}`);
  return res.json(); // returns { name: "-abc123..." }
}

export async function dbSet(auth, dbPath, value) {
  const token = await getIdToken(auth);
  const url   = `${RENDER_SERVER_URL}/db/${dbPath}`;
  const res   = await fetchWithTimeout(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    },
    body: JSON.stringify(value)
  }, 15000);
  if (!res.ok) throw new Error(`DB PUT ${dbPath} → ${res.status}`);
  return res.json();
}
