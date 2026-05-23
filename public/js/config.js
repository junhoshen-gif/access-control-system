// ─────────────────────────────────────────────────────────────────────────────
// Firebase Configuration
// Replace these values with your actual Firebase project settings.
// Find them in: Firebase Console → Project Settings → Your Apps → SDK setup
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
// Safari-compatible fetch timeout helper
// AbortSignal.timeout() is only available in Safari 16.4+; this polyfill works
// back to Safari 12 using AbortController + setTimeout.
// ─────────────────────────────────────────────────────────────────────────────
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────────────────────────────────────
// Firebase REST helper — bypasses SDK WebSocket entirely (Safari-safe)
// Safari blocks authenticated WebSocket connections; plain HTTPS always works.
// Usage: await dbGet(auth, "admins/uid123")  → returns the value or null
// ─────────────────────────────────────────────────────────────────────────────
export async function dbGet(auth, path) {
  const DB_URL = "https://access-control-system-335f5-default-rtdb.firebaseio.com";
  let token = null;
  try {
    const user = auth.currentUser;
    if (user) token = await user.getIdToken();
  } catch (_) {}

  const url = `${DB_URL}/${path}.json${token ? `?auth=${token}` : ""}`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) throw new Error(`DB REST ${res.status}: ${await res.text()}`);
  return await res.json(); // null if node doesn't exist
}

// REST PUT — bypasses SDK WebSocket for writes too
export async function dbSet(auth, path, value) {
  const DB_URL = "https://access-control-system-335f5-default-rtdb.firebaseio.com";
  let token = null;
  try {
    const user = auth.currentUser;
    if (user) token = await user.getIdToken();
  } catch (_) {}

  const url = `${DB_URL}/${path}.json${token ? `?auth=${token}` : ""}`;
  const res = await fetchWithTimeout(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value)
  }, 10000);
  if (!res.ok) throw new Error(`DB REST PUT ${res.status}: ${await res.text()}`);
  return await res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase Configuration
// Find these in: Supabase Dashboard → Project Settings → API
//   supabaseUrl   → "Project URL"
//   supabaseKey   → "anon / public" key  (safe to expose in browser)
// bucketName: the name of the Storage bucket you create in Supabase
// ─────────────────────────────────────────────────────────────────────────────
export const supabaseConfig = {
  supabaseUrl: "https://afzkjvtbrjhorspenfzy.supabase.co",
  supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmemtqdnRicmpob3JzcGVuZnp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTA5OTUsImV4cCI6MjA5NDY2Njk5NX0.u5qsoBWqtpGVoa_c1S8N6bUWz5L9jS7gdfqugvd5u1g",
  bucketName:  "fileaccess"
};
