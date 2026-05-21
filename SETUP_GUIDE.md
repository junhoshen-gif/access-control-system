# FileAccess – Setup Guide

A complete file access control system using Firebase (Auth + Hosting + Realtime Database) and Supabase Storage for files (free, no credit card required).

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│                      Firebase                          │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │ Auth          │  │  Realtime   │  │   Hosting    │  │
│  │ (Email/Google)│  │  Database   │  │  (Web App)   │  │
│  └──────────────┘  └─────────────┘  └──────────────┘  │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌─────────────────────┐
              │   Supabase Storage  │
              │  (Free, no card)    │
              │  1GB free tier      │
              └─────────────────────┘
```

**Database structure:**
```
/users/{uid}           → user profile (name, email, createdAt)
/admins/{uid}          → true if user is admin
/files/{fileId}        → file metadata (name, type, url, uploadedAt)
/access/{uid}/{fileId} → { granted, grantedAt, expiresAt? }
```

---

## Step 1 — Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com) → **Add project**
2. Name it (e.g. `file-access-system`) and follow the prompts
3. In the left sidebar, open **Project Settings** → **General**
4. Scroll to **Your apps** → click the **</>** (web) icon → register the app
5. Copy the `firebaseConfig` object shown — you'll need it in Step 4

### Enable Authentication
1. Sidebar → **Authentication** → **Get started**
2. **Sign-in method** tab → enable:
   - **Email/Password** — enable it
   - **Google** — enable, add a support email

### Enable Realtime Database
1. Sidebar → **Realtime Database** → **Create database**
2. Choose a location close to your users
3. Start in **locked mode** (we deploy our own rules via CLI)

### Enable Hosting
1. Sidebar → **Hosting** → **Get started** → follow the steps
2. Note your project ID

---

## Step 2 — Set Up Supabase Storage (free, no credit card)

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign up with GitHub or email
2. Click **New project** → fill in a name and a database password → click **Create new project**
3. Wait ~1 minute for the project to provision
4. In the left sidebar → **Storage** → **New bucket**
   - Name: `fileaccess`
   - Toggle **Public bucket** to ON (so files can be viewed by users)
   - Click **Save**
5. Go to **Project Settings** (gear icon) → **API**
   - Copy the **Project URL** (e.g. `https://abcxyz.supabase.co`)
   - Copy the **anon / public** key

### Set Storage CORS policy
1. In Supabase sidebar → **Storage** → **Policies** tab
2. For the `fileaccess` bucket, click **New policy** → **For full customization**
3. Add a policy to allow INSERT for authenticated role:
   - Policy name: `Allow admin uploads`
   - Allowed operation: `INSERT`
   - Target roles: leave blank (applies to all including anon key)
   - USING expression: `true`
4. Click **Review** → **Save policy**

> **Tip:** If you want to keep it simple, you can also set the bucket to allow all operations via the "Give users access to a folder" template.

---

## Step 3 — Configure the App

Open `public/js/config.js` and fill in your values:

```js
export const firebaseConfig = {
  apiKey:            "AIza...",
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123:web:abc"
};

export const supabaseConfig = {
  supabaseUrl: "https://YOUR_PROJECT_ID.supabase.co",  // from Supabase → Settings → API
  supabaseKey: "YOUR_ANON_PUBLIC_KEY",                 // the "anon / public" key
  bucketName:  "fileaccess"                            // the bucket name you created
};
```

---

## Step 4 — Add Authorized Domains to Firebase Auth

1. Firebase Console → **Authentication** → **Settings** → **Authorized domains**
2. Your Firebase Hosting domain (`your-project.web.app`) is usually already listed
3. If you use a custom domain, add it here too

---

## Step 5 — Install Firebase CLI & Deploy

```bash
# Install Firebase CLI (requires Node.js)
npm install -g firebase-tools

# Log in
firebase login

# In the project folder
cd "access control system"

# Initialize (select Hosting + Database; use 'public' as your hosting folder)
firebase init

# Deploy
firebase deploy
```

Your app will be live at `https://your-project.web.app`

---

## Step 6 — Set the First Admin

Admins are stored in the Firebase Realtime Database at `/admins/{uid}`. You must manually set the first admin.

1. **Find your UID:**
   - Register/log in on your deployed app
   - Firebase Console → **Authentication** → **Users** tab
   - Copy the UID of the account you want to make admin

2. **Set the admin flag:**
   - Firebase Console → **Realtime Database**
   - Click the **+** next to the root node
   - Key: `admins`, then add a child: Key = `{your-uid}`, Value = `true`

3. Refresh the app — the **Admin Console** link will appear in the nav bar.

---

---

## Step 7 — Set Up ECPay 綠界金流 (Self-Service Payment)

This lets users pay directly and get instant access without an admin online. Uses Render.com (free hosting, no credit card).

### 7-A: Get your ECPay API credentials

1. Log in to [ECPay merchant backend](https://vendor.ecpay.com.tw)
2. Go to **系統開發管理 → API 介接資料**
3. Copy your **HashKey** and **HashIV**
4. Copy your **廠商代號 (Merchant ID)**

For testing, use these sandbox credentials:
- Merchant ID: `2000132`
- HashKey: `5294y06JbISpM5x9`
- HashIV: `v77hoKGq4kWxNNIS`

---

### 7-B: Create a Firebase Service Account (for the server)

The Render server needs to write to Firebase on ECPay's behalf.

1. Firebase Console → **Project Settings** → **Service accounts** tab
2. Click **Generate new private key** → confirm → download the JSON file
3. Open the downloaded JSON file and copy the **entire contents**

---

### 7-C: Deploy the payment server to Render.com (free)

1. Go to [render.com](https://render.com) and sign up with GitHub (free)

2. **Push the `server/` folder to a GitHub repo** (create a new repo, push your project)

3. On Render: **New → Web Service** → connect your GitHub repo
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `node index.js`
   - Instance Type: **Free**

4. Under **Environment Variables**, add these (click "Add Environment Variable" for each):

   | Key | Value |
   |-----|-------|
   | `ECPAY_HASH_KEY` | (from Step 7-A) |
   | `ECPAY_HASH_IV` | (from Step 7-A) |
   | `ECPAY_MERCHANT_ID` | (from Step 7-A) |
   | `FIREBASE_DATABASE_URL` | `https://YOUR-PROJECT-default-rtdb.firebaseio.com` |
   | `FIREBASE_SERVICE_ACCOUNT` | Paste the entire JSON from Step 7-B as one line |
   | `SERVER_URL` | `https://YOUR-RENDER-APP.onrender.com` (fill after deploy) |
   | `SITE_URL` | `https://YOUR-PROJECT.web.app` |

5. Click **Deploy** — Render will build and start the server. Copy the URL it gives you (e.g. `https://fileaccess-ecpay.onrender.com`)

6. **Update `SERVER_URL`** in Render environment variables to that URL, then redeploy

---

### 7-D: Update the frontend with your server URL

Open `public/index.html` and find this line near the top of the `<script>`:

```js
const ECPAY_SERVER_URL = "https://YOUR-RENDER-APP.onrender.com";
```

Replace `YOUR-RENDER-APP` with your actual Render app name, then run `firebase deploy`.

---

### 7-E: Configure ECPay ReturnURL

ECPay needs to know where to send the payment confirmation. In your ECPay merchant backend:

1. **系統開發管理 → 廠商資料管理** (or when creating orders via the server it's set automatically)
2. The server sets `ReturnURL` to `https://YOUR-RENDER-APP.onrender.com/ecpay/callback` automatically — no manual config needed.

---

### 7-F: Create products in Admin Console

1. Log in as admin → click **Pricing** in the sidebar
2. Fill in:
   - 商品名稱 (Product Name)
   - 價格 in NTD (must be integer, e.g. `299`)
   - Select which files this purchase unlocks
   - Choose payment method (credit card / ATM / both)
   - Enter your ECPay Merchant ID
   - Check "使用測試環境" while testing, uncheck for production
3. Click **儲存商品**

Users will now see a **"購買存取權"** section on their file page with a "立即購買" button.

---

### 7-G: Test the payment flow

Using ECPay sandbox:
- Card number: `4311952222222222`, expiry: any future date, CVV: `222`
- After payment, ECPay POSTs to your Render server → Firebase is updated → user gets access

---

## File Structure

```
access control system/
├── firebase.json              # Firebase Hosting + Database config
├── .firebaserc                # Firebase project alias
├── database.rules.json        # Realtime Database security rules
├── SETUP_GUIDE.md             # This file
├── server/                    # ECPay payment server (deploy to Render.com free)
│   ├── index.js               # Express server — handles ECPay callbacks
│   ├── package.json
│   └── .env.example           # Copy to .env and fill in your credentials
└── public/                    # Deployed to Firebase Hosting
    ├── index.html             # User file browser + store
    ├── login.html             # Sign-in page
    ├── register.html          # Registration page
    ├── admin.html             # Admin console (with Pricing tab)
    ├── status.html            # System status page
    ├── js/
    │   └── config.js          # Firebase + Supabase config (fill this in)
    └── css/
        └── style.css          # Global styles
```

> Note: The `cloudflare-worker/` and `functions/` folders are not needed and can be ignored.

---

## Security Notes

- **Database Rules** (`database.rules.json`) ensure:
  - Users can only read their own access grants
  - Only admins can write to `/files` and `/access`
  - Admin status cannot be self-assigned
- **Supabase Storage** serves files publicly by URL, but only admins can upload (enforced in the app + Supabase policy)
- **Access expiry** is checked client-side when loading the file list
- File type validation (PDF, PNG, JPG only) is enforced before upload

---

## Granting Admin Access to More Users

To promote another user to admin:
1. Find their UID in Firebase Console → Authentication → Users
2. In Realtime Database, under `/admins`, add: Key = `{uid}`, Value = `true`

To revoke: delete that entry from `/admins`.
