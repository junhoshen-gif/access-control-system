# FileAccess — Project Summary

## What it is
A paid digital file-delivery system ("FileAccess"). Admins upload files (e-books, PDFs, images); customers register, browse a store, pay via ECPay (Taiwanese payment gateway), and get access to purchased files. Some products also ship physically via convenience-store logistics (超商取貨).

## Stack
- **Frontend**: static HTML/CSS/vanilla JS, deployed to **Firebase Hosting** (`public/`)
- **Auth + DB**: **Firebase Authentication** (email/password) + **Realtime Database**
- **File storage**: **AWS S3** (presigned uploads/downloads, multipart upload for large files)
- **Backend server**: Node/Express app in `server/`, deployed to **Render.com** — handles everything that needs secrets: S3 signing, ECPay payment callbacks, ECPay logistics (超商取貨/物流), and acts as a proxy in front of the Firebase Realtime Database (`/db/*` routes) so business rules can be enforced server-side.
- **Firebase project**: `access-control-system-335f5`

Two other things exist but are **unused/legacy**: `functions/` (Firebase Cloud Functions) and `cloudflare-worker/` (an old Cloudflare R2-based version). Both are kept for reference only.

## Data model (Realtime Database)
`/users/{uid}`, `/admins/{uid}`, `/files/{fileId}`, `/access/{uid}/{fileId}`, `/products`, `/purchases/{uid}`, `/promotions`, `/logs`, `/logistics_orders`, `/settings`. Access rules in `database.rules.json` — only admins can write files/access/products; users can only read their own access grants; admin flag can't be self-assigned.

## Pages (`public/`)
- `index.html` — buyer page: "My Files" (owned files, search/filter, in-browser viewer), Store (buy access to products)
- `login.html` / `register.html` — auth
- `admin.html` — admin console with sections: Upload, Files, Access, Users, Pricing, Orders, Promotions, Logistics, Log, Terminal, Security, Console, Storage
- `viewer.html` — standalone file viewer (PDF/image rendering)
- `status.html` / `diag.html` — public system-health / debug pages
- `store-select-return.html` — return page for convenience-store pickup point selection

## Key backend routes (`server/index.js`, ~2000 lines)
- `/db/*` — proxy to Firebase RTDB (get/put/post/delete)
- `/files/*`, `/images/*` — S3 presign, register, multipart upload, signed download URLs, PDF preview
- `/ecpay/create-order`, `/ecpay/callback` — payment flow
- `/logistics/*` — 超商取貨 (CVS pickup) map, shipping labels, tracking, status callback
- `/promotions/*` — coupon/promo codes
- `/orders`, `/storage/stats`, `/logs/stream`

## Security / content protection
- `protect.js` on every page blocks right-click, dev tools shortcuts, Ctrl+S/U/P, text selection & copy inside the viewer, and stamps a per-user email watermark on viewed files (deterrent, not foolproof — the real protection is short-lived S3 signed URLs).
- Firebase RTDB rules + server-side checks gate all writes.
- `firebase.json` sets a strict CSP and other security headers on Hosting.

## Payment flow (end to end)
Admin creates a product in Pricing → user clicks "立即購買" → server creates ECPay order → user pays on ECPay's page → ECPay POSTs to `/ecpay/callback` → server verifies CheckMacValue, writes purchase + grants access in Firebase → user's file list updates.

## Known gaps / things worth double-checking
- **`SETUP_GUIDE.md` is out of date**: it describes Supabase Storage as the file store, but the actual server code uses AWS S3 (`S3_BUCKET`, `AWS_ACCESS_KEY_ID`, etc.). Worth deciding whether to update or remove the Supabase instructions.
- Render's free tier sleeps after 15 min idle (~30s cold start) — there's a `server-wake-banner.js` to warn users of this; `status.html` also monitors it.
- Logistics/超商取貨 (physical shipping) exists in code but isn't mentioned in `SETUP_GUIDE.md` at all — only in the docx guide.

## Existing docs in the folder
- `SETUP_GUIDE.md` — step-by-step setup (Firebase, Supabase*, Render, ECPay)
- `project_guide.docx` — file-by-file code walkthrough
- `ECPay整合指南.docx` — ECPay integration guide (Traditional Chinese)

---
*Please correct/add anything above — this was reconstructed from the current code and docs, not from you directly.*
