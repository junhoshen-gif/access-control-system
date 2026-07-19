/**
 * FileAccess – Render "cold start" banner
 * -----------------------------------------------------------------------
 * The Render server is only kept warm by an external cron ping (cron-job.org)
 * every 5 minutes between 08:00–20:00 Taipei time. Outside that window the
 * free-tier instance may have spun down, so the first request can take
 * ~30-50 seconds to wake it back up. This shows a small heads-up banner in
 * that case so users don't think the app is broken while it wakes up.
 *
 * Usage: <script src="js/server-wake-banner.js"></script>
 * (load after js/i18n.js if you want it translated; falls back to English)
 */
(function () {
  const ACTIVE_START_HOUR = 8;  // 08:00 Taipei
  const ACTIVE_END_HOUR    = 20; // 20:00 Taipei

  function taipeiHour() {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Taipei",
        hour: "numeric",
        hourCycle: "h23",
      }).formatToParts(new Date());
      const h = parts.find(p => p.type === "hour");
      return h ? parseInt(h.value, 10) : null;
    } catch {
      return null;
    }
  }

  function isOutsideActiveWindow() {
    const hour = taipeiHour();
    if (hour === null) return false; // fail safe: don't show if we can't tell
    return !(hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR);
  }

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
    if (document.getElementById("serverWakeBanner")) return;

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

    const style = document.createElement("style");
    style.textContent = "@keyframes serverWakeSpin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);

    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById("serverWakeBannerText").textContent = message();

    const bannerHeight = bar.offsetHeight;
    shiftFixedLayout(bannerHeight);

    document.getElementById("serverWakeBannerClose").addEventListener("click", () => {
      bar.remove();
      shiftFixedLayout(-bannerHeight);
    });
  }

  function init() {
    if (isOutsideActiveWindow()) showBanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
