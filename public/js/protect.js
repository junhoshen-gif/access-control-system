/**
 * FileAccess – Content Protection
 * - Blocks right-click, keyboard shortcuts, drag, print
 * - Shows a toast error message on every blocked attempt
 * - Applies a user email watermark inside the file viewer (screenshot deterrent)
 */

(function () {

  // ── Toast notification ────────────────────────────────────────────────────
  // Inject toast container into DOM immediately
  const toastContainer = document.createElement("div");
  toastContainer.id = "protect-toast-container";
  toastContainer.style.cssText = `
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 99999;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    pointer-events: none;
  `;
  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(toastContainer);
  });

  let toastTimeout = null;

  function showBlockedToast(message) {
    // Remove any existing toast immediately
    toastContainer.innerHTML = "";
    clearTimeout(toastTimeout);

    const toast = document.createElement("div");
    toast.style.cssText = `
      background: #1E293B;
      color: #F8FAFC;
      padding: 0.65rem 1.25rem;
      border-radius: 8px;
      font-family: Inter, system-ui, sans-serif;
      font-size: 0.875rem;
      font-weight: 500;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
      display: flex;
      align-items: center;
      gap: 0.6rem;
      pointer-events: none;
      animation: toast-in 0.18s ease;
    `;
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2.5" style="flex-shrink:0">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      ${message}
    `;
    toastContainer.appendChild(toast);

    toastTimeout = setTimeout(() => {
      toast.style.animation = "toast-out 0.18s ease forwards";
      setTimeout(() => toastContainer.innerHTML = "", 180);
    }, 2800);
  }

  // Inject keyframe animations
  const style = document.createElement("style");
  style.textContent = `
    @keyframes toast-in  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    @keyframes toast-out { from { opacity:1; transform:translateY(0); } to { opacity:0; transform:translateY(8px); } }
  `;
  document.head.appendChild(style);

  // ── 1. Block right-click ──────────────────────────────────────────────────
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showBlockedToast("Right-click is disabled on this page.");
    return false;
  });

  // ── 2. Block keyboard shortcuts ───────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;

    const blocked = [
      { match: ctrl && e.key === "s",                          msg: "Saving is not allowed." },
      { match: ctrl && e.key === "c",                          msg: "Copying is not allowed." },
      { match: ctrl && e.key === "u",                          msg: "Viewing source is not allowed." },
      { match: ctrl && e.key === "p",                          msg: "Printing is not allowed." },
      { match: ctrl && e.key === "a",                          msg: "Select all is not allowed." },
      { match: ctrl && e.shiftKey && e.key === "i",            msg: "Developer tools are disabled." },
      { match: ctrl && e.shiftKey && e.key === "j",            msg: "Developer tools are disabled." },
      { match: ctrl && e.shiftKey && e.key === "c",            msg: "Developer tools are disabled." },
      { match: e.key === "F12",                                msg: "Developer tools are disabled." },
      { match: ctrl && e.key === "S",                          msg: "Saving is not allowed." },
    ];

    for (const b of blocked) {
      if (b.match) {
        e.preventDefault();
        showBlockedToast(b.msg);
        return false;
      }
    }
  });

  // ── 3. Block drag to save ─────────────────────────────────────────────────
  document.addEventListener("dragstart", (e) => {
    if (!e.target.closest("#uploadZone") && !e.target.closest("input[type=file]")) {
      e.preventDefault();
      showBlockedToast("Dragging content off this page is not allowed.");
      return false;
    }
  });

  // ── 4. Block text selection on protected areas ────────────────────────────
  document.addEventListener("selectstart", (e) => {
    if (e.target.closest(".file-viewer-frame, .image-viewer, .file-card, .file-icon")) {
      e.preventDefault();
      showBlockedToast("Text selection is disabled on file content.");
      return false;
    }
  });

  // ── 5. Block print ────────────────────────────────────────────────────────
  window.addEventListener("beforeprint", () => {
    document.body.setAttribute("data-printing", "true");
    showBlockedToast("Printing is not allowed.");
  });
  window.addEventListener("afterprint", () => {
    document.body.removeAttribute("data-printing");
  });

  // ── 6. Watermark: stamp user email on file viewer ─────────────────────────
  // Called by index.html once the user is authenticated and opens a file.
  // Creates a repeating diagonal watermark canvas overlay.
  window.applyViewerWatermark = function (userEmail) {
    // Remove existing watermark if any
    const existing = document.getElementById("viewer-watermark");
    if (existing) existing.remove();

    const watermark = document.createElement("canvas");
    watermark.id = "viewer-watermark";
    watermark.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 10;
      opacity: 0.18;
    `;

    // Size the canvas after it's in the DOM
    requestAnimationFrame(() => {
      const parent = watermark.parentElement;
      if (!parent) return;
      const w = parent.offsetWidth  || 800;
      const h = parent.offsetHeight || 600;
      watermark.width  = w;
      watermark.height = h;

      const ctx = watermark.getContext("2d");
      ctx.font = "bold 15px Inter, system-ui, sans-serif";
      ctx.fillStyle = "#000000";
      ctx.rotate(-30 * Math.PI / 180);

      const text  = `🔒 ${userEmail}`;
      const stepX = 260;
      const stepY = 110;

      // Tile the watermark across the canvas (accounting for rotation)
      for (let y = -h; y < w + h; y += stepY) {
        for (let x = -w; x < w + h; x += stepX) {
          ctx.fillText(text, x, y);
        }
      }
    });

    return watermark;
  };

  // Expose showBlockedToast so other scripts can use it if needed
  window.showBlockedToast = showBlockedToast;

})();
