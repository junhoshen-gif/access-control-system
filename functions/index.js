/**
 * FileAccess – Stripe Webhook Cloud Function
 *
 * Listens for Stripe `checkout.session.completed` events.
 * When a user pays, automatically grants them access to the
 * file(s) defined in the matching product in Firebase.
 *
 * Environment variables (set via Firebase CLI):
 *   stripe.secret   – Stripe secret key  (sk_live_... or sk_test_...)
 *   stripe.webhook  – Stripe webhook signing secret (whsec_...)
 */

const functions  = require("firebase-functions");
const admin      = require("firebase-admin");
const Stripe     = require("stripe");

admin.initializeApp();
const db = admin.database();

// ── Helpers ────────────────────────────────────────────────────────────────

function getStripe() {
  const secret = functions.config().stripe?.secret;
  if (!secret) throw new Error("stripe.secret environment variable not set");
  return new Stripe(secret, { apiVersion: "2024-04-10" });
}

function getWebhookSecret() {
  const s = functions.config().stripe?.webhook;
  if (!s) throw new Error("stripe.webhook environment variable not set");
  return s;
}

// ── Main webhook handler ───────────────────────────────────────────────────

exports.stripeWebhook = functions
  .region("us-central1")
  .https.onRequest(async (req, res) => {

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    let event;
    try {
      const stripe        = getStripe();
      const webhookSecret = getWebhookSecret();

      // Verify the event came from Stripe (uses raw body)
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      functions.logger.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // We only care about successful checkouts
    if (event.type !== "checkout.session.completed") {
      return res.status(200).send("OK");
    }

    const session = event.data.object;

    // ── Extract uid from client_reference_id ──────────────────────────────
    // The Payment Link must include ?client_reference_id={uid}
    const uid = session.client_reference_id;
    if (!uid) {
      functions.logger.warn("checkout.session.completed missing client_reference_id", { sessionId: session.id });
      return res.status(200).send("OK – no uid");
    }

    // ── Find matching product in /products ────────────────────────────────
    // Match by Stripe Payment Link ID (session.payment_link) or
    // by the price/product ID inside line items.
    const paymentLinkId = session.payment_link;   // e.g. "plink_..."
    const stripeProductId = session.metadata?.stripe_product_id || null;

    let matchedProduct = null;
    let matchedProductKey = null;

    try {
      const productsSnap = await db.ref("products").once("value");
      if (productsSnap.exists()) {
        productsSnap.forEach((child) => {
          const p = child.val();
          // Match by Payment Link ID stored in the product record
          if (
            (paymentLinkId && p.paymentLinkId && p.paymentLinkId === paymentLinkId) ||
            (stripeProductId && p.stripeProductId && p.stripeProductId === stripeProductId)
          ) {
            matchedProduct    = p;
            matchedProductKey = child.key;
          }
        });
      }
    } catch (err) {
      functions.logger.error("Failed to read /products:", err);
      return res.status(500).send("DB read error");
    }

    if (!matchedProduct) {
      functions.logger.warn("No matching product found", { paymentLinkId, stripeProductId, sessionId: session.id });
      return res.status(200).send("OK – no matching product");
    }

    // ── Grant access to each file in the product ──────────────────────────
    const fileIds = matchedProduct.fileIds || [];    // array of fileId strings
    const durationDays = matchedProduct.durationDays || null;  // null = permanent

    const now       = Date.now();
    const expiresAt = durationDays ? now + durationDays * 24 * 60 * 60 * 1000 : null;

    const updates = {};
    for (const fileId of fileIds) {
      const accessEntry = { granted: true, grantedAt: now, grantedBy: "stripe" };
      if (expiresAt) accessEntry.expiresAt = expiresAt;
      updates[`access/${uid}/${fileId}`] = accessEntry;
    }

    // Write a purchase record for audit / admin view
    updates[`purchases/${uid}/${session.id}`] = {
      sessionId:       session.id,
      paymentLinkId:   paymentLinkId || null,
      productKey:      matchedProductKey,
      productName:     matchedProduct.name || "",
      fileIds,
      amount:          session.amount_total,
      currency:        session.currency,
      customerEmail:   session.customer_details?.email || "",
      purchasedAt:     now,
      expiresAt:       expiresAt || null
    };

    // Write activity log
    updates[`logs/${db.ref("logs").push().key}`] = {
      action:    "purchase",
      uid,
      email:     session.customer_details?.email || "",
      name:      session.customer_details?.name  || "",
      timestamp: now,
      productName: matchedProduct.name || "",
      fileIds,
      sessionId: session.id
    };

    try {
      await db.ref().update(updates);
      functions.logger.info("Access granted", { uid, fileIds, productKey: matchedProductKey });
    } catch (err) {
      functions.logger.error("Failed to write access grants:", err);
      return res.status(500).send("DB write error");
    }

    return res.status(200).json({ received: true, uid, fileIds });
  });
