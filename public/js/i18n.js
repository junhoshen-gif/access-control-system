/**
 * FileAccess – Lightweight i18n (English / Traditional Chinese - Taiwan)
 * -----------------------------------------------------------------------
 * Usage:
 *   <script src="js/i18n.js"></script>
 *   Tag static text:      <h1 data-i18n="login_title">Sign in</h1>
 *   Tag placeholders:     <input data-i18n-placeholder="emailPlaceholder" placeholder="you@example.com"/>
 *   Tag title attrs:      <button data-i18n-title="zoomIn" title="Zoom in">+</button>
 *   In JS:                t("login_title")  → returns translated string for current language
 *   Inject a toggle:      i18n.injectToggle(document.querySelector(".nav-right"))
 *
 * Language is persisted in localStorage("lang") and defaults to the browser
 * language (zh if the browser is set to any Chinese locale, else en).
 * Switching languages reloads the page — the simplest way to guarantee any
 * JS-generated content also re-renders in the new language.
 */
(function () {
  const STORAGE_KEY = "lang";

  const DICT = {
    en: {
      // ── Shared / nav ──────────────────────────────────────────────
      brand: "FileAccess",
      navAdmin: "Admin Console",
      navStatus: "Status",
      navMyFiles: "My Files",
      navSignIn: "Sign in",
      navSignOut: "Sign out",
      loading: "Loading…",

      // ── login.html ────────────────────────────────────────────────
      login_title: "Welcome back",
      login_subtitle: "Sign in to access your files",
      login_email: "Email",
      login_password: "Password",
      login_emailPlaceholder: "you@example.com",
      login_passwordPlaceholder: "••••••••",
      login_show: "Show",
      login_hide: "Hide",
      login_signInBtn: "Sign in",
      login_or: "or continue with",
      login_google: "Continue with Google",
      login_noAccount: "Don't have an account?",
      login_createOne: "Create one",
      login_completingSignIn: "Completing sign-in…",
      err_userNotFound: "No account found with this email.",
      err_wrongPassword: "Incorrect password. Please try again.",
      err_invalidEmail: "Please enter a valid email address.",
      err_tooManyRequests: "Too many attempts. Please try again later.",
      err_accountExistsDifferentCred: "An account already exists with this email using a different sign-in method.",
      err_invalidCredential: "Invalid credentials. Please check your email and password.",
      err_signInFailed: "Sign-in failed. Please try again.",

      // ── register.html ────────────────────────────────────────────
      register_title: "Create an account",
      register_subtitle: "Sign up to get started",
      register_fullName: "Full Name",
      register_fullNamePlaceholder: "Jane Smith",
      register_email: "Email",
      register_emailPlaceholder: "you@example.com",
      register_password: "Password",
      register_passwordPlaceholder: "Min. 8 characters",
      register_confirmPassword: "Confirm Password",
      register_confirmPasswordPlaceholder: "••••••••",
      register_createAccountBtn: "Create Account",
      register_or: "or sign up with",
      register_google: "Continue with Google",
      register_haveAccount: "Already have an account?",
      register_signIn: "Sign in",
      err_passwordsNoMatch: "Passwords do not match.",
      err_emailInUse: "An account with this email already exists.",
      err_weakPassword: "Password must be at least 6 characters.",
      err_registrationFailed: "Registration failed. Please try again.",

      // ── index.html ────────────────────────────────────────────────
      idx_myFiles: "My Files",
      idx_searchPlaceholder: "Search files…",
      idx_filterAll: "All",
      idx_filterDocs: "Docs",
      idx_filterImages: "Images",
      idx_filterMedia: "Media",
      idx_filterOther: "Other",
      idx_loadingFiles: "Loading your files…",
      idx_noFiles: "No files available yet",
      idx_noFilesHint: "Contact an admin to get access to files.",
      idx_loadFailed: "Failed to load files. Please refresh.",
      idx_cookieTitle: "💾 Enable offline caching?",
      idx_cookieBody: "Files you open will be stored locally so you don't need to re-download them each visit.",
      idx_cookieAccept: "Accept",
      idx_cookieDecline: "Decline",
      idx_fileNameFallback: "File Name",

      // ── viewer.html ───────────────────────────────────────────────
      v_back: "Back",
      v_openingFile: "Opening file…",
      v_step1Label: "Authenticating",
      v_step1Sub: "Verifying your session…",
      v_step2Label: "Fetching secure link",
      v_step2Sub: "Requesting access from server…",
      v_step3Label: "Downloading file",
      v_step4Label: "Rendering",
      v_waiting: "Waiting…",
      v_zoomOut: "Zoom out",
      v_zoomIn: "Zoom in",
      v_resetZoom: "Reset zoom",
      v_reset: "Reset",
      v_failedToLoad: "Failed to load file",
      v_goBack: "← Go back",
      v_checkingLogin: "Checking login…",
      v_notLoggedIn: "Not logged in",
      v_noFileSpecified: "No file specified",
      v_noFileIdMsg: "No file ID was provided in the URL.",
      v_signedInAs: "Signed in as",
      v_checkingCache: "Checking local cache…",
      v_loadedFromCache: "Loaded from cache",
      v_cached: "cached",
      v_contactingServer: "Contacting server…",
      v_secureLinkReceived: "Secure link received",
      v_couldNotGetLink: "Could not get file link:",
      v_connectingToStorage: "Connecting to storage…",
      v_downloadStalled: "Download stalled (no data for 30s). Please try again.",
      v_downloaded: "downloaded",
      v_couldNotDownload: "Could not download file:",
      v_preparingViewer: "Preparing viewer…",
      v_ready: "Ready",
      v_cannotPreview: "Cannot preview this file type",
      v_askAdminFormat: "Ask an admin to share a viewable format.",
      v_loadingPdfEngine: "Loading PDF engine…",
      v_parsingDocument: "Parsing document…",
      v_page: "page",
      v_pages: "pages",
      v_rendering: "Rendering",
      v_pageOf: "Page",
      toast_rightClickDisabled: "Right-click is disabled on this page.",
      toast_devtoolsDisabled: "Developer tools are disabled.",
      toast_printingNotAllowed: "Printing is not allowed.",
      toast_savingNotAllowed: "Saving is not allowed.",
      toast_viewSourceNotAllowed: "Viewing source is not allowed.",
      toast_copyingNotAllowed: "Copying is not allowed.",
      toast_selectAllNotAllowed: "Select all is not allowed.",
      toast_dragNotAllowed: "Dragging content off this page is not allowed.",
      toast_devtoolsNotAllowed: "Developer tools are not allowed.",

      // ── status.html ───────────────────────────────────────────────
      status_title: "System Status",
      status_checking: "Checking systems…",
      status_recheck: "Recheck Now",

      // ── server wake banner ───────────────────────────────────────
      banner_serverStarting: "Server starting, please wait about 30–50 seconds…",
    },

    zh: {
      // ── Shared / nav ──────────────────────────────────────────────
      brand: "FileAccess",
      navAdmin: "管理主控台",
      navStatus: "系統狀態",
      navMyFiles: "我的檔案",
      navSignIn: "登入",
      navSignOut: "登出",
      loading: "載入中…",

      // ── login.html ────────────────────────────────────────────────
      login_title: "歡迎回來",
      login_subtitle: "登入以存取您的檔案",
      login_email: "電子郵件",
      login_password: "密碼",
      login_emailPlaceholder: "you@example.com",
      login_passwordPlaceholder: "••••••••",
      login_show: "顯示",
      login_hide: "隱藏",
      login_signInBtn: "登入",
      login_or: "或使用以下方式繼續",
      login_google: "使用 Google 繼續",
      login_noAccount: "還沒有帳號？",
      login_createOne: "建立帳號",
      login_completingSignIn: "登入處理中…",
      err_userNotFound: "找不到此電子郵件對應的帳號。",
      err_wrongPassword: "密碼錯誤，請再試一次。",
      err_invalidEmail: "請輸入有效的電子郵件地址。",
      err_tooManyRequests: "嘗試次數過多，請稍後再試。",
      err_accountExistsDifferentCred: "此電子郵件已使用其他登入方式註冊過帳號。",
      err_invalidCredential: "帳號或密碼有誤，請確認後再試。",
      err_signInFailed: "登入失敗，請再試一次。",

      // ── register.html ────────────────────────────────────────────
      register_title: "建立帳號",
      register_subtitle: "註冊以開始使用",
      register_fullName: "姓名",
      register_fullNamePlaceholder: "王小明",
      register_email: "電子郵件",
      register_emailPlaceholder: "you@example.com",
      register_password: "密碼",
      register_passwordPlaceholder: "至少 8 個字元",
      register_confirmPassword: "確認密碼",
      register_confirmPasswordPlaceholder: "••••••••",
      register_createAccountBtn: "建立帳號",
      register_or: "或使用以下方式註冊",
      register_google: "使用 Google 繼續",
      register_haveAccount: "已經有帳號了嗎？",
      register_signIn: "登入",
      err_passwordsNoMatch: "兩次輸入的密碼不一致。",
      err_emailInUse: "此電子郵件已被註冊。",
      err_weakPassword: "密碼至少需要 6 個字元。",
      err_registrationFailed: "註冊失敗，請再試一次。",

      // ── index.html ────────────────────────────────────────────────
      idx_myFiles: "我的檔案",
      idx_searchPlaceholder: "搜尋檔案…",
      idx_filterAll: "全部",
      idx_filterDocs: "文件",
      idx_filterImages: "圖片",
      idx_filterMedia: "媒體",
      idx_filterOther: "其他",
      idx_loadingFiles: "正在載入您的檔案…",
      idx_noFiles: "目前尚無可用檔案",
      idx_noFilesHint: "請聯絡管理員以取得檔案存取權限。",
      idx_loadFailed: "載入檔案失敗，請重新整理頁面。",
      idx_cookieTitle: "💾 是否啟用離線快取？",
      idx_cookieBody: "開啟過的檔案將儲存在本機，下次不需重新下載。",
      idx_cookieAccept: "接受",
      idx_cookieDecline: "拒絕",
      idx_fileNameFallback: "檔案名稱",

      // ── viewer.html ───────────────────────────────────────────────
      v_back: "返回",
      v_openingFile: "開啟檔案中…",
      v_step1Label: "驗證中",
      v_step1Sub: "正在確認您的登入狀態…",
      v_step2Label: "取得安全連結",
      v_step2Sub: "正在向伺服器要求存取權限…",
      v_step3Label: "下載檔案",
      v_step4Label: "渲染畫面",
      v_waiting: "等待中…",
      v_zoomOut: "縮小",
      v_zoomIn: "放大",
      v_resetZoom: "重設縮放",
      v_reset: "重設",
      v_failedToLoad: "檔案載入失敗",
      v_goBack: "← 返回",
      v_checkingLogin: "正在確認登入狀態…",
      v_notLoggedIn: "尚未登入",
      v_noFileSpecified: "未指定檔案",
      v_noFileIdMsg: "網址中未提供檔案 ID。",
      v_signedInAs: "已登入：",
      v_checkingCache: "正在檢查本機快取…",
      v_loadedFromCache: "已從快取載入",
      v_cached: "快取",
      v_contactingServer: "正在連接伺服器…",
      v_secureLinkReceived: "已取得安全連結",
      v_couldNotGetLink: "無法取得檔案連結：",
      v_connectingToStorage: "正在連接儲存空間…",
      v_downloadStalled: "下載停滯（30 秒內無回應），請再試一次。",
      v_downloaded: "已下載",
      v_couldNotDownload: "無法下載檔案：",
      v_preparingViewer: "正在準備檢視器…",
      v_ready: "完成",
      v_cannotPreview: "無法預覽此檔案類型",
      v_askAdminFormat: "請聯絡管理員提供可檢視的格式。",
      v_loadingPdfEngine: "正在載入 PDF 引擎…",
      v_parsingDocument: "正在解析文件…",
      v_page: "頁",
      v_pages: "頁",
      v_rendering: "正在渲染",
      v_pageOf: "第",
      toast_rightClickDisabled: "此頁面已停用滑鼠右鍵。",
      toast_devtoolsDisabled: "已停用開發者工具。",
      toast_printingNotAllowed: "不允許列印。",
      toast_savingNotAllowed: "不允許儲存。",
      toast_viewSourceNotAllowed: "不允許檢視原始碼。",
      toast_copyingNotAllowed: "不允許複製。",
      toast_selectAllNotAllowed: "不允許全選。",
      toast_dragNotAllowed: "不允許將內容拖曳離開此頁面。",
      toast_devtoolsNotAllowed: "不允許使用開發者工具。",

      // ── status.html ───────────────────────────────────────────────
      status_title: "系統狀態",
      status_checking: "檢查系統中…",
      status_recheck: "立即重新檢查",

      // ── server wake banner ───────────────────────────────────────
      banner_serverStarting: "伺服器啟動中，請稍候約 30–50 秒…",
    },
  };

  function detectDefaultLang() {
    const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.startsWith("zh") ? "zh" : "en";
  }

  function getLang() {
    return localStorage.getItem(STORAGE_KEY) || detectDefaultLang();
  }

  function setLang(lang) {
    localStorage.setItem(STORAGE_KEY, lang);
    location.reload();
  }

  function t(key) {
    const lang = getLang();
    return (DICT[lang] && DICT[lang][key]) || (DICT.en[key]) || key;
  }

  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach(el => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    root.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
  }

  function injectToggle(container) {
    if (!container || document.getElementById("langToggleBtn")) return;
    const lang = getLang();
    const btn = document.createElement("button");
    btn.id = "langToggleBtn";
    btn.className = "btn btn-ghost btn-sm";
    btn.type = "button";
    btn.style.cssText = "font-size:0.8rem;white-space:nowrap;";
    btn.textContent = lang === "zh" ? "EN" : "中文";
    btn.title = lang === "zh" ? "Switch to English" : "切換為中文";
    btn.addEventListener("click", () => setLang(lang === "zh" ? "en" : "zh"));
    container.appendChild(btn);
  }

  document.addEventListener("DOMContentLoaded", () => applyI18n(document));

  window.t = t;
  window.i18n = { t, getLang, setLang, applyI18n, injectToggle };
})();
