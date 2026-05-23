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

// Note: All pages call forceLongPolling() from firebase-database.js to fix
// Safari ITP blocking authenticated WebSocket connections.

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
