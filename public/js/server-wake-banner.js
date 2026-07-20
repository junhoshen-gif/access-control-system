/**
 * FileAccess – Render "cold start" banner
 * -----------------------------------------------------------------------
 * The Render server free-tier instance can spin down when idle and takes
 * ~30-50 seconds to wake back up on the next request. This probes the
 * server's health endpoint (GET /) and shows a heads-up banner for as long
 * as it's unreachable/slow, then automatically hides it the moment the
 * server responds — no guessing based on time of day.
 *
 * Usage: <script src="js/server-wake-banner.js"></script>
 * (load after js/i18n.js if you want it translated; falls back to English)
 */
(function () {
  const PROBE_TIMEOUT_MS = 3000;   // fast initial check — don't delay warm-server pageloads
  const POLL_TIMEOUT_MS  = 6000;   // each retry while waking gets a bit more slack
  const POLL_INTERVAL_MS = 3000;   // gap between retries while waking

  let bannerEl   = null;
  let shifted    = false;
  let pollTimer  = null;
  let dismissed  = false;

  function message() {
    if (window.t) return t("banner_serverStarting");
    return "Server starting, please wait about 30–50 seconds…";
  }

  // Many pages in this app use a fixed-position nav/topbar (.navbar, #topbar)
  // and fixed/positioned content areas keyed off its height (#viewerArea).
  // Rather than assume a single layout, we push every already-fixed element
  // down by the banner's height and reserve the same space in normal flow
  // via body padding-top (harmless no-op on pages with no flow content there).
  function shiftFixedLayout(offsetPx) {
    const selectors = [".navbar", "#topbar", "#viewerArea"];
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed") return;
        const currentTop = parseFloat(cs.top) || 0;
        el.style.top = (currentTop + offsetPx) + "px";
      });
    });
    document.body.style.paddingTop = offsetPx + "px";
  }

  function showBanner() {
    if (bannerEl || dismissed) return;

    const bar = document.createElement("div");
    bar.id = "serverWakeBanner";
    bar.style.cssText = `
      display:flex; align-items:center; justify-content:center; gap:0.6rem;
      background:#FEF3C7; color:#92400E; border-bottom:1px solid #FDE68A;
      font-size:0.85rem; font-weight:500; padding:0.6rem 1rem;
      text-align:center; position:fixed; top:0; left:0; right:0; z-index:99997;
    `;
    bar.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:0.5rem;">
        <span class="server-wake-spinner" style="
          width:13px;height:13px;border:2px solid rgba(146,64,14,0.3);
          border-top-color:#92400E;border-radius:50%;
          animation:serverWakeSpin 0.8s linear infinite;display:inline-block;">
        </span>
        <span id="serverWakeBannerText"></span>
      </span>
      <button id="serverWakeBannerClose" aria-label="Dismiss" style="
        background:none;border:none;color:#92400E;cursor:pointer;
        font-size:1rem;line-height:1;padding:0 0.25rem;margin-left:0.5rem;">×</button>
    `;

    if (!document.getElementById("serverWakeBannerStyle")) {
      const style = document.createElement("style");
      style.id = "serverWakeBannerStyle";
      style.textContent = "@keyframes serverWakeSpin { to { transform: rotate(360deg); } }";
      document.head.appendChild(style);
    }

    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById("serverWakeBannerText").textContent = message();

    bannerEl = bar;
    const bannerHeight = bar.offsetHeight;
    shiftFixedLayout(bannerHeight);
    shifted = true;

    document.getElementById("serverWakeBannerClose").addEventListener("click", () => {
      dismissed = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      hideBanner();
    });
  }

  function hideBanner() {
    if (!bannerEl) return;
    const h = bannerEl.offsetHeight;
    bannerEl.remove();
    bannerEl = null;
    if (shifted) { shiftFixedLayout(-h); shifted = false; }
  }

  // Resolves true if the server answered within timeoutMs, false otherwise
  // (covers both network/CORS errors and our own abort-on-timeout).
  async function pingHealth(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store", mode: "cors" });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function startPolling(url) {
    if (pollTimer || dismissed) return;
    pollTimer = setInterval(async () => {
      const healthy = await pingHealth(url, POLL_TIMEOUT_MS);
      if (healthy) {
        clearInterval(pollTimer);
        pollTimer = null;
        hideBanner();
      }
    }, POLL_INTERVAL_MS);
  }

  async function init() {
    let RENDER_SERVER_URL;
    try {
      const cfg = await import("./js/config.js");
      RENDER_SERVER_URL = cfg.RENDER_SERVER_URL;
    } catch {
      return; // can't resolve config — skip the feature rather than guess
    }
    if (!RENDER_SERVER_URL) return;

    const healthUrl = RENDER_SERVER_URL.replace(/\/+$/, "") + "/";

    // Fast initial probe: if the server answers quickly, never show anything.
    const healthy = await pingHealth(healthUrl, PROBE_TIMEOUT_MS);
    if (healthy) return;

    showBanner();
    startPolling(healthUrl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
