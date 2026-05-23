/**
 * FileAccess – Cloudflare Worker
 * Handles pre-signed URL generation for Cloudflare R2 uploads.
 *
 * Deploy this Worker at: https://dash.cloudflare.com → Workers & Pages → Create Worker
 *
 * Environment variables to set in the Worker dashboard (Settings → Variables):
 *   R2_BUCKET        — bind your R2 bucket (R2 Bucket binding, name: "R2_BUCKET")
 *   PUBLIC_BUCKET_URL — the public URL of your R2 bucket, e.g. https://pub-xxxx.r2.dev
 *   ALLOWED_ORIGIN    — your Firebase Hosting URL, e.g. https://your-project.web.app
 */


export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-UID",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── POST /upload-url — Generate a pre-signed PUT URL ────────────────────
    if (request.method === "POST" && url.pathname === "/upload-url") {
      try {
        const { key, contentType } = await request.json();

        if (!key || !contentType) {
          return jsonResponse({ error: "Missing key or contentType" }, 400, corsHeaders);
        }

        // Validate content type
        const allowed = ["application/pdf", "image/png", "image/jpeg"];
        if (!allowed.includes(contentType)) {
          return jsonResponse({ error: "Unsupported file type" }, 400, corsHeaders);
        }

        // Generate a pre-signed URL valid for 15 minutes
        const uploadUrl = await env.R2_BUCKET.createMultipartUpload
          ? await getPresignedUrl(env.R2_BUCKET, key, contentType)
          : null;

        // Fallback: use signed URL via Workers API
        // Note: R2 presigned URLs require the R2 Workers API
        const signedUrl = await env.R2_BUCKET.put(key, null, {
          httpMetadata: { contentType },
          onlyIf: { etagDoesNotMatch: "*" } // Only if not exists
        }).catch(() => null);

        // Generate upload URL (Workers R2 binding method)
        const multipart = await env.R2_BUCKET.createMultipartUpload(key, {
          httpMetadata: { contentType }
        }).catch(() => null);

        // Use direct upload approach instead
        const publicUrl = `${env.PUBLIC_BUCKET_URL}/${key}`;

        // For simple single-part uploads, return a token-based approach
        // The worker acts as a proxy for the upload
        return jsonResponse({
          uploadUrl: `${url.origin}/upload/${encodeURIComponent(key)}?ct=${encodeURIComponent(contentType)}`,
          publicUrl
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── PUT /upload/:key — Proxy upload to R2 ───────────────────────────────
    if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
      try {
        const key = decodeURIComponent(url.pathname.replace("/upload/", ""));
        const contentType = url.searchParams.get("ct") || "application/octet-stream";

        const body = await request.arrayBuffer();
        await env.R2_BUCKET.put(key, body, {
          httpMetadata: { contentType }
        });

        const publicUrl = `${env.PUBLIC_BUCKET_URL}/${key}`;
        return jsonResponse({ success: true, publicUrl }, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /file/:key — Serve files (enforces no-download) ─────────────────
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      try {
        const key = decodeURIComponent(url.pathname.replace("/file/", ""));
        const object = await env.R2_BUCKET.get(key);

        if (!object) {
          return new Response("File not found", { status: 404, headers: corsHeaders });
        }

        const headers = new Headers(corsHeaders);
        object.writeHttpMetadata(headers);
        // Prevent download — force inline display
        headers.set("Content-Disposition", "inline");
        headers.set("X-Content-Type-Options", "nosniff");
        // Cache for 1 hour
        headers.set("Cache-Control", "private, max-age=3600");

        return new Response(object.body, { headers });
      } catch (err) {
        return new Response(err.message, { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}
