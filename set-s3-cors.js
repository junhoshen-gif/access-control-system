/**
 * set-s3-cors.js
 * ──────────────
 * Run once to set the CORS rule on your S3 bucket so browsers can
 * upload directly (presigned PUT URLs).
 *
 * Usage:
 *   1. Fill in your values below  (or set as environment variables)
 *   2. npm install @aws-sdk/client-s3          (in this folder)
 *   3. node set-s3-cors.js
 */

const {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} = require("@aws-sdk/client-s3");

// ── Config — edit these or set as env vars ────────────────────────────────
const AWS_ACCESS_KEY_ID     = process.env.AWS_ACCESS_KEY_ID     || "YOUR_ACCESS_KEY";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "YOUR_SECRET_KEY";
const AWS_REGION            = process.env.AWS_REGION            || "YOUR_REGION";
const S3_BUCKET             = process.env.S3_BUCKET             || "YOUR_BUCKET_NAME";

// Firebase projects are served from BOTH *.web.app AND *.firebaseapp.com.
// Both origins must be listed or S3 will block the browser's direct fetch()
// of presigned GET URLs (causing "Failed to fetch" / "Could not load PDF").
const ALLOWED_ORIGINS = process.env.SITE_URL
  ? [process.env.SITE_URL]
  : [
      "https://access-control-system-335f5.web.app",
      "https://access-control-system-335f5.firebaseapp.com",
    ];
// ─────────────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

const corsConfig = {
  CORSRules: [
    {
      // Allow the browser to PUT files directly and GET signed URLs
      AllowedHeaders: ["*"],
      AllowedMethods: ["PUT", "GET", "HEAD"],
      AllowedOrigins: ALLOWED_ORIGINS,
      ExposeHeaders:  ["ETag"],
      MaxAgeSeconds:  3600,
    },
  ],
};

async function main() {
  console.log(`Setting CORS on bucket: ${S3_BUCKET}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}\n`);

  // Apply CORS
  await s3.send(new PutBucketCorsCommand({
    Bucket:            S3_BUCKET,
    CORSConfiguration: corsConfig,
  }));
  console.log("✓ CORS rule applied.\n");

  // Read it back to confirm
  const result = await s3.send(new GetBucketCorsCommand({ Bucket: S3_BUCKET }));
  console.log("Current CORS config:");
  console.log(JSON.stringify(result.CORSRules, null, 2));
}

main().catch(err => {
  console.error("✗ Error:", err.message);
  process.exit(1);
});
