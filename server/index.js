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
// FILE ENDPOINTS  (S3)
// ════════════════════════════════════════════════════════════════════════════

// ── GET /files/signed-url?fileId=xxx ────────────────────────────────────────
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

  // Generate a pre-signed S3 URL (15 minutes)
  try {
    const command   = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key(storagePath) });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    return res.json({ signedUrl });
  } catch (err) {
    console.error("S3 signed URL error:", err);
    return res.status(500).json({ error: "Could not generate signed URL" });
  }
});

// ── POST /files/upload  (small files ≤ 100 MB, multipart) ───────────────────
app.post("/files/upload", upload.single("file"), async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file provided" });

  const ALLOWED_MIMES = [
    "application/pdf", "application/epub+zip",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "text/html", "text/plain", "text/markdown", "text/csv",
    "video/mp4", "video/webm", "audio/mpeg", "audio/wav",
    "model/stl", "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip", "application/x-rar-compressed",
  ];
  if (!ALLOWED_MIMES.includes(file.mimetype)) {
    return res.status(400).json({ error: "File type not allowed" });
  }

  const fileId      = newId();
  const safeName    = sanitizeFilename(file.originalname);
  const storagePath = `${fileId}_${safeName}`;

  // Upload to S3
  try {
    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         s3Key(storagePath),
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));
  } catch (err) {
    console.error("S3 upload error:", err);
    return res.status(500).json({ error: "Upload to S3 failed" });
  }

  const ts = nowMs();
  const fileRecord = {
    name:        file.originalname,
    type:        file.mimetype,
    size:        file.size,
    storagePath,
    uploadedBy:  decoded.uid,
    uploadedAt:  ts,
  };

  // Save metadata to Firebase
  try {
    await db.ref(`files/${fileId}`).set(fileRecord);
    await db.ref(`logs/${"-" + newId()}`).set({
      action: "file_upload", uid: decoded.uid, email: "", name: "",
      timestamp: ts, fileName: file.originalname, fileId, fileSize: file.size,
    });
  } catch (err) {
    console.error("Firebase write error:", err);
    // S3 upload succeeded — still return fileId so admin knows it landed
  }

  return res.json({ fileId, storagePath });
});

// ── POST /files/upload-chunk  (one chunk at a time, stored on Render's tmp) ──
app.post("/files/upload-chunk", chunkUpload.single("file"), async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { uploadId, chunkIndex, totalChunks } = req.body;
  if (!uploadId || chunkIndex === undefined || !totalChunks) {
    return res.status(400).json({ error: "Missing uploadId, chunkIndex, or totalChunks" });
  }
  if (!req.file) return res.status(400).json({ error: "No chunk data received" });

  return res.json({ ok: true, chunkIndex: parseInt(chunkIndex, 10) });
});

// ── POST /files/upload-merge  (assemble chunks → S3) ────────────────────────
app.post("/files/upload-merge", async (req, res) => {
  const decoded = await verifyToken(req, res);
  if (!decoded) return;
  if (!await isAdmin(decoded.uid)) return res.status(403).json({ error: "Admin only" });

  const { uploadId, filename, mimetype, totalChunks } = req.body;
  if (!uploadId || !filename || !mimetype || !totalChunks) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const n        = parseInt(totalChunks, 10);
  const chunkDir = path.join(os.tmpdir(), "fileaccess_chunks", uploadId);

  // Verify all chunks exist
  for (let i = 0; i < n; i++) {
    const p = path.join(chunkDir, `chunk_${String(i).padStart(6, "0")}`);
    if (!fs.existsSync(p)) return res.status(400).json({ error: `Missing chunk ${i}` });
  }

  const fileId      = newId();
  const safeName    = sanitizeFilename(filename);
  const storagePath = `${fileId}_${safeName}`;
  const key         = s3Key(storagePath);

  // Stream all chunks into a single Buffer then upload
  // (For very large files this could be replaced with S3 multipart upload)
  let totalSize = 0;
  const parts   = [];
  for (let i = 0; i < n; i++) {
    const buf = fs.readFileSync(path.join(chunkDir, `chunk_${String(i).padStart(6, "0")}`));
    totalSize += buf.length;
    parts.push(buf);
  }
  const combined = Buffer.concat(parts);

  // Clean up temp chunks
  fs.rmSync(chunkDir, { recursive: true, force: true });

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      S3_BUCKET,
      Key:         key,
      Body:        combined,
      ContentType: mimetype,
    }));
  } catch (err) {
    console.error("S3 merge upload error:", err);
    return res.status(500).json({ error: "S3 upload failed" });
  }

  const ts = nowMs();
  const fileRecord = {
    name:        filename,
    type:        mimetype,
    size:        totalSize,
    storagePath,
    uploadedBy:  decoded.uid,
    uploadedAt:  ts,
  };

  try {
    await db.ref(`files/${fileId}`).set(fileRecord);
    await db.ref(`logs/${"-" + newId()}`).set({
      action: "file_upload", uid: decoded.uid, email: "", name: "",
      timestamp: ts, fileName: filename, fileId, fileSize: totalSize,
    });
  } catch (err) {
    console.error("Firebase write error:", err);
  }

  return res.json({ fileId, storagePath });
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
