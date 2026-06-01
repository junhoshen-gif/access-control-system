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
const { PDFDocument } = require("pdf-lib");
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

// Firebase projects are served from BOTH *.web.app AND *.firebaseapp.com.
// Allow both so the browser can reach /files/signed-url from either domain.
const allowedOrigins = process.env.SITE_URL
  ? [process.env.SITE_URL]
  : [
      "https://access-control-system-335f5.web.app",
      "https://access-control-system-335f5.firebaseapp.com",
    ];
const allowedOrigin = allowedOrigins[0]; // kept for reference in ecpay routes
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl) and listed origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  }
}));

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

// ── Startup env check ───────────────────────────────────────────────────────
const REQUIRED_ENV = [
  "ECPAY_HASH_KEY", "ECPAY_HASH_IV", "ECPAY_MERCHANT_ID",
  "ECPAY_LOGISTICS_HASH_KEY", "ECPAY_LOGISTICS_HASH_IV", "ECPAY_LOGISTICS_MERCHANT_ID",
  "FIREBASE_DATABASE_URL", "FIREBASE_SERVICE_ACCOUNT",
  "S3_BUCKET", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "SENDER_NAME", "SENDER_PHONE", "SENDER_ZIPCODE", "SENDER_ADDRESS",
  "SERVER_URL", "SITE_URL",
];
REQUIRED_ENV.forEach(k => {
  if (!process.env[k]) console.warn(`[ENV] ⚠️  Missing env var: ${k}`);
  else console.log(`[ENV] ✓ ${k} = ${k.includes("KEY") || k.includes("IV") || k.includes("ACCOUNT") ? "***" : process.env[k]}`);
});

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

// ── GET /files/preview-pdf?fileId=xxx&pages=N ───────────────────────────────
// Downloads the full PDF from S3, extracts the first N pages using pdf-lib,
// and streams the trimmed PDF back to the client.
// No auth required — same trust level as /files/preview-url.
// Only works for PDF files; returns 415 for other types.
app.get("/files/preview-pdf", async (req, res) => {
  const fileId    = req.query.fileId;
  const pageLimit = parseInt(req.query.pages, 10) || null;
  if (!fileId) return res.status(400).json({ error: "Missing fileId" });

  // Load file metadata
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

  if (fileType !== "application/pdf") {
    return res.status(415).json({ error: "preview-pdf only supports PDFs" });
  }

  // Fetch full PDF bytes from S3
  let pdfBytes;
  try {
    const cmd  = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(storagePath) });
    const resp = await s3.send(cmd);
    // Collect the S3 stream into a buffer
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    pdfBytes = Buffer.concat(chunks);
  } catch (err) {
    console.error("S3 preview-pdf fetch error:", err);
    return res.status(500).json({ error: "Could not fetch file from storage" });
  }

  // If no page limit, just proxy the original file
  if (!pageLimit) {
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", "inline");
    return res.send(pdfBytes);
  }

  // Extract first N pages with pdf-lib
  let trimmedBytes;
  try {
    const srcDoc  = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const outDoc  = await PDFDocument.create();
    const total   = srcDoc.getPageCount();
    const limit   = Math.min(pageLimit, total);
    const indices = Array.from({ length: limit }, (_, i) => i); // [0, 1, …, limit-1]
    const copied  = await outDoc.copyPages(srcDoc, indices);
    for (const page of copied) outDoc.addPage(page);
    trimmedBytes  = await outDoc.save();
  } catch (err) {
    console.error("pdf-lib page extraction error:", err);
    return res.status(500).json({ error: "Could not extract preview pages" });
  }

  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline");
  res.set("Content-Length", trimmedBytes.byteLength);
  return res.send(Buffer.from(trimmedBytes));
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

  // ── Physical product: record order (no auto logistics label creation) ───────
  if (product.hasPhysical && tradeData.deliveryInfo) {
    const deliveryInfo = tradeData.deliveryInfo;
    const orderKey = "-" + crypto.randomBytes(12).toString("hex");
    const orderData = {
      uid,
      purchaseKey,
      productKey,
      productName:    product.name || "",
      amount:         params.TradeAmt || 0,
      merchantTradeNo: tradeNo,
      deliveryType:   deliveryInfo.deliveryType || "",        // CVS carrier or TCAT or POST
      deliveryInfo,                                           // full delivery details
      receiverName:   tradeData.receiverName  || "",
      receiverPhone:  tradeData.receiverPhone || "",
      status:         "pending",
      logisticsLabelId: null,                                 // linked by admin later
      cvsPaymentNo:   null,                                   // set when admin creates label
      createdAt:      now,
      updatedAt:      now,
    };
    updates[`orders/${orderKey}`] = orderData;
    // Also store orderKey on the purchase for easy cross-reference
    updates[`purchases/${uid}/${purchaseKey}/orderKey`] = orderKey;
    console.log(`✓ Physical order recorded: orderKey=${orderKey} deliveryType=${deliveryInfo.deliveryType}`);
  }

  return res.send("1|OK");
});

// ── POST /logistics/status-callback ─────────────────────────────────────────
// Optional: ECPay calls this when the goods status changes (e.g. picked up).
// Updates Firebase with the latest status.
app.post("/logistics/status-callback", async (req, res) => {
  const { AllPayLogisticsID, GoodsStatus, RtnMsg, MerchantTradeNo } = req.body;
  if (!AllPayLogisticsID) return res.send("0|Missing AllPayLogisticsID");

  try {
    await db.ref(`logistics_orders/${AllPayLogisticsID}`).update({
      status:        GoodsStatus || RtnMsg || "updated",
      lastCheckedAt: Date.now(),
    });
    console.log(`✓ Logistics status update: ${AllPayLogisticsID} → ${GoodsStatus}`);
  } catch (err) {
    console.error("logistics/status-callback DB error:", err.message);
  }

  return res.send("1|OK");
});

app.post("/ecpay/create-order", async (req, res) => {
  // storeInfo: for CVS carriers (7-11, FamilyMart, OK, Hi-Life) — set after CVS map selection
  // deliveryInfo: full delivery object (includes deliveryType, plus store or home address info)
  const { productKey, idToken, storeInfo, deliveryInfo, receiverName, receiverPhone } = req.body;
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
    const tradeEntry = { uid, productKey, createdAt: Date.now(), processed: false };
    // Persist delivery selection so the payment callback can record the order
    if (product.hasPhysical) {
      if (deliveryInfo) {
        tradeEntry.deliveryInfo   = deliveryInfo;
        tradeEntry.receiverName   = receiverName  || deliveryInfo.receiverName  || "";
        tradeEntry.receiverPhone  = receiverPhone || deliveryInfo.receiverPhone || "";
      } else if (storeInfo) {
        // Legacy CVS-map flow fallback
        tradeEntry.storeInfo      = storeInfo;
        tradeEntry.deliveryInfo   = { deliveryType: storeInfo.LogisticsSubType || "UNIMART", ...storeInfo };
        tradeEntry.receiverName   = storeInfo.receiverName  || "";
        tradeEntry.receiverPhone  = storeInfo.receiverPhone || "";
      }
    }
    await db.ref(`trade_map/${merchantTradeNo}`).set(tradeEntry);
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

// ════════════════════════════════════════════════════════════════════════════
// ORDERS  (physical product orders — admin management)
// ════════════════════════════════════════════════════════════════════════════

// ── GET /orders  (admin only) ─────────────────────────────────────────────────
// Returns all physical orders, newest first.
app.get("/orders", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  try {
    const snap   = await db.ref("orders").get();
    const raw    = snap.val() || {};
    const orders = Object.entries(raw)
      .map(([key, o]) => ({ key, ...o }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json(orders);
  } catch (err) {
    console.error("/orders GET error:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// ── PATCH /orders/:orderKey  (admin only) ─────────────────────────────────────
// Update order status and/or link a logistics label.
// Body: { status?, logisticsLabelId?, cvsPaymentNo?, trackingNote? }
app.patch("/orders/:orderKey", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { orderKey } = req.params;
  const { status, logisticsLabelId, cvsPaymentNo, trackingNote } = req.body;

  const VALID_STATUSES = new Set(["pending", "processing", "shipped", "completed", "cancelled"]);
  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  const updates = { updatedAt: Date.now() };
  if (status)           updates.status           = status;
  if (logisticsLabelId !== undefined) updates.logisticsLabelId = logisticsLabelId;
  if (cvsPaymentNo !== undefined)     updates.cvsPaymentNo     = cvsPaymentNo;
  if (trackingNote !== undefined)     updates.trackingNote     = trackingNote;

  try {
    await db.ref(`orders/${orderKey}`).update(updates);
    console.log(`✓ Order updated: ${orderKey} status=${status || "(unchanged)"}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("/orders PATCH error:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ECPAY C2C LOGISTICS
// ════════════════════════════════════════════════════════════════════════════
//
// ECPay logistics uses MD5 (not SHA256 like the payment API).
// Sandbox base: https://logistics-stage.ecpay.com.tw
// Production:   https://logistics.ecpay.com.tw
//
// Required env vars (add to Render dashboard):
//   ECPAY_LOGISTICS_HASH_KEY    – from ECPay backend → 物流介接資料
//   ECPAY_LOGISTICS_HASH_IV     – same source
//   ECPAY_LOGISTICS_MERCHANT_ID – usually same as payment MerchantID
//   SENDER_NAME                 – your name / company (寄件人姓名)
//   SENDER_PHONE                – your phone (寄件人電話)
//   SENDER_ZIPCODE              – your postal code (寄件人郵遞區號)
//   SENDER_ADDRESS              – your full address (寄件人地址)

// ── Logistics rate limiter ───────────────────────────────────────────────────
const logisticsLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use("/logistics/", logisticsLimiter);

// ── MD5 CheckMacValue for logistics ─────────────────────────────────────────
// Per official ECPay logistics spec (https://developers.ecpay.com.tw/7424/):
// 1. Sort all params (except CheckMacValue) by key, case-insensitive A→Z
// 2. Join as key=value&key=value
// 3. Prepend HashKey=...& and append &HashIV=...
// 4. encodeURIComponent the ENTIRE string (= and & become %3d and %26)
// 5. Lowercase
// 6. Replace %20→+ %21→! %27→' %28→( %29→) %2a→*
// 7. MD5 → uppercase hex
function buildLogisticsCheckMacValue(params, hashKey, hashIV) {
  const sorted = Object.keys(params)
    .filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${params[k]}`).join("&");

  const raw     = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  const encoded = encodeURIComponent(raw).toLowerCase()
    .replace(/%20/g, "+").replace(/%21/g, "!").replace(/%27/g, "'")
    .replace(/%28/g, "(").replace(/%29/g, ")").replace(/%2a/g, "*");

  console.log("[CheckMac] raw:", raw);
  console.log("[CheckMac] encoded:", encoded);
  const mac = crypto.createHash("md5").update(encoded).digest("hex").toUpperCase();
  console.log("[CheckMac] MD5:", mac);
  return mac;
}

// ── POST to ECPay logistics API, returns parsed key=value response ───────────
// ECPay returns URL-encoded pairs: "RtnCode=1&RtnMsg=OK&AllPayLogisticsID=..."
async function callEcpayLogistics(path, params, useSandbox) {
  const https = require("https");
  const base  = useSandbox
    ? "https://logistics-stage.ecpay.com.tw"
    : "https://logistics.ecpay.com.tw";

  const hashKey = process.env.ECPAY_LOGISTICS_HASH_KEY || "";
  const hashIV  = process.env.ECPAY_LOGISTICS_HASH_IV  || "";
  params.CheckMacValue = buildLogisticsCheckMacValue(params, hashKey, hashIV);

  const body    = new URLSearchParams(params).toString();
  const url     = new URL(path, base);
  const options = {
    method:   "POST",
    hostname: url.hostname,
    path:     url.pathname,
    headers:  {
      "Content-Type":   "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      let data = "";
      resp.on("data", chunk => { data += chunk; });
      resp.on("end", () => {
        try {
          // ECPay sometimes returns a bare error string like "10500069|錯誤訊息"
          // instead of URL-encoded key=value pairs — detect and normalise it
          const decoded = data.includes("%") ? decodeURIComponent(data.replace(/\+/g, " ")) : data;
          if (/^\d{8}\|/.test(decoded.trim())) {
            // bare error code|message format
            const [rtnCode, ...msgParts] = decoded.trim().split("|");
            resolve({ RtnCode: rtnCode, RtnMsg: msgParts.join("|"), _raw: data });
            return;
          }
          const parsed = {};
          decoded.split("&").forEach(pair => {
            const [k, ...rest] = pair.split("=");
            if (k) parsed[k] = rest.join("=");
          });
          resolve(parsed);
        } catch {
          resolve({ _raw: data });
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── POST /logistics/cvs-map ──────────────────────────────────────────────────
// Step 1 of physical checkout: generates params for ECPay store-picker form.
// The browser auto-submits the form → user picks a store on ECPay's map →
// ECPay POSTs to /logistics/cvs-map-return (server) then redirects the browser
// to /store-select-return.html (ClientReplyURL).
//
// Body: { productKey, idToken, receiverName, receiverPhone }
app.post("/logistics/cvs-map", async (req, res) => {
  // ARCHIVED: logistics feature is disabled. Re-enable by setting LOGISTICS_ENABLED=true.
  if (process.env.LOGISTICS_ENABLED !== "true") {
    return res.status(503).json({ error: "Logistics feature is currently unavailable." });
  }

  const decoded = await verifyToken(req, res);
  if (!decoded) return;

  // logisticsSubType can be passed directly (user selected a specific carrier)
  // falling back to the first product logisticsSubTypes entry
  const { productKey, receiverName, receiverPhone, logisticsSubType: reqSubType } = req.body;
  if (!productKey)      return res.status(400).json({ error: "Missing productKey" });
  if (!receiverName)    return res.status(400).json({ error: "Missing receiverName" });
  if (!receiverPhone)   return res.status(400).json({ error: "Missing receiverPhone" });

  // Confirm the product is physical
  let product;
  try {
    const snap = await db.ref(`products/${productKey}`).get();
    product    = snap.val();
    if (!product)          return res.status(404).json({ error: "Product not found" });
    if (!product.hasPhysical) return res.status(400).json({ error: "Product is not physical" });
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  // Generate a trade number for this store-selection session (same format as payments)
  const randSuffix      = crypto.randomBytes(3).toString("hex").slice(0, 5);
  const shortPK         = productKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 5).padEnd(5, "0");
  const shortUID        = decoded.uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
  const merchantTradeNo = `${shortPK}${shortUID}${randSuffix}`;

  // Save to trade_map so /cvs-map-return and later /ecpay/create-order can find it
  try {
    await db.ref(`trade_map/${merchantTradeNo}`).set({
      uid:              decoded.uid,
      productKey,
      receiverName,
      receiverPhone,
      selectedSubType:  logisticsSubType,   // user's carrier choice
      createdAt:        Date.now(),
      processed:        false,
      storeSelected:    false,
    });
  } catch (err) {
    console.error("trade_map write error:", err);
    return res.status(500).json({ error: "Database error" });
  }

  const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;
  const siteUrl   = process.env.SITE_URL   || allowedOrigin;

  // ECPay CVSMap only supports one LogisticsSubType per redirect
  // Use caller's choice if provided, else fall back to first in product config
  const subTypes         = product.logisticsSubTypes || ["UNIMART"];
  const logisticsSubType = reqSubType || subTypes[0];
  const useSandbox       = product.logisticsSandbox !== false; // default sandbox for safety
  const base             = useSandbox
    ? "https://logistics-stage.ecpay.com.tw"
    : "https://logistics.ecpay.com.tw";

  const hashKey = process.env.ECPAY_LOGISTICS_HASH_KEY || "";
  const hashIV  = process.env.ECPAY_LOGISTICS_HASH_IV  || "";

  const mapParams = {
    MerchantID:       process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID || "",
    MerchantTradeNo:  merchantTradeNo,
    LogisticsType:    "CVS",
    LogisticsSubType: logisticsSubType,
    IsCollection:     "N",
    ServerReplyURL:   `${serverUrl}/logistics/cvs-map-return`,
    ClientReplyURL:   `${siteUrl}/store-select-return.html`,
    ExtraData:        merchantTradeNo,
  };
  mapParams.CheckMacValue = buildLogisticsCheckMacValue(mapParams, hashKey, hashIV);

  return res.json({ ecpayUrl: `${base}/Express/map`, params: mapParams, merchantTradeNo });
});

// ── POST /logistics/cvs-map-return ──────────────────────────────────────────
// ECPay's map page JS forcibly replaces its form action with ServerReplyURL,
// so the BROWSER itself always POSTs here (not just ECPay's server).
//
// We handle three cases:
//   A. Browser POST (Accept: text/html)  → save store info, redirect to store-select-return.html
//   B. ECPay server POST (no Accept)     → save store info, reply "1|OK"
//   C. GET (fallback)                    → same as A
//
// Detection: browser requests always include Accept: text/html.
// ECPay server-to-server callbacks do not send Accept headers.
async function handleCvsMapReturn(req, res) {
  const p = Object.keys(req.query).length > 0 ? req.query : req.body;
  const {
    MerchantTradeNo, CVSStoreID, CVSStoreName,
    CVSAddress, CVSOutSide, LogisticsSubType,
    ExtraData,
  } = p;

  const tradeNo    = MerchantTradeNo || ExtraData || "";
  const acceptHdr  = req.headers["accept"] || "";
  // A browser always sends Accept containing text/html.
  // ECPay's server callback sends no Accept header (or application/x-www-form-urlencoded).
  const isBrowser  = req.method === "GET" || acceptHdr.includes("text/html");
  const siteUrl    = process.env.SITE_URL || "";

  console.log(`cvs-map-return: method=${req.method} isBrowser=${isBrowser} tradeNo=${tradeNo} storeId=${CVSStoreID}`);

  if (!tradeNo || !CVSStoreID) {
    console.error("cvs-map-return: missing tradeNo or CVSStoreID", p);
    if (isBrowser) return res.redirect(`${siteUrl}/index.html?error=store_missing`);
    return res.send("0|Missing params");
  }

  // Save store info to Firebase
  try {
    // Read the selectedSubType saved by /logistics/cvs-map to preserve carrier choice
    let savedSubType = LogisticsSubType || "";
    try {
      const stSnap = await db.ref(`trade_map/${tradeNo}/selectedSubType`).get();
      if (stSnap.val()) savedSubType = stSnap.val();
    } catch { /* keep fallback */ }

    await db.ref(`trade_map/${tradeNo}`).update({
      storeSelected: true,
      storeInfo: {
        CVSStoreID,
        CVSStoreName:     CVSStoreName  || "",
        CVSAddress:       CVSAddress    || "",
        CVSOutSide:       CVSOutSide    || "0",
        LogisticsSubType: savedSubType,
      },
    });
    console.log(`✓ Store selected: tradeNo=${tradeNo} storeId=${CVSStoreID} (${CVSStoreName})`);
  } catch (err) {
    console.error("cvs-map-return DB write error:", err);
    if (isBrowser) return res.redirect(`${siteUrl}/index.html?error=db_error`);
    return res.send("0|DB error");
  }

  if (isBrowser) {
    // Redirect the browser to store-select-return.html with store params in query string.
    // store-select-return.html saves them to sessionStorage then forwards to
    // index.html?action=checkout&tradeNo=xxx to trigger payment.
    const qs = new URLSearchParams({
      MerchantTradeNo:  tradeNo,
      CVSStoreID,
      CVSStoreName:     CVSStoreName     || "",
      CVSAddress:       CVSAddress       || "",
      CVSOutSide:       CVSOutSide       || "0",
      LogisticsSubType: LogisticsSubType || "",
      ExtraData:        tradeNo,
    }).toString();
    return res.redirect(`${siteUrl}/store-select-return.html?${qs}`);
  }

  // Pure server-to-server callback — ECPay requires exactly this response
  return res.send("1|OK");
}

app.post("/logistics/cvs-map-return", handleCvsMapReturn);
app.get("/logistics/cvs-map-return",  handleCvsMapReturn);

// ── GET /logistics/trade-info?tradeNo=xxx ────────────────────────────────────
// Called by index.html after returning from the CVS map.
// Returns { productKey, storeInfo } for the given tradeNo, verifying the
// requesting user is the owner of that trade session.
app.get("/logistics/trade-info", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;

  const { tradeNo } = req.query;
  if (!tradeNo) return res.status(400).json({ error: "Missing tradeNo" });

  let tradeData;
  try {
    const snap = await db.ref(`trade_map/${tradeNo}`).get();
    tradeData  = snap.val();
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  if (!tradeData)                         return res.status(404).json({ error: "Trade session not found. Please start over." });
  if (tradeData.uid !== decoded.uid)      return res.status(403).json({ error: "Unauthorized" });
  if (!tradeData.storeSelected)          return res.status(400).json({ error: "Store not yet selected. Please try again." });
  if (!tradeData.storeInfo?.CVSStoreID)  return res.status(400).json({ error: "Store info missing. Please start over." });

  return res.json({
    productKey: tradeData.productKey,
    storeInfo:  {
      ...tradeData.storeInfo,
      receiverName:  tradeData.receiverName  || "",
      receiverPhone: tradeData.receiverPhone || "",
    },
  });
});

// ── GET /logistics/orders  (admin only) ──────────────────────────────────────
// Returns all logistics orders, newest first.
app.get("/logistics/orders", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  try {
    const snap   = await db.ref("logistics_orders").get();
    const raw    = snap.val() || {};
    const orders = Object.values(raw).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json(orders);
  } catch (err) {
    console.error("logistics/orders error:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// ── POST /logistics/print-label  (admin only) ────────────────────────────────
// Builds and returns the ECPay PrintTradeDocument URL so admin can open it.
// Body: { allPayLogisticsID, useSandbox? }
app.post("/logistics/print-label", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { allPayLogisticsID, useSandbox } = req.body;
  if (!allPayLogisticsID) return res.status(400).json({ error: "Missing allPayLogisticsID" });

  const base = (useSandbox !== false)
    ? "https://logistics-stage.ecpay.com.tw"
    : "https://logistics.ecpay.com.tw";

  const hashKey = process.env.ECPAY_LOGISTICS_HASH_KEY || "";
  const hashIV  = process.env.ECPAY_LOGISTICS_HASH_IV  || "";

  const params = {
    MerchantID:        process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID || "",
    AllPayLogisticsID: allPayLogisticsID,
  };
  params.CheckMacValue = buildLogisticsCheckMacValue(params, hashKey, hashIV);

  // PrintTradeDocument is a GET redirect to a PDF — build the URL with params
  const printUrl = `${base}/Express/PrintTradeDocument?${new URLSearchParams(params).toString()}`;
  return res.json({ printUrl });
});

// ── POST /logistics/create-label  (admin only) ───────────────────────────────
// Manually creates an ECPay logistics label. Admin fills in all details.
// Body: {
//   logisticsType: "CVS" | "HOME",
//   logisticsSubType: "UNIMART"|"FAMI"|"OKMART"|"HILIFE"|"TCAT"|"POST",
//   receiverName, receiverPhone, receiverAddress, receiverZipCode?,
//   cvsStoreId?,      // for CVS only
//   goodsName, goodsAmount,
//   isCollection: "N"|"Y",
//   useSandbox?: boolean,
//   orderKey?: string  // link to an existing order
// }
app.post("/logistics/create-label", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const {
    logisticsType = "CVS",
    logisticsSubType,
    receiverName,
    receiverPhone,
    receiverAddress,
    receiverZipCode,
    cvsStoreId,
    goodsName,
    goodsAmount,
    isCollection = "N",
    useSandbox = true,
    orderKey,
  } = req.body;

  if (!logisticsSubType) return res.status(400).json({ error: "Missing logisticsSubType" });
  if (!receiverName)     return res.status(400).json({ error: "Missing receiverName" });
  if (!receiverPhone)    return res.status(400).json({ error: "Missing receiverPhone" });
  if (!goodsName)        return res.status(400).json({ error: "Missing goodsName" });
  if (!goodsAmount)      return res.status(400).json({ error: "Missing goodsAmount" });

  // Build a unique MerchantTradeNo for this label
  const randSuffix      = crypto.randomBytes(4).toString("hex");
  const merchantTradeNo = `LBL${randSuffix}`;

  const nowMs      = Date.now();
  const nowTw      = new Date(nowMs + 8 * 60 * 60 * 1000);
  const pad        = n => String(n).padStart(2, "0");
  const tradeDate  = `${nowTw.getUTCFullYear()}/${pad(nowTw.getUTCMonth()+1)}/${pad(nowTw.getUTCDate())} ${pad(nowTw.getUTCHours())}:${pad(nowTw.getUTCMinutes())}:${pad(nowTw.getUTCSeconds())}`;

  // Validate + normalise receiver name
  let rName = (receiverName || "").trim();
  const isChinese = /[一-鿿]/.test(rName);
  if (isChinese) {
    rName = rName.replace(/[^一-鿿]/g, "").slice(0, 5);
    if (rName.length < 2) rName = "買家";
  } else {
    rName = rName.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
    if (rName.length < 4) rName = "Buyer";
  }

  const isCVS = logisticsType === "CVS";
  const paramsRaw = {
    MerchantID:        process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID || "",
    MerchantTradeNo:   merchantTradeNo,
    MerchantTradeDate: tradeDate,
    LogisticsType:     logisticsType,
    LogisticsSubType:  logisticsSubType,
    GoodsAmount:       String(Math.round(Number(goodsAmount) || 0)),
    IsCollection:      isCollection || "N",
    GoodsName:         (goodsName || "商品").replace(/[^a-zA-Z0-9一-鿿\s]/g, "").slice(0, 50) || "商品",
    SenderName:        process.env.SENDER_NAME    || "",
    SenderPhone:       process.env.SENDER_PHONE   || "",
    SenderZipCode:     process.env.SENDER_ZIPCODE || "",
    SenderAddress:     process.env.SENDER_ADDRESS || "",
    ReceiverName:      rName,
    ReceiverCellPhone: (receiverPhone || "").replace(/\D/g, "").slice(0, 20),
    ReceiverAddress:   receiverAddress || "",
    ...(isCVS && cvsStoreId ? { ReceiverStoreID: cvsStoreId } : {}),
    ...(receiverZipCode     ? { ReceiverZipCode: receiverZipCode } : {}),
    ServerReplyURL:    `${process.env.SERVER_URL || ""}/logistics/status-callback`,
    ClientReplyURL:    `${process.env.SITE_URL   || ""}/index.html`,
  };
  const params = Object.fromEntries(Object.entries(paramsRaw).filter(([, v]) => v !== ""));

  let result;
  try {
    result = await callEcpayLogistics("/Express/Create", params, useSandbox);
  } catch (err) {
    console.error("/logistics/create-label error:", err.message);
    return res.status(502).json({ error: "ECPay API error", detail: err.message });
  }

  const allPayLogisticsID = result.AllPayLogisticsID || "";
  const cvsPaymentNo      = result.CVSPaymentNo || result.CVSValidationNo || "";
  const rtnCode           = result.RtnCode;
  const rtnMsg            = result.RtnMsg || "";

  console.log("ECPay logistics /Express/Create result:", JSON.stringify(result));

  if (rtnCode !== "1") {
    const detail = result._raw || JSON.stringify(result);
    return res.status(422).json({
      error: rtnCode ? `ECPay error ${rtnCode}: ${rtnMsg}` : "ECPay returned unexpected response",
      rtnCode: rtnCode || null,
      rtnMsg,
      raw: detail,
    });
  }

  // Save label record in Firebase
  const labelKey = allPayLogisticsID || ("-lbl-" + crypto.randomBytes(8).toString("hex"));
  const labelData = {
    allPayLogisticsID,
    cvsPaymentNo,
    merchantTradeNo,
    logisticsType,
    logisticsSubType,
    receiverName:    rName,
    receiverPhone:   (receiverPhone || "").replace(/\D/g, "").slice(0, 20),
    receiverAddress: receiverAddress || "",
    cvsStoreId:      cvsStoreId || "",
    goodsName:       paramsRaw.GoodsName,
    goodsAmount:     paramsRaw.GoodsAmount,
    status:          "created",
    useSandbox,
    orderKey:        orderKey || null,
    createdBy:       decoded.uid,
    createdAt:       nowMs,
  };

  const labelUpdates = {};
  labelUpdates[`logistics_labels/${labelKey}`] = labelData;

  // If linked to an order, update the order with label info
  if (orderKey) {
    labelUpdates[`orders/${orderKey}/logisticsLabelId`] = labelKey;
    labelUpdates[`orders/${orderKey}/cvsPaymentNo`]     = cvsPaymentNo || null;
    labelUpdates[`orders/${orderKey}/status`]           = "shipped";
    labelUpdates[`orders/${orderKey}/updatedAt`]        = nowMs;
  }

  try {
    await db.ref().update(labelUpdates);
    console.log(`✓ Label created: ${labelKey} CVSPaymentNo=${cvsPaymentNo}`);
  } catch (err) {
    console.error("Label DB write error:", err.message);
  }

  return res.json({
    ok: true,
    labelKey,
    allPayLogisticsID,
    cvsPaymentNo,
    result,
  });
});

// ── GET /logistics/labels  (admin only) ──────────────────────────────────────
app.get("/logistics/labels", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  try {
    const snap   = await db.ref("logistics_labels").get();
    const raw    = snap.val() || {};
    const labels = Object.entries(raw)
      .map(([key, l]) => ({ key, ...l }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json(labels);
  } catch (err) {
    console.error("/logistics/labels GET error:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// ── GET /logistics/track/:logisticsId  (admin only) ──────────────────────────
// Queries ECPay for current status and updates Firebase.
app.get("/logistics/track/:logisticsId", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { logisticsId } = req.params;

  // Read sandbox flag from the stored order
  let useSandbox = true;
  try {
    const snap = await db.ref(`logistics_orders/${logisticsId}/useSandbox`).get();
    if (snap.val() === false) useSandbox = false;
  } catch { /* default to sandbox */ }

  const params = {
    MerchantID:        process.env.ECPAY_LOGISTICS_MERCHANT_ID || process.env.ECPAY_MERCHANT_ID || "",
    AllPayLogisticsID: logisticsId,
    TimeStamp:         String(Math.floor(Date.now() / 1000)),
  };

  let result;
  try {
    result = await callEcpayLogistics("/Helper/QueryLogisticsTradeInfo/V2", params, useSandbox);
  } catch (err) {
    console.error("logistics/track error:", err);
    return res.status(502).json({ error: "ECPay API error", detail: err.message });
  }

  const status = result.GoodsStatus || result.RtnMsg || "unknown";

  // Update status in Firebase (try both old logistics_orders and new logistics_labels)
  try {
    const updateData = { status, lastCheckedAt: Date.now() };
    await db.ref(`logistics_labels/${logisticsId}`).update(updateData);
    // Also update legacy logistics_orders if it exists there
    const oldSnap = await db.ref(`logistics_orders/${logisticsId}`).get();
    if (oldSnap.val()) await db.ref(`logistics_orders/${logisticsId}`).update(updateData);
  } catch { /* non-fatal */ }

  return res.json({ logisticsId, status, raw: result });
});
