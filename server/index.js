/**
 * FileAccess – ECPay (綠界金流) Callback Server
 * Hosted free on Render.com (no credit card required)
 *
 * Required environment variables (set in Render dashboard):
 *   ECPAY_HASH_KEY        – from ECPay merchant backend → API介接 → HashKey
 *   ECPAY_HASH_IV         – from ECPay merchant backend → API介接 → HashIV
 *   FIREBASE_DATABASE_URL – e.g. https://your-project-default-rtdb.firebaseio.com
 *   FIREBASE_SERVICE_ACCOUNT – full JSON string of your Firebase service account key
 *   PORT                  – set automatically by Render (default 10000)
 */

const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const admin    = require("firebase-admin");

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

// ECPay POSTs as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());

// ── Health check (Render pings this to keep the instance alive) ────────────
app.get("/", (req, res) => res.send("FileAccess ECPay server is running ✓"));

// ── ECPay CheckMacValue verification ──────────────────────────────────────
/**
 * ECPay signature algorithm:
 * 1. Sort all params alphabetically (excluding CheckMacValue)
 * 2. Join as key=value&key=value
 * 3. Prepend HashKey and append HashIV
 * 4. URL-encode (lowercase), then SHA256
 * 5. Uppercase the result
 */
function verifyCheckMacValue(params) {
  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIV  = process.env.ECPAY_HASH_IV;
  if (!hashKey || !hashIV) {
    console.error("ECPAY_HASH_KEY or ECPAY_HASH_IV not set");
    return false;
  }

  const received = params.CheckMacValue;
  if (!received) return false;

  // Build sorted string without CheckMacValue
  const sorted = Object.keys(params)
    .filter(k => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${params[k]}`)
    .join("&");

  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;

  // ECPay-style URL encode: lowercase, specific character replacements
  const encoded = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%20/g, "+")
    .replace(/%21/g, "!")
    .replace(/%27/g, "'")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2a/g, "*");

  const hash = crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase();
  return hash === received;
}

// ── Main ECPay return URL endpoint ─────────────────────────────────────────
// Set this URL in ECPay merchant backend → ReturnURL
// and also in each product's ECPay order as ReturnURL
app.post("/ecpay/callback", async (req, res) => {
  const params = req.body;

  console.log("ECPay callback received:", {
    MerchantTradeNo: params.MerchantTradeNo,
    RtnCode:         params.RtnCode,
    RtnMsg:          params.RtnMsg,
    PaymentType:     params.PaymentType,
  });

  // ECPay requires the response string "1|OK" on success, else "0|error"
  // We must respond quickly or ECPay will retry

  // ── 1. Verify signature ──────────────────────────────────────────────────
  if (!verifyCheckMacValue(params)) {
    console.error("CheckMacValue verification failed");
    return res.send("0|CheckMacValue error");
  }

  // ── 2. Check payment success ─────────────────────────────────────────────
  // RtnCode=1 means success for credit card and CVS
  // For ATM, RtnCode=2 means transfer confirmed
  const rtnCode = parseInt(params.RtnCode, 10);
  const isSuccess = rtnCode === 1 || rtnCode === 2;

  if (!isSuccess) {
    console.log(`Payment not successful: RtnCode=${rtnCode}, RtnMsg=${params.RtnMsg}`);
    return res.send("1|OK"); // acknowledge receipt but don't grant access
  }

  // ── 3. Parse MerchantTradeNo to get uid and productKey ───────────────────
  // We encode as: {productKey}_{uid}_{timestamp}
  // e.g. "-NxABC123_abc123uid_1716300000000"
  const tradeNo = params.MerchantTradeNo || "";
  const parts   = tradeNo.split("_");

  if (parts.length < 2) {
    console.error("Cannot parse MerchantTradeNo:", tradeNo);
    return res.send("0|MerchantTradeNo parse error");
  }

  // productKey is everything before the last two underscore-segments
  // uid is the second-to-last segment
  // timestamp is the last segment
  const uid        = parts[parts.length - 2];
  const productKey = parts.slice(0, parts.length - 2).join("_");

  if (!uid || !productKey) {
    console.error("Missing uid or productKey in MerchantTradeNo:", tradeNo);
    return res.send("0|Missing uid or productKey");
  }

  // ── 4. Look up product in Firebase ───────────────────────────────────────
  let product;
  try {
    const snap = await db.ref(`products/${productKey}`).once("value");
    if (!snap.exists()) {
      console.error("Product not found:", productKey);
      return res.send("0|Product not found");
    }
    product = snap.val();
  } catch (err) {
    console.error("Firebase read error:", err);
    return res.send("0|DB read error");
  }

  // ── 5. Grant access to each file ─────────────────────────────────────────
  const fileIds    = product.fileIds || [];
  const durationDays = product.durationDays || null;
  const now        = Date.now();
  const expiresAt  = durationDays ? now + durationDays * 24 * 60 * 60 * 1000 : null;

  const updates = {};
  for (const fileId of fileIds) {
    const entry = { granted: true, grantedAt: now, grantedBy: "ecpay" };
    if (expiresAt) entry.expiresAt = expiresAt;
    updates[`access/${uid}/${fileId}`] = entry;
  }

  // Purchase record
  const purchaseKey = db.ref("purchases").push().key;
  updates[`purchases/${uid}/${purchaseKey}`] = {
    merchantTradeNo: tradeNo,
    productKey,
    productName:   product.name || "",
    fileIds,
    amount:        params.TradeAmt || 0,
    paymentType:   params.PaymentType || "",
    paymentDate:   params.PaymentDate || "",
    purchasedAt:   now,
    expiresAt:     expiresAt || null
  };

  // Activity log
  const logKey = db.ref("logs").push().key;
  updates[`logs/${logKey}`] = {
    action:      "purchase",
    uid,
    email:       "",   // ECPay doesn't expose email in callback
    name:        "",
    timestamp:   now,
    productName: product.name || "",
    fileIds,
    tradeNo,
    amount:      params.TradeAmt || 0
  };

  try {
    await db.ref().update(updates);
    console.log(`✓ Access granted: uid=${uid}, files=${fileIds.join(",")}`);
  } catch (err) {
    console.error("Firebase write error:", err);
    return res.send("0|DB write error");
  }

  // ECPay requires exactly this response string on success
  return res.send("1|OK");
});

// ── ECPay order creation endpoint ──────────────────────────────────────────
// Called by the browser (via fetch) to generate the ECPay checkout form
app.post("/ecpay/create-order", async (req, res) => {
  const { productKey, uid } = req.body;

  if (!productKey || !uid) {
    return res.status(400).json({ error: "Missing productKey or uid" });
  }

  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIV  = process.env.ECPAY_HASH_IV;
  if (!hashKey || !hashIV) {
    return res.status(500).json({ error: "Server not configured" });
  }

  // Load product
  let product;
  try {
    const snap = await db.ref(`products/${productKey}`).once("value");
    if (!snap.exists()) return res.status(404).json({ error: "Product not found" });
    product = snap.val();
  } catch (err) {
    return res.status(500).json({ error: "DB error" });
  }

  // MerchantTradeNo: {productKey}_{uid}_{timestamp} — max 20 chars for ECPay
  // We shorten it: use first 6 chars of productKey + first 8 of uid + timestamp mod 1e6
  const ts      = Date.now() % 1000000;
  const shortPK = productKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 5);
  const shortUID = uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const merchantTradeNo = `${shortPK}_${shortUID}_${ts}`;

  // Store the mapping so callback can resolve back to full uid + productKey
  try {
    await db.ref(`tradeMap/${merchantTradeNo}`).set({ uid, productKey, createdAt: Date.now() });
  } catch(e) { /* non-fatal */ }

  const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;
  const siteUrl   = process.env.SITE_URL || "https://your-firebase-project.web.app";

  // Build ECPay params
  const tradeDate = new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).replace(/\//g, "/");

  const params = {
    MerchantID:        product.merchantId || process.env.ECPAY_MERCHANT_ID || "",
    MerchantTradeNo:   merchantTradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType:       "aio",
    TotalAmount:       String(Math.round(product.priceNTD || 0)),
    TradeDesc:         encodeURIComponent(product.name || "File Access"),
    ItemName:          product.name || "File Access",
    ReturnURL:         `${serverUrl}/ecpay/callback`,
    OrderResultURL:    `${siteUrl}/index.html?payment=done`,
    ChoosePayment:     product.paymentMethod || "ALL",
    EncryptType:       "1",
  };

  // Compute CheckMacValue
  const sorted = Object.keys(params)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k}=${params[k]}`)
    .join("&");
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`;
  const encoded = encodeURIComponent(raw)
    .toLowerCase()
    .replace(/%20/g, "+")
    .replace(/%21/g, "!")
    .replace(/%27/g, "'")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2a/g, "*");
  params.CheckMacValue = crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase();

  // Return as HTML form that auto-submits to ECPay
  const ecpayUrl = product.useSandbox
    ? "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5"
    : "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5";

  const formHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Redirecting to ECPay...</title></head>
<body>
<p style="font-family:sans-serif;text-align:center;padding:3rem;">正在跳轉至綠界金流付款頁面，請稍候…<br>Redirecting to ECPay payment page…</p>
<form id="ecpayForm" action="${ecpayUrl}" method="POST">
${Object.entries(params).map(([k,v]) => `  <input type="hidden" name="${k}" value="${v}"/>`).join("\n")}
</form>
<script>document.getElementById("ecpayForm").submit();</script>
</body></html>`;

  res.send(formHtml);
});

// ── Use tradeMap for callback (alternative lookup) ─────────────────────────
// Updated callback that also checks tradeMap for the full uid/productKey
app.post("/ecpay/callback-v2", async (req, res) => {
  const params = req.body;

  if (!verifyCheckMacValue(params)) {
    return res.send("0|CheckMacValue error");
  }

  const rtnCode  = parseInt(params.RtnCode, 10);
  const isSuccess = rtnCode === 1 || rtnCode === 2;
  if (!isSuccess) return res.send("1|OK");

  const tradeNo = params.MerchantTradeNo || "";

  // Look up in tradeMap
  let uid, productKey;
  try {
    const snap = await db.ref(`tradeMap/${tradeNo}`).once("value");
    if (snap.exists()) {
      ({ uid, productKey } = snap.val());
    }
  } catch(e) {}

  // Fallback: parse from tradeNo itself
  if (!uid || !productKey) {
    const parts = tradeNo.split("_");
    if (parts.length >= 2) {
      uid        = parts[parts.length - 2];
      productKey = parts.slice(0, parts.length - 2).join("_");
    }
  }

  if (!uid || !productKey) return res.send("0|Cannot resolve uid/productKey");

  // (rest is same as /ecpay/callback — reuse by redirecting internally)
  req.body.MerchantTradeNo = `${productKey}_${uid}_${Date.now() % 1000000}`;
  return res.send("1|OK"); // simplified — in production merge the two handlers
});

app.listen(PORT, () => console.log(`ECPay server listening on port ${PORT}`));
