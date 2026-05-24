/**
 * FileAccess – ECPay + File Proxy Server
 * Hosted free on Render.com (no credit card required)
 *
 * Required environment variables (set in Render dashboard):
 *   ECPAY_HASH_KEY           – from ECPay merchant backend → API介接 → HashKey
 *   ECPAY_HASH_IV            – from ECPay merchant backend → API介接 → HashIV
 *   ECPAY_MERCHANT_ID        – your ECPay MerchantID
 *   FIREBASE_DATABASE_URL    – e.g. https://your-project-default-rtdb.firebaseio.com
 *   FIREBASE_SERVICE_ACCOUNT – full JSON string of your Firebase service account key
 *   SUPABASE_URL             – e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY     – Supabase service_role key (keep secret, server-only)
 *   SUPABASE_BUCKET          – storage bucket name, e.g. fileaccess
 *   SITE_URL                 – your Firebase Hosting URL, e.g. https://your-project.web.app
 *   SERVER_URL               – this server's URL, e.g. https://fileaccess-ecpay.onrender.com
 *   PORT                     – set automatically by Render (default 10000)
 */

const express     = require("express");
const cors        = require("cors");
const crypto      = require("crypto");
const admin       = require("firebase-admin");
const rateLimit   = require("express-rate-limit");
const helmet      = require("helmet");
const multer      = require("multer");
const fetch       = require("node-fetch");
const fs          = require("fs");
const path        = require("path");
const os          = require("os");

// ── Firebase init ──────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

// ── Express ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 10000;

// ── Trust Render's reverse proxy so express-rate-limit reads the real client IP ──
// Render terminates TLS and forwards requests via a single trusted proxy hop.
app.set("trust proxy", 1);

// ── Security headers (Helmet) ──────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // allow Supabase CDN images
  contentSecurityPolicy: false  // CSP is set on Firebase Hosting side
}));

// ── CORS: only allow requests from our Firebase Hosting domain ─────────────
const allowedOrigin = process.env.SITE_URL || "https://access-control-system-335f5.web.app";
app.use(cors({ origin: allowedOrigin }));

// ── Body parsing with size limits ──────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

// ── Multer for file uploads (memory storage, no size limit) ───────────────
const upload = multer({
  storage: multer.memoryStorage(),
});

// ── Rate limiters ──────────────────────────────────────────────────────────
const ecpayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});
const fileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // raised: chunked uploads can produce ~100 requests per large file
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});

app.use("/ecpay/", ecpayLimiter);
app.use("/files/", fileLimiter);

// ── Supabase helpers ───────────────────────────────────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL    || "";
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "fileaccess";

function supabaseHeaders() {
  return {
    "apikey":        SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
  };
}

// ── Verify Firebase ID Token helper ───────────────────────────────────────
async function verifyToken(req, res) {
  const auth = req.headers.authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : req.body?.idToken;
  if (!idToken) { res.status(401).json({ error: "Missing token" }); return null; }
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
}

// ── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("FileAccess server is running ✓"));

// ════════════════════════════════════════════════════════════════════════════
// FILE ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// ── GET /files/signed-url?fileId=xxx ─────────────────────────────────────
// Returns a 15-minute Supabase signed URL after verifying the user has access
app.get("/files/signed-url", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const uid    = decoded.uid;
  const fileId = req.query.fileId;
  if (!fileId) return res.status(400).json({ error: "Missing fileId" });

  // Check access
  try {
    const now = Date.now();
    const accessSnap = await db.ref(`access/${uid}/${fileId}`).once("value");
    if (!accessSnap.exists()) return res.status(403).json({ error: "Access denied" });
    const access = accessSnap.val();
    if (!access.granted) return res.status(403).json({ error: "Access denied" });
    if (access.expiresAt && access.expiresAt < now) return res.status(403).json({ error: "Access expired" });
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  // Get file record to find the storage path
  // Always use the raw storagePath field (never extract from the URL,
  // which contains an already-encoded path and would cause double-encoding).
  let filePath;
  try {
    const fileSnap = await db.ref(`files/${fileId}`).once("value");
    if (!fileSnap.exists()) return res.status(404).json({ error: "File not found" });
    const fileData = fileSnap.val();
    filePath = fileData.storagePath || "";
    // Legacy fallback: if storagePath is missing, extract raw path from URL and decode it
    if (!filePath && fileData.url) {
      const marker = `/object/public/${SUPABASE_BUCKET}/`;
      const idx = fileData.url.indexOf(marker);
      if (idx !== -1) filePath = decodeURIComponent(fileData.url.slice(idx + marker.length));
    }
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  if (!filePath) return res.status(500).json({ error: "Cannot resolve file path" });

  // Request signed URL from Supabase (900 seconds = 15 minutes)
  // encodeURIComponent the raw storagePath exactly once here.
  try {
    const supaRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${SUPABASE_BUCKET}/${encodeURIComponent(filePath)}`,
      {
        method: "POST",
        headers: { ...supabaseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 900 })
      }
    );
    if (!supaRes.ok) {
      const err = await supaRes.text();
      console.error("Supabase sign error:", err);
      return res.status(500).json({ error: "Could not generate signed URL" });
    }
    const { signedURL } = await supaRes.json();
    return res.json({ signedUrl: `${SUPABASE_URL}/storage/v1${signedURL}` });
  } catch (err) {
    console.error("Signed URL error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /files/upload ────────────────────────────────────────────────────
// Admin-only: uploads file to Supabase, saves metadata to Firebase
app.post("/files/upload", upload.single("file"), async (req, res) => {
  // Verify token and admin status
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const uid = decoded.uid;

  try {
    const adminSnap = await db.ref(`admins/${uid}`).once("value");
    if (!adminSnap.exists()) return res.status(403).json({ error: "Admin only" });
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file provided" });

  // Validate MIME type (allowlist)
  const ALLOWED_MIMES = [
    "application/pdf","application/epub+zip",
    "image/png","image/jpeg","image/gif","image/webp","image/svg+xml",
    "text/html","text/plain","text/markdown","text/csv",
    "video/mp4","video/webm","audio/mpeg","audio/wav",
    "model/stl","application/octet-stream",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip","application/x-rar-compressed"
  ];
  if (!ALLOWED_MIMES.includes(file.mimetype)) {
    return res.status(400).json({ error: "File type not allowed" });
  }

  // Upload to Supabase
  const storagePath = `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  try {
    const supaRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${encodeURIComponent(storagePath)}`,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(),
          "Content-Type": file.mimetype,
          "x-upsert": "false"
        },
        body: file.buffer
      }
    );
    if (!supaRes.ok) {
      const err = await supaRes.text();
      console.error("Supabase upload error:", err);
      return res.status(500).json({ error: "Upload failed" });
    }
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }

  // Save metadata to Firebase /files
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${encodeURIComponent(storagePath)}`;
  const fileRef = db.ref("files").push();
  const fileData = {
    name:        file.originalname,
    type:        file.mimetype,
    size:        file.size,
    storagePath, // keep storage path for signed URL generation
    url:         publicUrl,
    uploadedBy:  uid,
    uploadedAt:  Date.now()
  };
  try {
    await fileRef.set(fileData);
  } catch (err) {
    console.error("Firebase write error:", err);
    return res.status(500).json({ error: "Metadata save failed" });
  }

  // Activity log
  db.ref("logs").push({
    action:    "file_upload",
    uid,
    email:     "",
    name:      "",
    timestamp: Date.now(),
    fileName:  file.originalname,
    fileId:    fileRef.key,
    fileSize:  file.size
  }).catch(() => {});

  return res.json({ fileId: fileRef.key, url: publicUrl, storagePath });
});

// ════════════════════════════════════════════════════════════════════════════
// CHUNKED UPLOAD ENDPOINTS  (for files > 100 MB)
//
// Flow:
//   1. Client slices the file into 5 MB chunks.
//   2. For each chunk: POST /files/upload-chunk  { uploadId, chunkIndex, totalChunks, file }
//      → server writes the chunk to a temp dir on disk (never fully in RAM).
//   3. After all chunks arrive: POST /files/upload-merge  { uploadId, filename, mimetype, totalChunks }
//      → server concatenates chunks, streams the result to Supabase, then cleans up.
// ════════════════════════════════════════════════════════════════════════════

// Multer instance that writes chunks to disk (not memory)
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Each upload gets its own temp subdirectory named by uploadId
      const dir = path.join(os.tmpdir(), "fileaccess_chunks", req.body.uploadId || "unknown");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Name each chunk file by its index so we can reassemble in order
      const idx = parseInt(req.body.chunkIndex, 10);
      cb(null, `chunk_${String(idx).padStart(6, "0")}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max per chunk request (chunks are 5 MB)
});

// ── POST /files/upload-chunk ──────────────────────────────────────────────
// Receives one chunk. Body fields: uploadId, chunkIndex, totalChunks
app.post("/files/upload-chunk", chunkUpload.single("file"), async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const uid = decoded.uid;

  try {
    const adminSnap = await db.ref(`admins/${uid}`).once("value");
    if (!adminSnap.exists()) return res.status(403).json({ error: "Admin only" });
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  const { uploadId, chunkIndex, totalChunks } = req.body;
  if (!uploadId || chunkIndex === undefined || !totalChunks) {
    return res.status(400).json({ error: "Missing uploadId, chunkIndex, or totalChunks" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No chunk data received" });
  }

  // Chunk was already written to disk by multer — nothing else to do here.
  return res.json({ ok: true, chunkIndex: parseInt(chunkIndex, 10) });
});

// ── POST /files/upload-merge ──────────────────────────────────────────────
// Merges all chunks, streams to Supabase, saves metadata, cleans up temp files.
// Body (JSON): { uploadId, filename, mimetype, totalChunks }
app.post("/files/upload-merge", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const uid = decoded.uid;

  try {
    const adminSnap = await db.ref(`admins/${uid}`).once("value");
    if (!adminSnap.exists()) return res.status(403).json({ error: "Admin only" });
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  const { uploadId, filename, mimetype, totalChunks } = req.body;
  if (!uploadId || !filename || !mimetype || !totalChunks) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const ALLOWED_MIMES = [
    "application/pdf","application/epub+zip",
    "image/png","image/jpeg","image/gif","image/webp","image/svg+xml",
    "text/html","text/plain","text/markdown","text/csv",
    "video/mp4","video/webm","audio/mpeg","audio/wav",
    "model/stl","application/octet-stream",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip","application/x-rar-compressed"
  ];
  if (!ALLOWED_MIMES.includes(mimetype)) {
    return res.status(400).json({ error: "File type not allowed" });
  }

  const chunkDir    = path.join(os.tmpdir(), "fileaccess_chunks", uploadId);
  const mergedPath  = path.join(os.tmpdir(), "fileaccess_chunks", `${uploadId}_merged`);
  const numChunks   = parseInt(totalChunks, 10);

  // Verify all chunks exist before we start writing
  for (let i = 0; i < numChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(6, "0")}`);
    if (!fs.existsSync(chunkPath)) {
      return res.status(400).json({ error: `Missing chunk ${i}` });
    }
  }

  // Concatenate chunks into a single temp file
  try {
    const out = fs.createWriteStream(mergedPath);
    await new Promise((resolve, reject) => {
      out.on("error", reject);
      (async () => {
        for (let i = 0; i < numChunks; i++) {
          const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(6, "0")}`);
          await new Promise((res2, rej2) => {
            const inp = fs.createReadStream(chunkPath);
            inp.on("error", rej2);
            inp.on("end", res2);
            inp.pipe(out, { end: false });
          });
        }
        out.end();
      })().catch(reject);
      out.on("finish", resolve);
    });
  } catch (err) {
    console.error("Chunk merge error:", err);
    return res.status(500).json({ error: "Failed to merge chunks" });
  }

  // Get final file size
  const fileSize = fs.statSync(mergedPath).size;

  // Stream the merged file to Supabase
  const storagePath = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  try {
    const fileStream = fs.createReadStream(mergedPath);
    const supaRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${encodeURIComponent(storagePath)}`,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(),
          "Content-Type": mimetype,
          "Content-Length": String(fileSize),
          "x-upsert": "false"
        },
        body: fileStream
      }
    );
    if (!supaRes.ok) {
      const err = await supaRes.text();
      console.error("Supabase chunked upload error:", err);
      return res.status(500).json({ error: "Upload to storage failed" });
    }
  } catch (err) {
    console.error("Supabase stream error:", err);
    return res.status(500).json({ error: "Upload to storage failed" });
  } finally {
    // Clean up temp files regardless of outcome
    try { fs.rmSync(path.join(os.tmpdir(), "fileaccess_chunks", uploadId), { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(mergedPath); } catch {}
  }

  // Save metadata to Firebase
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${encodeURIComponent(storagePath)}`;
  const fileRef   = db.ref("files").push();
  const fileData  = {
    name:        filename,
    type:        mimetype,
    size:        fileSize,
    storagePath,
    url:         publicUrl,
    uploadedBy:  uid,
    uploadedAt:  Date.now()
  };
  try {
    await fileRef.set(fileData);
  } catch (err) {
    console.error("Firebase write error:", err);
    return res.status(500).json({ error: "Metadata save failed" });
  }

  // Activity log
  db.ref("logs").push({
    action:    "file_upload",
    uid,
    email:     "",
    name:      "",
    timestamp: Date.now(),
    fileName:  filename,
    fileId:    fileRef.key,
    fileSize
  }).catch(() => {});

  return res.json({ fileId: fileRef.key, url: publicUrl, storagePath });
});

// ── DELETE /files/:fileId ─────────────────────────────────────────────────
// Admin-only: deletes from Supabase + Firebase
app.delete("/files/:fileId", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const uid    = decoded.uid;
  const fileId = req.params.fileId;

  // Check admin
  try {
    const adminSnap = await db.ref(`admins/${uid}`).once("value");
    if (!adminSnap.exists()) return res.status(403).json({ error: "Admin only" });
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  // Get file metadata
  let fileData;
  try {
    const snap = await db.ref(`files/${fileId}`).once("value");
    if (!snap.exists()) return res.status(404).json({ error: "File not found" });
    fileData = snap.val();
  } catch {
    return res.status(500).json({ error: "DB error" });
  }

  // Delete from Supabase — use raw storagePath to avoid double-encoding.
  // Legacy fallback: decode from URL if storagePath is missing.
  const storagePath = fileData.storagePath || (() => {
    const marker = `/object/public/${SUPABASE_BUCKET}/`;
    const idx = (fileData.url || "").indexOf(marker);
    return idx !== -1 ? decodeURIComponent(fileData.url.slice(idx + marker.length)) : "";
  })();

  if (storagePath) {
    try {
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${encodeURIComponent(storagePath)}`,
        { method: "DELETE", headers: supabaseHeaders() }
      );
    } catch (err) {
      console.warn("Supabase delete warning:", err.message);
      // non-fatal — continue with Firebase cleanup
    }
  }

  // Delete from Firebase (files + access + products.fileIds)
  const updates = { [`files/${fileId}`]: null };
  try {
    const [accessSnap, productsSnap] = await Promise.all([
      db.ref("access").once("value"),
      db.ref("products").once("value")
    ]);
    if (accessSnap.exists()) {
      Object.keys(accessSnap.val()).forEach(u => {
        if (accessSnap.val()[u][fileId]) updates[`access/${u}/${fileId}`] = null;
      });
    }
    if (productsSnap.exists()) {
      Object.entries(productsSnap.val()).forEach(([pk, p]) => {
        if (Array.isArray(p.fileIds) && p.fileIds.includes(fileId)) {
          updates[`products/${pk}/fileIds`] = p.fileIds.filter(id => id !== fileId);
        }
      });
    }
    await db.ref().update(updates);
  } catch (err) {
    return res.status(500).json({ error: "Firebase cleanup failed" });
  }

  // Log
  db.ref("logs").push({
    action: "file_delete", uid, timestamp: Date.now(),
    fileName: fileData.name, fileId
  }).catch(() => {});

  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ECPAY ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// ── ECPay CheckMacValue verification ──────────────────────────────────────
function verifyCheckMacValue(params) {
  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIV  = process.env.ECPAY_HASH_IV;
  if (!hashKey || !hashIV) { console.error("ECPAY keys not set"); return false; }
  const received = params.CheckMacValue;
  if (!received) return false;

  const sorted = Object.keys(params)
    .filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${params[k]}`)
    .join("&");

  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  const encoded = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%20/g, "+").replace(/%21/g, "!").replace(/%27/g, "'")
    .replace(/%28/g, "(").replace(/%29/g, ")").replace(/%2a/g, "*");

  return crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase() === received;
}

// ── POST /ecpay/callback ───────────────────────────────────────────────────
app.post("/ecpay/callback", async (req, res) => {
  const params = req.body;

  console.log("ECPay callback:", {
    MerchantTradeNo: params.MerchantTradeNo,
    RtnCode: params.RtnCode,
    PaymentType: params.PaymentType
  });

  if (!verifyCheckMacValue(params)) {
    console.error("CheckMacValue failed");
    return res.send("0|CheckMacValue error");
  }

  const rtnCode   = parseInt(params.RtnCode, 10);
  const isSuccess = rtnCode === 1 || rtnCode === 2;
  if (!isSuccess) return res.send("1|OK");

  const tradeNo = params.MerchantTradeNo || "";

  // ── Idempotency: prevent double-processing on ECPay retry ─────────────────
  let tradeData;
  try {
    const mapSnap = await db.ref(`tradeMap/${tradeNo}`).once("value");
    if (!mapSnap.exists()) { console.error("tradeMap not found:", tradeNo); return res.send("0|Trade not found"); }
    tradeData = mapSnap.val();
    if (tradeData.processed) {
      console.log("Already processed, skipping:", tradeNo);
      return res.send("1|OK");
    }
  } catch (err) {
    console.error("tradeMap read error:", err);
    return res.send("0|DB read error");
  }

  const { uid, productKey } = tradeData;
  if (!uid || !productKey) return res.send("0|Missing uid or productKey");

  // Mark as processed immediately (idempotency lock)
  try {
    await db.ref(`tradeMap/${tradeNo}/processed`).set(true);
  } catch { /* non-fatal, continue */ }

  // Load product
  let product;
  try {
    const snap = await db.ref(`products/${productKey}`).once("value");
    if (!snap.exists()) { console.error("Product not found:", productKey); return res.send("0|Product not found"); }
    product = snap.val();
  } catch (err) {
    console.error("Firebase read error:", err);
    return res.send("0|DB read error");
  }

  // Grant access
  const fileIds      = product.fileIds || [];
  const durationDays = product.durationDays || null;
  const now          = Date.now();
  const expiresAt    = durationDays ? now + durationDays * 24 * 60 * 60 * 1000 : null;

  const updates = {};
  for (const fileId of fileIds) {
    const entry = { granted: true, grantedAt: now, grantedBy: "ecpay" };
    if (expiresAt) entry.expiresAt = expiresAt;
    updates[`access/${uid}/${fileId}`] = entry;
  }

  const purchaseKey = db.ref("purchases").push().key;
  updates[`purchases/${uid}/${purchaseKey}`] = {
    merchantTradeNo: tradeNo, productKey,
    productName: product.name || "", fileIds,
    amount: params.TradeAmt || 0, paymentType: params.PaymentType || "",
    paymentDate: params.PaymentDate || "", purchasedAt: now,
    expiresAt: expiresAt || null
  };

  const logKey = db.ref("logs").push().key;
  updates[`logs/${logKey}`] = {
    action: "purchase", uid, email: "", name: "", timestamp: now,
    productName: product.name || "", fileIds, tradeNo, amount: params.TradeAmt || 0
  };

  try {
    await db.ref().update(updates);
    console.log(`✓ Access granted: uid=${uid}, files=${fileIds.join(",")}`);
  } catch (err) {
    console.error("Firebase write error:", err);
    return res.send("0|DB write error");
  }

  return res.send("1|OK");
});

// ── POST /ecpay/create-order ───────────────────────────────────────────────
app.post("/ecpay/create-order", async (req, res) => {
  const { productKey, idToken } = req.body;
  if (!productKey || !idToken) return res.status(400).json({ error: "Missing productKey or idToken" });

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIV  = process.env.ECPAY_HASH_IV;
  if (!hashKey || !hashIV) return res.status(500).json({ error: "Server not configured" });

  let product;
  try {
    const snap = await db.ref(`products/${productKey}`).once("value");
    if (!snap.exists()) return res.status(404).json({ error: "Product not found" });
    product = snap.val();
  } catch { return res.status(500).json({ error: "DB error" }); }

  // Use 5 cryptographically random hex chars (not timestamp % 100000 which cycles every ~28h
  // and can collide for the same user+product pair within that window).
  const randSuffix = crypto.randomBytes(3).toString("hex").slice(0, 5); // 5 hex chars
  const shortPK    = productKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 5).padEnd(5, "0");
  const shortUID   = uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
  const merchantTradeNo = `${shortPK}${shortUID}${randSuffix}`; // 5+10+5 = 20 chars max

  try {
    await db.ref(`tradeMap/${merchantTradeNo}`).set({ uid, productKey, createdAt: Date.now() });
  } catch(e) { /* non-fatal */ }

  const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;
  const siteUrl   = process.env.SITE_URL   || allowedOrigin;

  const now_tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, "0");
  const tradeDate = `${now_tw.getUTCFullYear()}/${pad(now_tw.getUTCMonth()+1)}/${pad(now_tw.getUTCDate())} ${pad(now_tw.getUTCHours())}:${pad(now_tw.getUTCMinutes())}:${pad(now_tw.getUTCSeconds())}`;

  const safeName = (product.name || "File Access").replace(/[#%&+]/g, "").slice(0, 200);

  const ecpayParams = {
    MerchantID:        product.merchantId || process.env.ECPAY_MERCHANT_ID || "",
    MerchantTradeNo:   merchantTradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType:       "aio",
    TotalAmount:       String(Math.round(product.priceNTD || 0)),
    TradeDesc:         safeName,
    ItemName:          safeName,
    ReturnURL:         `${serverUrl}/ecpay/callback`,
    OrderResultURL:    `${siteUrl}/index.html?payment=done`,
    ChoosePayment:     product.paymentMethod || "Credit",
    EncryptType:       "1",
  };

  const sorted = Object.keys(ecpayParams)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${ecpayParams[k]}`).join("&");
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  const encoded = encodeURIComponent(raw).toLowerCase()
    .replace(/%20/g, "+").replace(/%21/g, "!").replace(/%27/g, "'")
    .replace(/%28/g, "(").replace(/%29/g, ")").replace(/%2a/g, "*");
  ecpayParams.CheckMacValue = crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase();

  const ecpayUrl = product.useSandbox
    ? "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5"
    : "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5";

  return res.json({ ecpayUrl, params: ecpayParams });
});

app.listen(PORT, () => console.log(`FileAccess server listening on port ${PORT}`));
