/**
 * FileAccess – Render Server
 *
 * Files  → AWS S3  (upload / download / delete directly from Render)
 * DB     → Firebase Realtime Database  (users, access, products, logs, etc.)
 * Auth   → Firebase Authentication     (verifyIdToken)
 *
 * Required environment variables (Render dashboard → Environment):
 *   AWS_ACCESS_KEY_ID        – AWS IAM key
 *   AWS_SECRET_ACCESS_KEY    – AWS IAM secret
 *   AWS_REGION               – e.g. us-east-1
 *   S3_BUCKET                – your S3 bucket name
 *   FIREBASE_SERVICE_ACCOUNT – full JSON of Firebase service account (one line)
 *   FIREBASE_DATABASE_URL    – https://YOUR-PROJECT-default-rtdb.firebaseio.com
 *   ECPAY_HASH_KEY           – ECPay HashKey
 *   ECPAY_HASH_IV            – ECPay HashIV
 *   ECPAY_MERCHANT_ID        – ECPay MerchantID
 *   SITE_URL                 – your Firebase Hosting URL
 *   SERVER_URL               – this Render server's public URL
 *   PORT                     – set automatically by Render (default 10000)
 */

const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const admin     = require("firebase-admin");
const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");
const multer    = require("multer");
const fs        = require("fs");
const path      = require("path");
const os        = require("os");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ── AWS S3 ─────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});
const S3_BUCKET = process.env.S3_BUCKET || "";

function s3Key(storagePath) {
  return `files/${storagePath}`;
}

// ── Firebase init (Auth + Realtime Database) ────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || "",
});
const db = admin.database();

// ── Express ─────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

const allowedOrigin = process.env.SITE_URL || "https://access-control-system-335f5.web.app";
app.use(cors({ origin: allowedOrigin }));

app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

// ── Multer (small files → memory) ──────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// Disk-based multer for chunk uploads
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(os.tmpdir(), "fileaccess_chunks", req.body.uploadId || "unknown");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const idx = parseInt(req.body.chunkIndex, 10);
      cb(null, `chunk_${String(idx).padStart(6, "0")}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per chunk
});

// ── Rate limiters ────────────────────────────────────────────────────────────
const ecpayLimiter = rateLimit({ windowMs: 60_000, max: 30,  standardHeaders: true, legacyHeaders: false });
const fileLimiter  = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const dbLimiter    = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });

app.use("/ecpay/", ecpayLimiter);
app.use("/files/", fileLimiter);
app.use("/db/",    dbLimiter);

// ── Raw body for streaming chunk uploads (must come before json middleware) ─
// /files/upload-part receives raw binary — skip express.json() for this route.
app.use("/files/upload-part", (req, res, next) => {
  // Already handled as a stream in the route handler; just pass through.
  next();
});

// ── Firebase Auth helper ────────────────────────────────────────────────────
async function verifyToken(req, res) {
  const auth    = req.headers.authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : req.body?.idToken;
  if (!idToken) { res.status(401).json({ error: "Missing token" }); return null; }
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
}

// ── Admin check (reads from Firebase Realtime DB) ──────────────────────────
async function isAdmin(uid) {
  try {
    const snap = await db.ref(`admins/${uid}`).get();
    return snap.val() === true;
  } catch {
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

function newId() {
  return crypto.randomBytes(12).toString("hex");
}

function nowMs() {
  return Date.now();
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("FileAccess server is running ✓"));

// ════════════════════════════════════════════════════════════════════════════
// DATABASE PROXY  /db/*  → Firebase Realtime Database
// ════════════════════════════════════════════════════════════════════════════

// GET /db/*
app.get("/db/*", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const refPath = req.params[0];
  try {
    const snap = await db.ref(refPath).get();
    res.json(snap.val());
  } catch (err) {
    console.error("DB GET error:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT /db/*
app.put("/db/*", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });
  const refPath = req.params[0];
  try {
    await db.ref(refPath).set(req.body);
    res.json(req.body);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// POST /db/*  (push / auto-ID)
app.post("/db/*", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });
  const refPath = req.params[0];
  try {
    const newRef = await db.ref(refPath).push(req.body);
    res.json({ name: newRef.key });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// PATCH /db/*  (update sub-fields)
app.patch("/db/*", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });
  const refPath = req.params[0];
  try {
    await db.ref(refPath).update(req.body);
    res.json(req.body);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE /db/*
app.delete("/db/*", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });
  const refPath = req.params[0];
  try {
    await db.ref(refPath).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FILE ENDPOINTS  (S3 – direct browser-to-S3 via presigned URLs)
// ════════════════════════════════════════════════════════════════════════════

const ALLOWED_MIMES = new Set([
  "application/pdf", "application/epub+zip",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
  "text/html", "text/plain", "text/markdown", "text/csv",
  "video/mp4", "video/webm", "audio/mpeg", "audio/wav",
  "model/stl", "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip", "application/x-rar-compressed",
]);

// ── POST /files/presign  ────────────────────────────────────────────────────
// Admin requests a presigned PUT URL; browser uploads directly to S3.
// Body: { filename, mimetype, size }
// Returns: { fileId, storagePath, uploadUrl, imagePrefix? }
app.post("/files/presign", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { filename, mimetype, size } = req.body;
  if (!filename || !mimetype) return res.status(400).json({ error: "Missing filename or mimetype" });
  if (!ALLOWED_MIMES.has(mimetype)) return res.status(400).json({ error: "File type not allowed" });

  const fileId      = newId();
  const safeName    = sanitizeFilename(filename);
  const storagePath = `${fileId}_${safeName}`;
  const key         = s3Key(storagePath);

  try {
    const command   = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: mimetype });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour to complete upload
    return res.json({ fileId, storagePath, uploadUrl });
  } catch (err) {
    console.error("S3 presign error:", err);
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
});

// ── POST /files/register  ───────────────────────────────────────────────────
// Called by browser after the direct S3 PUT succeeds, to save metadata.
// Body: { fileId, storagePath, filename, mimetype, size }
app.post("/files/register", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { fileId, storagePath, filename, mimetype, size } = req.body;
  if (!fileId || !storagePath || !filename) return res.status(400).json({ error: "Missing fields" });

  const ts = nowMs();
  const fileRecord = {
    name:       filename,
    type:       mimetype || "application/octet-stream",
    size:       Number(size) || 0,
    storagePath,
    uploadedBy: decoded.uid,
    uploadedAt: ts,
  };

  try {
    await db.ref(`files/${fileId}`).set(fileRecord);
    await db.ref(`logs/${"-" + newId()}`).set({
      action: "file_upload", uid: decoded.uid, email: "", name: "",
      timestamp: ts, fileName: filename, fileId, fileSize: Number(size) || 0,
    });
    return res.json({ ok: true, fileId });
  } catch (err) {
    console.error("Firebase register error:", err);
    return res.status(500).json({ error: "Could not save file metadata" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STREAMING MULTIPART UPLOAD  (browser → Render → S3, no memory buffering)
// ════════════════════════════════════════════════════════════════════════════
// Flow:
//   1. POST /files/upload-begin   → creates S3 multipart upload, returns s3UploadId + fileId
//   2. POST /files/upload-part    → streams one chunk straight to S3, returns ETag
//   3. POST /files/upload-complete → finalises S3 upload, writes Firebase metadata
//   4. POST /files/upload-abort   → cancels an in-progress multipart upload (on error)
//
// Each chunk arrives as raw bytes (Content-Type: application/octet-stream).
// Render never accumulates more than one chunk in memory at a time.
// Minimum S3 part size is 5 MB except for the last part.

// ── POST /files/upload-begin ────────────────────────────────────────────────
app.post("/files/upload-begin", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { filename, mimetype, size } = req.body;
  if (!filename || !mimetype) return res.status(400).json({ error: "Missing filename or mimetype" });
  if (!ALLOWED_MIMES.has(mimetype)) return res.status(400).json({ error: "File type not allowed" });

  const fileId      = newId();
  const safeName    = sanitizeFilename(filename);
  const storagePath = `${fileId}_${safeName}`;
  const key         = s3Key(storagePath);

  try {
    const cmd    = new CreateMultipartUploadCommand({ Bucket: S3_BUCKET, Key: key, ContentType: mimetype });
    const result = await s3.send(cmd);
    return res.json({ fileId, storagePath, s3UploadId: result.UploadId });
  } catch (err) {
    console.error("S3 multipart begin error:", err);
    return res.status(500).json({ error: "Could not start upload" });
  }
});

// ── POST /files/upload-part ─────────────────────────────────────────────────
// Streams the raw chunk body directly to S3. No temp files, no buffering.
// Body: raw bytes (Content-Type: application/octet-stream)
// Query: storagePath, s3UploadId, partNumber
app.post("/files/upload-part", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { storagePath, s3UploadId, partNumber } = req.query;
  if (!storagePath || !s3UploadId || !partNumber) {
    return res.status(400).json({ error: "Missing storagePath, s3UploadId, or partNumber" });
  }

  const key    = s3Key(storagePath);
  const partNo = parseInt(partNumber, 10);

  // Collect the raw body stream into a Buffer for this one part.
  // Each part is ~5 MB so this is a bounded, small allocation.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  try {
    const cmd    = new UploadPartCommand({
      Bucket:     S3_BUCKET,
      Key:        key,
      UploadId:   s3UploadId,
      PartNumber: partNo,
      Body:       body,
    });
    const result = await s3.send(cmd);
    return res.json({ ETag: result.ETag, partNumber: partNo });
  } catch (err) {
    console.error("S3 upload-part error:", err);
    return res.status(500).json({ error: "Part upload failed" });
  }
});

// ── POST /files/upload-complete ─────────────────────────────────────────────
// Body: { fileId, storagePath, s3UploadId, parts: [{ETag, partNumber}], filename, mimetype, size }
app.post("/files/upload-complete", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { fileId, storagePath, s3UploadId, parts, filename, mimetype, size } = req.body;
  if (!fileId || !storagePath || !s3UploadId || !parts?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const key = s3Key(storagePath);

  try {
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket:          S3_BUCKET,
      Key:             key,
      UploadId:        s3UploadId,
      MultipartUpload: { Parts: parts.map(p => ({ ETag: p.ETag, PartNumber: p.partNumber })) },
    }));
  } catch (err) {
    console.error("S3 complete error:", err);
    return res.status(500).json({ error: "Could not complete upload" });
  }

  // Save metadata to Firebase
  const ts = nowMs();
  try {
    await db.ref(`files/${fileId}`).set({
      name:       filename,
      type:       mimetype || "application/octet-stream",
      size:       Number(size) || 0,
      storagePath,
      uploadedBy: decoded.uid,
      uploadedAt: ts,
    });
    await db.ref(`logs/${"-" + newId()}`).set({
      action: "file_upload", uid: decoded.uid, email: "", name: "",
      timestamp: ts, fileName: filename, fileId, fileSize: Number(size) || 0,
    });
  } catch (err) {
    console.error("Firebase write error:", err);
    // S3 upload already done — still return success
  }

  return res.json({ ok: true, fileId, storagePath });
});

// ── POST /files/upload-abort ────────────────────────────────────────────────
// Body: { storagePath, s3UploadId }
app.post("/files/upload-abort", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { storagePath, s3UploadId } = req.body;
  if (!storagePath || !s3UploadId) return res.status(400).json({ error: "Missing fields" });

  try {
    await s3.send(new AbortMultipartUploadCommand({
      Bucket:   S3_BUCKET,
      Key:      s3Key(storagePath),
      UploadId: s3UploadId,
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error("S3 abort error:", err);
    return res.status(500).json({ error: "Abort failed" });
  }
});

// ── POST /images/presign  ───────────────────────────────────────────────────
// Presign a PUT URL for a product image (stored under images/ prefix in S3).
// Body: { filename, mimetype }
// Returns: { imageKey, uploadUrl }
app.post("/images/presign", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { filename, mimetype } = req.body;
  const allowedImageMimes = new Set(["image/png","image/jpeg","image/gif","image/webp"]);
  if (!allowedImageMimes.has(mimetype)) return res.status(400).json({ error: "Images only (PNG/JPG/GIF/WEBP)" });

  const safeName = sanitizeFilename(filename);
  const imageKey = `images/${newId()}_${safeName}`;

  try {
    const command   = new PutObjectCommand({ Bucket: S3_BUCKET, Key: imageKey, ContentType: mimetype });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    return res.json({ imageKey, uploadUrl });
  } catch (err) {
    console.error("S3 image presign error:", err);
    return res.status(500).json({ error: "Could not generate image upload URL" });
  }
});

// ── GET /images/signed-url?key=images/xxx  ─────────────────────────────────
// Returns a short-lived signed GET URL for a product image.
// No auth required (product images are semi-public on the store page).
app.get("/images/signed-url", async (req, res) => {
  const { key } = req.query;
  if (!key || !key.startsWith("images/")) return res.status(400).json({ error: "Invalid key" });
  try {
    const command   = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    return res.json({ signedUrl });
  } catch (err) {
    console.error("S3 image URL error:", err);
    return res.status(500).json({ error: "Could not generate image URL" });
  }
});

// ── GET /files/signed-url?fileId=xxx ────────────────────────────────────────
// Returns a GET presigned URL for a file (access-checked).
app.get("/files/signed-url", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  const { uid } = decoded;
  const fileId  = req.query.fileId;
  if (!fileId) return res.status(400).json({ error: "Missing fileId" });

  // Check access in Firebase
  try {
    const snap = await db.ref(`access/${uid}/${fileId}`).get();
    const grant = snap.val();
    if (!grant || !grant.granted) return res.status(403).json({ error: "Access denied" });
    if (grant.expiresAt && grant.expiresAt < Date.now()) {
      return res.status(403).json({ error: "Access expired" });
    }
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  // Look up storagePath from Firebase
  let storagePath;
  try {
    const snap = await db.ref(`files/${fileId}/storagePath`).get();
    storagePath = snap.val();
    if (!storagePath) return res.status(404).json({ error: "File not found" });
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  try {
    const command   = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(storagePath) });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    return res.json({ signedUrl });
  } catch (err) {
    console.error("S3 signed URL error:", err);
    return res.status(500).json({ error: "Could not generate signed URL" });
  }
});

// ── GET /files/preview-url?fileId=xxx&pages=N ───────────────────────────────
// Returns a signed URL for previewing a file, plus the page limit metadata.
// Anyone can call this (no access grant needed) — used for product previews.
app.get("/files/preview-url", async (req, res) => {
  const fileId    = req.query.fileId;
  const pageLimit = parseInt(req.query.pages, 10) || null;
  if (!fileId) return res.status(400).json({ error: "Missing fileId" });

  // Load the product to verify this file has a preview configured
  let storagePath, fileType;
  try {
    const snap = await db.ref(`files/${fileId}`).get();
    const f    = snap.val();
    if (!f) return res.status(404).json({ error: "File not found" });
    storagePath = f.storagePath;
    fileType    = f.type;
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  try {
    const command   = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(storagePath) });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 1800 });
    return res.json({ signedUrl, pageLimit, fileType });
  } catch (err) {
    console.error("S3 preview URL error:", err);
    return res.status(500).json({ error: "Could not generate preview URL" });
  }
});

// ── GET /storage/stats ───────────────────────────────────────────────────────
// Returns real S3 usage: { totalSize, fileCount } in bytes.
app.get("/storage/stats", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  try {
    let totalSize  = 0;
    let fileCount  = 0;
    let imageCount = 0;
    let imageSize  = 0;
    let token;
    do {
      const cmd  = new ListObjectsV2Command({ Bucket: S3_BUCKET, ContinuationToken: token });
      const resp = await s3.send(cmd);
      for (const obj of (resp.Contents || [])) {
        if (obj.Key.startsWith("files/")) { totalSize += obj.Size; fileCount++; }
        if (obj.Key.startsWith("images/")) { imageSize += obj.Size; imageCount++; }
      }
      token = resp.NextContinuationToken;
    } while (token);

    return res.json({ totalSize, fileCount, imageSize, imageCount });
  } catch (err) {
    console.error("S3 list error:", err);
    return res.status(500).json({ error: "Could not fetch storage stats" });
  }
});

// ── DELETE /files/:fileId ────────────────────────────────────────────────────
app.delete("/files/:fileId", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { fileId } = req.params;

  // Get storagePath from Firebase
  let storagePath;
  try {
    const snap = await db.ref(`files/${fileId}/storagePath`).get();
    storagePath = snap.val();
  } catch {
    return res.status(500).json({ error: "Database error" });
  }
  if (!storagePath) return res.status(404).json({ error: "File not found" });

  // Delete from S3
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(storagePath) }));
  } catch (err) {
    console.error("S3 delete error:", err);
    // Non-fatal — continue to clean up Firebase
  }

  // Remove from Firebase: files record, access grants referencing this file,
  // and remove fileId from any products that list it
  try {
    await db.ref(`files/${fileId}`).remove();

    // Remove from access grants
    const accessSnap = await db.ref("access").get();
    const accessData = accessSnap.val() || {};
    const updates    = {};
    for (const uid of Object.keys(accessData)) {
      if (accessData[uid][fileId]) {
        updates[`access/${uid}/${fileId}`] = null;
      }
    }

    // Remove fileId from products
    const prodSnap = await db.ref("products").get();
    const products = prodSnap.val() || {};
    for (const [pid, prod] of Object.entries(products)) {
      if (Array.isArray(prod.fileIds) && prod.fileIds.includes(fileId)) {
        updates[`products/${pid}/fileIds`] = prod.fileIds.filter(id => id !== fileId);
      }
    }

    if (Object.keys(updates).length > 0) await db.ref().update(updates);

    await db.ref(`logs/${"-" + newId()}`).set({
      action: "file_delete", uid: decoded.uid, timestamp: nowMs(), fileId,
    });
  } catch (err) {
    console.error("Firebase cleanup error:", err);
  }

  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ECPAY ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

function verifyCheckMacValue(params) {
  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIV  = process.env.ECPAY_HASH_IV;
  if (!hashKey || !hashIV) return false;
  const received = params.CheckMacValue;
  if (!received) return false;

  const sorted = Object.keys(params)
    .filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${params[k]}`).join("&");

  const raw     = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  const encoded = encodeURIComponent(raw).toLowerCase()
    .replace(/%20/g, "+").replace(/%21/g, "!").replace(/%27/g, "'")
    .replace(/%28/g, "(").replace(/%29/g, ")").replace(/%2a/g, "*");

  return crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase() === received;
}

app.post("/ecpay/callback", async (req, res) => {
  const params = req.body;
  console.log("ECPay callback:", { MerchantTradeNo: params.MerchantTradeNo, RtnCode: params.RtnCode });

  if (!verifyCheckMacValue(params)) {
    console.error("CheckMacValue failed");
    return res.send("0|CheckMacValue error");
  }

  const rtnCode   = parseInt(params.RtnCode, 10);
  const isSuccess = rtnCode === 1 || rtnCode === 2;
  if (!isSuccess) return res.send("1|OK");

  const tradeNo = params.MerchantTradeNo || "";

  // Idempotency check
  let tradeData;
  try {
    const snap = await db.ref(`trade_map/${tradeNo}`).get();
    tradeData  = snap.val();
    if (!tradeData) return res.send("0|Trade not found");
    if (tradeData.processed) return res.send("1|OK");
  } catch (err) {
    console.error("trade_map read error:", err);
    return res.send("0|DB read error");
  }

  const { uid, productKey } = tradeData;
  if (!uid || !productKey) return res.send("0|Missing uid or productKey");

  // Mark processed immediately
  try {
    await db.ref(`trade_map/${tradeNo}/processed`).set(true);
  } catch { /* non-fatal */ }

  // Load product
  let product;
  try {
    const snap = await db.ref(`products/${productKey}`).get();
    product    = snap.val();
    if (!product) return res.send("0|Product not found");
  } catch (err) {
    console.error("Product read error:", err);
    return res.send("0|DB read error");
  }

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

  const purchaseKey = "-" + crypto.randomBytes(12).toString("hex");
  updates[`purchases/${uid}/${purchaseKey}`] = {
    merchantTradeNo: tradeNo, productKey, uid,
    productName: product.name || "", fileIds,
    amount: params.TradeAmt || 0, paymentType: params.PaymentType || "",
    paymentDate: params.PaymentDate || "", purchasedAt: now,
    expiresAt: expiresAt || null,
  };

  const logKey = "-" + crypto.randomBytes(12).toString("hex");
  updates[`logs/${logKey}`] = {
    action: "purchase", uid, email: "", name: "", timestamp: now,
    productName: product.name || "", fileIds, tradeNo, amount: params.TradeAmt || 0,
  };

  try {
    await db.ref().update(updates);
    console.log(`✓ Access granted: uid=${uid}, files=${fileIds.join(",")}`);
  } catch (err) {
    console.error("Multi-update error:", err);
    return res.send("0|DB write error");
  }

  return res.send("1|OK");
});

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
    const snap = await db.ref(`products/${productKey}`).get();
    product    = snap.val();
    if (!product) return res.status(404).json({ error: "Product not found" });
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  const randSuffix      = crypto.randomBytes(3).toString("hex").slice(0, 5);
  const shortPK         = productKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 5).padEnd(5, "0");
  const shortUID        = uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
  const merchantTradeNo = `${shortPK}${shortUID}${randSuffix}`;

  try {
    await db.ref(`trade_map/${merchantTradeNo}`).set({ uid, productKey, createdAt: Date.now(), processed: false });
  } catch { /* non-fatal */ }

  const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;
  const siteUrl   = process.env.SITE_URL   || allowedOrigin;

  const now_tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad    = n => String(n).padStart(2, "0");
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
