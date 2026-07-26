(() => {
  "use strict";

  const REFRESH_INTERVAL_MS = 60_000;
  const REQUEST_TIMEOUT_MS = 15_000;
  const THEME_KEY = "backupdash.theme";

  const STATUS = {
    ok: { label: "Gesund", className: "is-ok" },
    error: { label: "Fehler", className: "is-error" },
    stale: { label: "Überfällig", className: "is-stale" },
  };

  const state = {
    servers: [],
    summary: {
      servers: 0,
      ok: 0,
      error: 0,
      stale: 0,
      repo_total_gb: 0,
      runs_24h: 0,
      fails_7d: 0,
      verify_fails_30d: 0,
      watchdog_fails_24h: 0,
    },
    online: false,
    initialized: false,
    lastSync: null,
    refreshPromise: null,
    route: { name: "overview" },
    search: "",
    statusFilter: "all",
    charts: [],
    viewNonce: 0,
    updatePolling: false,
    currentUser: null,
    webauthn: { secure_context: false, available: false },
    authView: { kind: "login" },
  };

  const dom = {
    authScreen: document.querySelector("#auth-screen"),
    authContent: document.querySelector("#auth-content"),
    appShell: document.querySelector("#app-shell"),
    main: document.querySelector("#main-content"),
    breadcrumb: document.querySelector("#breadcrumb"),
    serverNav: document.querySelector("#server-nav"),
    serverCount: document.querySelector("#server-count"),
    syncLabel: document.querySelector("#sync-label"),
    footerSummary: document.querySelector("#footer-summary"),
    navUsers: document.querySelector("#nav-users"),
    accountUsername: document.querySelector("#account-username"),
    accountAvatar: document.querySelector("#account-avatar"),
    confirmDialog: document.querySelector("#confirm-dialog"),
    confirmEyebrow: document.querySelector("#confirm-eyebrow"),
    confirmTitle: document.querySelector("#confirm-title"),
    confirmMessage: document.querySelector("#confirm-message"),
    confirmSubmit: document.querySelector("#confirm-submit"),
    toastRegion: document.querySelector("#toast-region"),
  };

  // Minimal Feather-style line-icon set (MIT-licensed shapes, hand-authored
  // inline so the UI never depends on an icon font or external sprite).
  const ICON_PATHS = {
    home: '<path d="M3 11.2 12 4l9 7.2"></path><path d="M5.5 9.6V20h13V9.6"></path><path d="M9.5 20v-6h5v6"></path>',
    chevronRight: '<polyline points="9 18 15 12 9 6"></polyline>',
    chevronLeft: '<polyline points="15 18 9 12 15 6"></polyline>',
    helpCircle: '<circle cx="12" cy="12" r="9.5"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    search: '<circle cx="11" cy="11" r="7.5"></circle><line x1="21" y1="21" x2="16.2" y2="16.2"></line>',
    more: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
    trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>',
    terminal: '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>',
    x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    checkCircle: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
    alertTriangle: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    clock: '<circle cx="12" cy="12" r="9.5"></circle><polyline points="12 6.5 12 12 16 14"></polyline>',
    server: '<rect x="2.5" y="3" width="19" height="7.5" rx="2"></rect><rect x="2.5" y="13.5" width="19" height="7.5" rx="2"></rect><line x1="6.5" y1="6.75" x2="6.51" y2="6.75"></line><line x1="6.5" y1="17.25" x2="6.51" y2="17.25"></line>',
    box: '<path d="M21 8.5v7L12 20 3 15.5v-7L12 4z"></path><path d="M3 8.5 12 13l9-4.5"></path><line x1="12" y1="13" x2="12" y2="20"></line>',
    copy: '<rect x="9" y="9" width="12.5" height="12.5" rx="2"></rect><path d="M5 15H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2V5"></path>',
    lock: '<rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    smartphone: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line>',
    key: '<path d="M21 2 19 4m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"></path>',
  };

  const icon = (name, extraClass = "") => {
    const body = ICON_PATHS[name];
    if (!body) return "";
    return `<svg class="icon${extraClass ? ` ${extraClass}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  class ApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);

  const encodeData = (value) => escapeHtml(encodeURIComponent(String(value ?? "")));
  const decodeData = (value) => {
    try {
      return decodeURIComponent(value || "");
    } catch {
      return "";
    }
  };

  const asNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const formatDateTime = (timestamp) => {
    const date = new Date(asNumber(timestamp) * 1000);
    if (Number.isNaN(date.getTime())) return "–";
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  const formatDate = (timestamp) => {
    const date = new Date(asNumber(timestamp) * 1000);
    if (Number.isNaN(date.getTime())) return "–";
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
    }).format(date);
  };

  const formatAgo = (timestamp) => {
    const delta = Date.now() / 1000 - asNumber(timestamp);
    if (!Number.isFinite(delta) || delta < 0) return "gerade eben";
    if (delta < 90) return "vor < 1 Min.";
    if (delta < 3600) return `vor ${Math.round(delta / 60)} Min.`;
    if (delta < 86400) return `vor ${(delta / 3600).toFixed(1)} Std.`;
    return `vor ${(delta / 86400).toFixed(1)} Tagen`;
  };

  const formatGb = (value) => {
    if (value === null || value === undefined || value === "") return "–";
    const numeric = asNumber(value, NaN);
    if (!Number.isFinite(numeric)) return "–";
    if (numeric >= 1000) return `${(numeric / 1000).toFixed(2)} TB`;
    return `${numeric.toFixed(1)} GB`;
  };

  const formatDuration = (seconds) => {
    if (seconds === null || seconds === undefined || seconds === "") return "–";
    const numeric = Math.max(0, Math.round(asNumber(seconds)));
    if (numeric >= 3600) return `${Math.floor(numeric / 3600)} Std. ${Math.round((numeric % 3600) / 60)} Min.`;
    if (numeric >= 60) return `${Math.floor(numeric / 60)} Min. ${numeric % 60} Sek.`;
    return `${numeric} Sek.`;
  };

  const statusInfo = (value) => STATUS[value] || STATUS.error;
  const shortHost = (hostname) => String(hostname || "Unbekannt").split(".")[0];
  const initials = (hostname) => shortHost(hostname).slice(0, 2);
  const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function renderCheckCard(title, check) {
    if (!check) {
      return `
        <article class="check-card">
          <div class="check-card-head"><span>${escapeHtml(title)}</span><span class="status-badge is-neutral">Ausstehend</span></div>
          <p class="check-card-meta">Noch keine Meldung erhalten.</p>
        </article>`;
    }
    const info = statusInfo(check.state);
    const detail = check.last_message || (check.last_status === "ok" ? "Erfolgreich" : "Fehler ohne Meldung");
    return `
      <article class="check-card">
        <div class="check-card-head"><span>${escapeHtml(title)}</span><span class="status-badge ${info.className}">${info.label}</span></div>
        <p class="check-card-meta">Zuletzt ${escapeHtml(formatAgo(check.last_ts))} · ${escapeHtml(detail)}</p>
      </article>`;
  }

  function renderComponentPills(components) {
    if (!components || typeof components !== "object") return "";
    return Object.entries(components).map(([name, info]) => {
      const present = info && info.present;
      const value = present ? formatGb(asNumber(info.bytes, 0) / 1073741824) : "fehlt";
      return `<span class="meta-pill">${escapeHtml(name)}: <strong>${escapeHtml(value)}</strong></span>`;
    }).join("");
  }

  function setPageMeta(title, eyebrow) {
    document.title = `${title} · Backup Control`;
    dom.breadcrumb.innerHTML = `
      <a class="breadcrumb-home" href="#/overview" aria-label="Zur Übersicht">${icon("home")}</a>
      ${icon("chevronRight", "breadcrumb-sep")}
      <span class="breadcrumb-section">${escapeHtml(eyebrow)}</span>
      ${icon("chevronRight", "breadcrumb-sep")}
      <span class="breadcrumb-current" aria-current="page">${escapeHtml(title)}</span>`;
  }

  function initializeTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    const preferred = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    applyTheme(stored === "light" || stored === "dark" ? stored : preferred);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f3f6fb" : "#080c16";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    if (state.route.name === "overview" || state.route.name === "server") renderCurrentView();
  }

  async function parseErrorResponse(response) {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        return payload.detail || payload.message || `HTTP ${response.status}`;
      }
      return (await response.text()).trim() || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  let sessionExpiryHandled = false;

  function handleSessionExpired() {
    if (sessionExpiryHandled) return;
    sessionExpiryHandled = true;
    state.currentUser = null;
    state.updatePolling = false;
    state.authView = { kind: "login", error: "Sitzung abgelaufen — bitte erneut anmelden." };
    showAuthScreen();
    renderAuthView();
    window.setTimeout(() => { sessionExpiryHandled = false; }, 2000);
  }

  async function api(path, options = {}) {
    const {
      responseType = "json",
      timeout = REQUEST_TIMEOUT_MS,
      headers: suppliedHeaders = {},
      ...fetchOptions
    } = options;

    const headers = new Headers(suppliedHeaders);
    if (fetchOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await fetch(path, {
        ...fetchOptions,
        headers,
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("Die Anfrage hat zu lange gedauert.");
      throw new ApiError("Collector nicht erreichbar.");
    } finally {
      window.clearTimeout(timer);
    }

    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      handleSessionExpired();
    }

    if (!response.ok) throw new ApiError(await parseErrorResponse(response), response.status);
    if (response.status === 204) return null;
    return responseType === "text" ? response.text() : response.json();
  }

  function showToast(title, message = "", type = "info", duration = 5_000) {
    const toast = document.createElement("div");
    toast.className = `toast is-${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.innerHTML = `
      <div>
        <strong>${escapeHtml(title)}</strong>
        ${message ? `<p>${escapeHtml(message)}</p>` : ""}
      </div>
      <button type="button" data-action="dismiss-toast" aria-label="Hinweis schließen">${icon("x")}</button>`;
    dom.toastRegion.append(toast);

    if (duration > 0) {
      window.setTimeout(() => toast.remove(), duration);
    }
  }

  function confirmAction({
    eyebrow = "Aktion bestätigen",
    title = "Sind Sie sicher?",
    message = "",
    confirmLabel = "Bestätigen",
    danger = false,
  }) {
    dom.confirmEyebrow.textContent = eyebrow;
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmSubmit.textContent = confirmLabel;
    dom.confirmSubmit.className = `button ${danger ? "button-danger" : "button-primary"}`;
    dom.confirmDialog.showModal();

    return new Promise((resolve) => {
      dom.confirmDialog.addEventListener("close", () => {
        resolve(dom.confirmDialog.returnValue === "confirm");
      }, { once: true });
    });
  }

  // ── WebAuthn (passkey) browser helpers ──────────────────────────────────
  const webauthnSupported = () => typeof window.PublicKeyCredential !== "undefined";

  function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlToBuffer(base64url) {
    const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }

  function creationOptionsFromServer(options) {
    return {
      ...options,
      challenge: base64urlToBuffer(options.challenge),
      user: { ...options.user, id: base64urlToBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
    };
  }

  function requestOptionsFromServer(options) {
    return {
      ...options,
      challenge: base64urlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
    };
  }

  function registrationCredentialToJSON(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : [],
      },
    };
  }

  function authenticationCredentialToJSON(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        authenticatorData: bufferToBase64url(credential.response.authenticatorData),
        signature: bufferToBase64url(credential.response.signature),
        userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : undefined,
      },
    };
  }

  function describeWebauthnError(error) {
    if (error && error.name === "NotAllowedError") {
      return "Vorgang abgebrochen oder Zeit abgelaufen.";
    }
    return error?.message || "Passkey-Vorgang fehlgeschlagen.";
  }

  // ── Auth screen: setup / login / MFA ────────────────────────────────────
  function showAuthScreen() {
    dom.appShell.hidden = true;
    dom.authScreen.hidden = false;
  }

  function showAppShell() {
    dom.authScreen.hidden = true;
    dom.appShell.hidden = false;
  }

  async function checkAuthStatus() {
    try {
      const status = await api("/api/auth/status");
      state.webauthn = status.webauthn || { secure_context: false, available: false };
      if (status.needs_setup) {
        state.currentUser = null;
        state.authView = { kind: "setup" };
      } else if (!status.authenticated) {
        state.currentUser = null;
        state.authView = { kind: "login" };
      } else {
        state.currentUser = status.user;
        state.authView = null;
      }
    } catch {
      state.currentUser = null;
      state.authView = { kind: "login", error: "Collector nicht erreichbar." };
    }
  }

  async function completeLogin(user) {
    state.currentUser = user;
    state.authView = null;
    showAppShell();
    renderNavigation();
    updateConnectionState();
    await refreshData({ render: true });
    renderCurrentView();
    showToast("Angemeldet", `Willkommen, ${user.username}.`, "success");
  }

  function renderAuthView() {
    const view = state.authView || { kind: "login" };
    document.title = "Anmelden · Backup Control";
    if (view.kind === "setup") return renderSetupScreen();
    if (view.kind === "mfa") return renderMfaScreen(view);
    return renderLoginScreen(view);
  }

  function renderSetupScreen() {
    dom.authContent.innerHTML = `
      <p class="eyebrow">Erstinstallation</p>
      <h1>Administrator-Konto anlegen</h1>
      <p class="auth-lead">Richten Sie das erste Konto ein, um Backup Control zu verwenden.</p>
      <form id="setup-form" class="auth-form" novalidate>
        <label class="field">
          <span>Benutzername</span>
          <input name="username" required minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]{3,64}" autocomplete="username" autofocus>
        </label>
        <label class="field">
          <span>Passwort</span>
          <input name="password" type="password" required minlength="10" autocomplete="new-password">
          <small class="field-hint">Mindestens 10 Zeichen.</small>
        </label>
        <label class="field">
          <span>Passwort bestätigen</span>
          <input name="password_confirm" type="password" required minlength="10" autocomplete="new-password">
        </label>
        <p class="form-error" id="auth-form-error" role="alert"></p>
        <button class="button button-primary auth-submit" type="submit">Administrator anlegen</button>
      </form>`;
  }

  function renderLoginScreen(view) {
    const showPasskey = state.webauthn.available && webauthnSupported();
    dom.authContent.innerHTML = `
      <p class="eyebrow">Anmeldung</p>
      <h1>Willkommen zurück</h1>
      ${view.error ? `<div class="banner is-warning" role="alert"><span class="banner-icon" aria-hidden="true">${icon("alertTriangle")}</span><span>${escapeHtml(view.error)}</span></div>` : ""}
      <form id="login-form" class="auth-form" novalidate>
        <label class="field">
          <span>Benutzername</span>
          <input name="username" required autocomplete="username" autofocus>
        </label>
        <label class="field">
          <span>Passwort</span>
          <input name="password" type="password" required autocomplete="current-password">
        </label>
        <p class="form-error" id="auth-form-error" role="alert"></p>
        <button class="button button-primary auth-submit" type="submit">Anmelden</button>
      </form>
      ${showPasskey ? `
        <div class="auth-divider"><span>oder</span></div>
        <button class="button button-secondary auth-submit" type="button" data-action="login-with-passkey">
          ${icon("key")}<span>Mit Passkey anmelden</span>
        </button>` : ""}`;
  }

  function renderMfaScreen(view) {
    const showTotp = view.methods.includes("totp");
    const showPasskey = view.methods.includes("webauthn") && state.webauthn.available && webauthnSupported();
    dom.authContent.innerHTML = `
      <p class="eyebrow">Zwei-Faktor-Bestätigung</p>
      <h1>Fast geschafft</h1>
      <p class="auth-lead">Angemeldet als <strong>${escapeHtml(view.username || "")}</strong></p>
      ${view.error ? `<div class="banner is-warning" role="alert"><span class="banner-icon" aria-hidden="true">${icon("alertTriangle")}</span><span>${escapeHtml(view.error)}</span></div>` : ""}
      ${showTotp ? `
        <form id="totp-login-form" class="auth-form" novalidate>
          <label class="field">
            <span>Code aus der Authenticator-App</span>
            <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required autofocus>
          </label>
          <p class="form-error" id="auth-form-error" role="alert"></p>
          <button class="button button-primary auth-submit" type="submit">Bestätigen</button>
        </form>` : ""}
      ${showPasskey ? `
        ${showTotp ? '<div class="auth-divider"><span>oder</span></div>' : ""}
        <button class="button button-secondary auth-submit" type="button" data-action="login-with-passkey-mfa">
          ${icon("key")}<span>Mit Passkey bestätigen</span>
        </button>` : ""}
      <button class="button button-secondary auth-submit" type="button" data-action="back-to-login">
        ${icon("chevronLeft")}<span>Zurück zur Anmeldung</span>
      </button>`;
  }

  async function submitSetupForm(form) {
    const errorElement = document.querySelector("#auth-form-error");
    const submit = form.querySelector(".auth-submit");
    const data = new FormData(form);
    const username = String(data.get("username") || "").trim();
    const password = String(data.get("password") || "");
    const confirmPassword = String(data.get("password_confirm") || "");
    errorElement.textContent = "";
    if (password !== confirmPassword) {
      errorElement.textContent = "Die Passwörter stimmen nicht überein.";
      return;
    }
    submit.disabled = true;
    try {
      const result = await api("/api/auth/setup", { method: "POST", body: JSON.stringify({ username, password }) });
      await completeLogin(result.user);
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function submitLoginForm(form) {
    const errorElement = document.querySelector("#auth-form-error");
    const submit = form.querySelector(".auth-submit");
    const data = new FormData(form);
    const username = String(data.get("username") || "").trim();
    const password = String(data.get("password") || "");
    errorElement.textContent = "";
    submit.disabled = true;
    try {
      const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      if (result.mfa_required) {
        state.authView = { kind: "mfa", loginToken: result.login_token, methods: result.methods, username };
        renderAuthView();
        return;
      }
      await completeLogin(result.user);
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function submitTotpLoginForm(form) {
    const view = state.authView;
    const errorElement = document.querySelector("#auth-form-error");
    const submit = form.querySelector(".auth-submit");
    const data = new FormData(form);
    const code = String(data.get("code") || "").trim();
    errorElement.textContent = "";
    submit.disabled = true;
    try {
      const result = await api("/api/auth/login/totp", {
        method: "POST",
        body: JSON.stringify({ login_token: view.loginToken, code }),
      });
      await completeLogin(result.user);
    } catch (error) {
      errorElement.textContent = error.message;
      submit.disabled = false;
    }
  }

  async function loginWithPasskeyDirect() {
    const usernameField = document.querySelector('#login-form input[name="username"]');
    const username = usernameField ? usernameField.value.trim() : "";
    const errorElement = document.querySelector("#auth-form-error");
    try {
      const optionsResponse = await api("/api/auth/login/webauthn/options", {
        method: "POST",
        body: JSON.stringify({ username: username || undefined }),
      });
      const credential = await navigator.credentials.get({
        publicKey: requestOptionsFromServer(optionsResponse.options),
      });
      const result = await api("/api/auth/login/webauthn/verify", {
        method: "POST",
        body: JSON.stringify({
          state_token: optionsResponse.state_token,
          credential: authenticationCredentialToJSON(credential),
        }),
      });
      await completeLogin(result.user);
    } catch (error) {
      if (errorElement) errorElement.textContent = describeWebauthnError(error);
    }
  }

  async function loginWithPasskeyStepUp() {
    const view = state.authView;
    const errorElement = document.querySelector("#auth-form-error");
    try {
      const optionsResponse = await api("/api/auth/login/webauthn/options", {
        method: "POST",
        body: JSON.stringify({ login_token: view.loginToken }),
      });
      const credential = await navigator.credentials.get({
        publicKey: requestOptionsFromServer(optionsResponse.options),
      });
      const result = await api("/api/auth/login/webauthn/verify", {
        method: "POST",
        body: JSON.stringify({
          state_token: optionsResponse.state_token,
          login_token: view.loginToken,
          credential: authenticationCredentialToJSON(credential),
        }),
      });
      await completeLogin(result.user);
    } catch (error) {
      view.error = describeWebauthnError(error);
      renderAuthView();
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore network errors here — we clear local state regardless.
    }
    state.currentUser = null;
    state.updatePolling = false;
    state.authView = { kind: "login" };
    showAuthScreen();
    renderAuthView();
    showToast("Abgemeldet", "Sie wurden erfolgreich abgemeldet.", "success");
  }

  function parseRoute() {
    const raw = (window.location.hash || "#/overview").replace(/^#\//, "");
    const [name, ...parts] = raw.split("/");
    if (name === "server" && parts.length) {
      return { name: "server", server: decodeData(parts.join("/")) };
    }
    if (["overview", "peers", "settings", "account", "users"].includes(name)) return { name };
    return { name: "overview" };
  }

  function closeMobileMenu() {
    document.body.classList.remove("menu-open");
    document.querySelector(".menu-button").setAttribute("aria-expanded", "false");
  }

  function renderNavigation() {
    const activeName = state.route.name;
    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === activeName) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    dom.navUsers.classList.toggle("is-hidden", !state.currentUser?.is_admin);

    if (state.currentUser) {
      dom.accountUsername.textContent = state.currentUser.username;
      dom.accountAvatar.textContent = initials(state.currentUser.username).toUpperCase();
    }

    dom.serverCount.textContent = String(state.servers.length);
    dom.serverNav.innerHTML = state.servers.map((server) => {
      const info = statusInfo(server.state);
      const active = activeName === "server" && state.route.server === server.server;
      return `
        <a class="server-nav-item" href="#/server/${encodeURIComponent(server.server)}"
           ${active ? 'aria-current="page"' : ""} title="${escapeHtml(server.server)}">
          <span class="state-dot ${info.className}" aria-hidden="true"></span>
          <span class="server-nav-name">${escapeHtml(shortHost(server.server))}</span>
        </a>`;
    }).join("");
  }

  function updateConnectionState() {
    dom.syncLabel.textContent = state.lastSync
      ? `Synchronisiert ${state.lastSync.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
      : "Noch nicht synchronisiert";
    dom.footerSummary.textContent = state.online
      ? `${state.servers.length} Server · ${formatGb(state.summary.repo_total_gb)} belegt`
      : "Collector nicht erreichbar";
  }

  function setRefreshBusy(busy) {
    document.querySelectorAll('[data-action="refresh"]').forEach((button) => {
      button.disabled = busy;
      button.classList.toggle("is-loading", busy);
    });
  }

  async function refreshData({ manual = false, render = true } = {}) {
    if (state.refreshPromise) return state.refreshPromise;

    setRefreshBusy(true);
    state.refreshPromise = (async () => {
      try {
        const [servers, summary] = await Promise.all([
          api("/api/servers"),
          api("/api/summary"),
        ]);
        if (!Array.isArray(servers) || !summary || typeof summary !== "object") {
          throw new ApiError("Collector hat ein ungültiges Datenformat geliefert.");
        }

        state.servers = servers;
        state.summary = { ...state.summary, ...summary };
        state.online = true;
        state.initialized = true;
        state.lastSync = new Date();
        renderNavigation();
        updateConnectionState();

        if (render && ["overview", "server"].includes(state.route.name)) renderCurrentView();
        if (manual) showToast("Daten aktualisiert", "Der aktuelle Fleet-Status wurde geladen.", "success");
      } catch (error) {
        state.online = false;
        updateConnectionState();
        if (!state.initialized || !state.servers.length) {
          renderFatalError(error.message);
        } else if (manual) {
          showToast("Aktualisierung fehlgeschlagen", error.message, "error");
        }
      } finally {
        state.refreshPromise = null;
        setRefreshBusy(false);
      }
    })();

    return state.refreshPromise;
  }

  function renderFatalError(message) {
    setPageMeta("Verbindung unterbrochen", "Systemstatus");
    destroyCharts();
    dom.main.innerHTML = `
      <div class="error-state">
        <div>
          <span class="error-state-icon" aria-hidden="true">${icon("alertTriangle")}</span>
          <h1>Collector nicht erreichbar</h1>
          <p>${escapeHtml(message)}</p>
          <button class="button button-primary" type="button" data-action="refresh">Erneut versuchen</button>
        </div>
      </div>`;
  }

  function destroyCharts() {
    state.charts.forEach((chart) => {
      try {
        chart.destroy();
      } catch {
        // A removed canvas is harmless during navigation.
      }
    });
    state.charts = [];
  }

  function chartColor(token) {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  }

  function registerChart(canvas, config) {
    if (!canvas) return;
    if (!window.Chart) {
      const container = canvas.closest(".chart-container");
      if (container) {
        container.innerHTML = '<div class="chart-fallback">Diagramm-Modul nicht verfügbar.<br>Die Messwerte bleiben in der Tabelle sichtbar.</div>';
      }
      return;
    }
    state.charts.push(new window.Chart(canvas, config));
  }

  function renderCurrentView() {
    state.viewNonce += 1;
    destroyCharts();
    renderNavigation();
    closeMobileMenu();

    if (state.route.name === "users" && !state.currentUser?.is_admin) {
      showToast("Kein Zugriff", "Diese Ansicht ist nur für Administratoren.", "error");
      window.location.hash = "#/overview";
      return;
    }

    switch (state.route.name) {
      case "peers":
        renderPeers(state.viewNonce);
        break;
      case "settings":
        renderSettings(state.viewNonce);
        break;
      case "account":
        renderAccount(state.viewNonce);
        break;
      case "users":
        renderUsers(state.viewNonce);
        break;
      case "server":
        renderServerDetail(state.route.server);
        break;
      default:
        renderOverview();
    }
  }

  function metricCard(label, value, detail, tone = "", valueTone = "", extra = "") {
    return `
      <article class="metric-card ${tone}">
        <div class="metric-label">${escapeHtml(label)}</div>
        <p class="metric-value ${valueTone}">${escapeHtml(value)}</p>
        <p class="metric-detail">${escapeHtml(detail)}</p>
        ${extra}
      </article>`;
  }

  function proportionalCells(counts, segments) {
    const total = counts.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return counts.map(() => 0);
    const raw = counts.map((value) => (value / total) * segments);
    const base = raw.map(Math.floor);
    const remainder = segments - base.reduce((sum, value) => sum + value, 0);
    const order = raw
      .map((value, index) => ({ index, frac: value - Math.floor(value) }))
      .sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < remainder; i += 1) base[order[i % order.length].index] += 1;
    return base;
  }

  function renderHealthBar(summary) {
    const segments = 24;
    const total = asNumber(summary.servers);
    const ok = asNumber(summary.ok);
    const error = asNumber(summary.error);
    const stale = asNumber(summary.stale);
    const cellClasses = total > 0
      ? (() => {
          const [okCells, errorCells, staleCells] = proportionalCells([ok, error, stale], segments);
          return [
            ...Array(okCells).fill("is-ok"),
            ...Array(errorCells).fill("is-error"),
            ...Array(staleCells).fill("is-stale"),
          ];
        })()
      : [];
    while (cellClasses.length < segments) cellClasses.push("is-empty");
    const label = total > 0 ? `${ok} von ${total} Servern gesund` : "Keine Server verbunden";
    return `
      <div class="health-bar" role="img" aria-label="${escapeHtml(label)}">
        ${cellClasses.slice(0, segments).map((cls) => `<span class="health-cell ${cls}"></span>`).join("")}
      </div>
      <div class="health-bar-legend">
        <span class="health-legend-item"><i class="health-dot is-ok"></i>${ok} gesund</span>
        <span class="health-legend-item"><i class="health-dot is-error"></i>${error} Fehler</span>
        <span class="health-legend-item"><i class="health-dot is-stale"></i>${stale} überfällig</span>
      </div>`;
  }

  function renderOverview() {
    setPageMeta("Übersicht", "Monitoring");
    const summary = state.summary;
    const fleetStatus = asNumber(summary.error) > 0
      ? { value: "Fehler", detail: `${summary.error} Server mit Fehler`, tone: "is-danger", valueTone: "is-danger" }
      : asNumber(summary.stale) > 0
        ? { value: "Prüfen", detail: `${summary.stale} Server überfällig`, tone: "is-warning", valueTone: "is-warning" }
        : { value: "Gesund", detail: `${summary.ok}/${summary.servers} Server gesund`, tone: "is-success", valueTone: "is-success" };

    dom.main.innerHTML = `
      <section class="page-heading">
        <div>
          <h1>Fleet Operations</h1>
          <p>Backup-Zustand, Kapazität und Laufzeiten Ihrer Mailcow-Infrastruktur auf einen Blick.</p>
        </div>
        <div class="page-heading-actions">
          <a class="button button-secondary" href="#/peers">Peer verwalten</a>
        </div>
      </section>

      ${!state.online ? `
        <div class="banner is-warning" role="alert">
          <span class="banner-icon" aria-hidden="true">${icon("alertTriangle")}</span>
          <span><strong>Live-Verbindung unterbrochen</strong><small>Es werden die zuletzt geladenen Daten angezeigt.</small></span>
        </div>` : ""}

      <section class="metrics" aria-label="Fleet-Kennzahlen">
        ${metricCard("Fleet-Status", fleetStatus.value, fleetStatus.detail, `${fleetStatus.tone} metric-card-wide`, fleetStatus.valueTone, renderHealthBar(summary))}
        ${metricCard("Server", String(asNumber(summary.servers)), "Aktiv angebunden")}
        ${metricCard("Speicher", formatGb(summary.repo_total_gb), "Alle Borg-Repositories")}
        ${metricCard("Läufe · 24 h", String(asNumber(summary.runs_24h)), "Empfangene Reports")}
        ${metricCard("Fehler · 7 Tage", String(asNumber(summary.fails_7d)), "Fehlgeschlagene Läufe", asNumber(summary.fails_7d) ? "is-danger" : "", asNumber(summary.fails_7d) ? "is-danger" : "")}
        ${metricCard("Verify · 30 Tage", String(asNumber(summary.verify_fails_30d)), "Fehlgeschlagene Restore-Tests", asNumber(summary.verify_fails_30d) ? "is-warning" : "", asNumber(summary.verify_fails_30d) ? "is-warning" : "")}
        ${metricCard("Watchdog · 24 Std.", String(asNumber(summary.watchdog_fails_24h)), "Health-Check-Warnungen", asNumber(summary.watchdog_fails_24h) ? "is-warning" : "", asNumber(summary.watchdog_fails_24h) ? "is-warning" : "")}
      </section>

      <section class="panel" aria-labelledby="fleet-title">
        <div class="panel-header">
          <div class="panel-title">
            <h3 id="fleet-title">Server-Fleet</h3>
            <p>Status und aktuelle Backup-Metriken</p>
          </div>
        </div>
        <div class="fleet-toolbar">
          <label class="search-field">
            ${icon("search")}
            <span class="sr-only">Server suchen</span>
            <input id="fleet-search" type="search" placeholder="Server suchen …" value="${escapeHtml(state.search)}" autocomplete="off">
          </label>
          <div class="chip-group" aria-label="Nach Status filtern">
            ${[
              ["all", "Alle"],
              ["ok", "Gesund"],
              ["error", "Fehler"],
              ["stale", "Überfällig"],
            ].map(([value, label]) => `
              <button class="chip" type="button" data-action="filter-status" data-status="${value}"
                      aria-pressed="${state.statusFilter === value}">${label}</button>`).join("")}
          </div>
          <span class="result-count" id="result-count"></span>
        </div>
        <div id="fleet-results"></div>
      </section>`;

    renderFleetResults();
  }

  function filteredServers() {
    const query = state.search.trim().toLocaleLowerCase("de");
    return state.servers.filter((server) => {
      const matchesStatus = state.statusFilter === "all" || server.state === state.statusFilter;
      const matchesSearch = !query || String(server.server || "").toLocaleLowerCase("de").includes(query);
      return matchesStatus && matchesSearch;
    });
  }

  function renderFleetResults() {
    const container = document.querySelector("#fleet-results");
    if (!container) return;
    destroyCharts();

    const servers = filteredServers();
    const resultCount = document.querySelector("#result-count");
    if (resultCount) resultCount.textContent = `${servers.length} von ${state.servers.length}`;

    if (!state.servers.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div>
            <span class="empty-state-icon" aria-hidden="true">${icon("server")}</span>
            <h3>Noch keine Server angebunden</h3>
            <p>Richten Sie den ersten Mailcow-Server als Peer ein. Nach dem ersten Report erscheint er automatisch hier.</p>
            <a class="button button-primary" href="#/peers">Ersten Peer einrichten</a>
          </div>
        </div>`;
      return;
    }

    if (!servers.length) {
      container.innerHTML = `
        <div class="empty-state empty-state-compact">
          <div>
            <span class="empty-state-icon" aria-hidden="true">${icon("search")}</span>
            <h3>Keine Treffer</h3>
            <p>Passen Sie Suche oder Statusfilter an.</p>
          </div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Server</th>
              <th>Letzter Lauf</th>
              <th>Dauer</th>
              <th class="hide-mobile">Backup</th>
              <th>Repository</th>
              <th class="hide-mobile">Stände</th>
              <th class="hide-mobile">Trend</th>
              <th><span class="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            ${servers.map((server, index) => {
              const latest = server.last || {};
              const info = statusInfo(server.state);
              return `
                <tr>
                  <td><span class="status-badge ${info.className}">${info.label}</span></td>
                  <td>
                    <div class="server-cell">
                      <span class="server-avatar" aria-hidden="true">${escapeHtml(initials(server.server))}</span>
                      <span>
                        <a class="server-link" href="#/server/${encodeURIComponent(server.server)}">${escapeHtml(shortHost(server.server))}</a>
                        <small class="server-host">${escapeHtml(server.server)}</small>
                      </span>
                    </div>
                  </td>
                  <td class="mono">${escapeHtml(formatDateTime(latest.ts))}<small class="secondary-line">${escapeHtml(formatAgo(latest.ts))}</small></td>
                  <td class="mono">${escapeHtml(formatDuration(latest.duration_s))}</td>
                  <td class="mono hide-mobile">${escapeHtml(formatGb(latest.backup_gb))}</td>
                  <td class="mono">${escapeHtml(formatGb(latest.repo_gb))}</td>
                  <td class="mono hide-mobile">${latest.archives ?? "–"}</td>
                  <td class="hide-mobile"><canvas class="sparkline" id="spark-${index}" width="110" height="30" aria-label="Repository-Trend"></canvas></td>
                  <td><a class="row-action" href="#/server/${encodeURIComponent(server.server)}" aria-label="${escapeHtml(server.server)} öffnen">${icon("chevronRight")}</a></td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;

    if (!window.Chart) return;
    servers.forEach((server, index) => {
      const canvas = document.querySelector(`#spark-${index}`);
      const history = Array.isArray(server.history) ? server.history : [];
      registerChart(canvas, {
        type: "line",
        data: {
          labels: history.map((entry) => entry.ts),
          datasets: [{
            data: history.map((entry) => entry.repo_gb),
            borderColor: chartColor("--primary"),
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.32,
          }],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    });
  }

  function renderServerDetail(serverName) {
    const server = state.servers.find((entry) => entry.server === serverName);
    if (!server) {
      setPageMeta("Server nicht gefunden", "Monitoring");
      dom.main.innerHTML = `
        <div class="error-state">
          <div>
            <span class="error-state-icon" aria-hidden="true">${icon("helpCircle")}</span>
            <h1>Server nicht gefunden</h1>
            <p>Der Server ist nicht mehr in der aktuellen Fleet-Liste enthalten.</p>
            <a class="button button-primary" href="#/overview">Zur Übersicht</a>
          </div>
        </div>`;
      return;
    }

    setPageMeta(shortHost(server.server), "Server-Details");
    const latest = server.last || {};
    const info = statusInfo(server.state);
    const history = Array.isArray(server.history) ? server.history : [];
    const errors = Array.isArray(server.recent_errors) ? server.recent_errors : [];

    dom.main.innerHTML = `
      <section class="page-heading">
        <div>
          <h1>${escapeHtml(server.server)}</h1>
          <p>Backup-Verlauf und Betriebsmetriken dieses Mailcow-Servers.</p>
        </div>
        <div class="page-heading-actions">
          <a class="button button-secondary" href="#/overview">${icon("chevronLeft")}<span>Zur Übersicht</span></a>
        </div>
      </section>

      ${server.state !== "ok" ? `
        <div class="banner ${server.state === "error" ? "is-danger" : "is-warning"}" role="alert">
          <span class="banner-icon" aria-hidden="true">${icon("alertTriangle")}</span>
          <span>
            <strong>${server.state === "error" ? "Letzter Backup-Lauf fehlgeschlagen" : "Kein aktueller Backup-Report"}</strong>
            <small>${server.state === "error" ? "Prüfen Sie Fehlerhistorie und Agent-Log." : `Letzter Report ${formatAgo(latest.ts)}.`}</small>
          </span>
        </div>` : ""}

      <section class="metrics" aria-label="Server-Kennzahlen">
        ${metricCard("Status", info.label, formatAgo(latest.ts), server.state === "ok" ? "is-success" : server.state === "stale" ? "is-warning" : "is-danger", server.state === "ok" ? "is-success" : server.state === "stale" ? "is-warning" : "is-danger")}
        ${metricCard("Backup-Größe", formatGb(latest.backup_gb), "Letzter Stand")}
        ${metricCard("Repository", formatGb(latest.repo_gb), "Dedupliziert und verschlüsselt")}
        ${metricCard("Laufzeit", formatDuration(latest.duration_s), "Letzter Lauf")}
        ${metricCard("Aufbewahrung", String(latest.archives ?? "–"), "Archiv-Stände")}
      </section>

      <div class="detail-meta">
        <span class="meta-pill">Letzter Report: <strong>${escapeHtml(formatDateTime(latest.ts))}</strong></span>
        <span class="meta-pill">Historie: <strong>${history.length} Läufe</strong></span>
        ${renderComponentPills(latest.components)}
      </div>

      <section class="detail-grid" aria-label="Verlaufsdiagramme">
        <article class="panel">
          <div class="panel-header">
            <div class="panel-title"><h3>Speicherverlauf</h3><p>Backup und Repository in GB</p></div>
          </div>
          <div class="chart-container"><canvas id="storage-chart" aria-label="Speicherverlauf"></canvas></div>
        </article>
        <article class="panel">
          <div class="panel-header">
            <div class="panel-title"><h3>Laufzeit</h3><p>Dauer pro Backup-Lauf</p></div>
          </div>
          <div class="chart-container"><canvas id="duration-chart" aria-label="Laufzeitverlauf"></canvas></div>
        </article>
      </section>

      <section class="panel" aria-labelledby="runs-title">
        <div class="panel-header">
          <div class="panel-title"><h3 id="runs-title">Letzte Läufe</h3><p>Die 15 jüngsten Reports</p></div>
        </div>
        ${renderRunsTable(history)}
      </section>

      <section class="panel" aria-labelledby="errors-title">
        <div class="panel-header">
          <div class="panel-title"><h3 id="errors-title">Fehlerhistorie</h3><p>Die letzten zehn Fehler</p></div>
        </div>
        ${errors.length ? `
          <ul class="error-list">
            ${errors.map((error) => `
              <li class="error-item">
                <time class="error-time" datetime="${escapeHtml(new Date(asNumber(error.ts) * 1000).toISOString())}">${escapeHtml(formatDateTime(error.ts))}</time>
                <span class="error-message">${escapeHtml(error.message || "Unbekannter Fehler")}</span>
              </li>`).join("")}
          </ul>` : `
          <div class="empty-state empty-state-compact">
            <div><span class="empty-state-icon" aria-hidden="true">${icon("checkCircle")}</span><h3>Keine Fehler aufgezeichnet</h3><p>Für diesen Server liegen keine Fehlermeldungen vor.</p></div>
          </div>`}
      </section>

      <section class="panel" aria-labelledby="checks-title">
        <div class="panel-header">
          <div class="panel-title"><h3 id="checks-title">Zusätzliche Prüfungen</h3><p>Verify- und Watchdog-Agent der Suite</p></div>
        </div>
        <div class="checks-grid">
          ${renderCheckCard("Verify-Agent (Restore-Test)", server.verify)}
          ${renderCheckCard("Watchdog-Agent (Health-Check)", server.watchdog)}
        </div>
      </section>`;

    renderDetailCharts(history);
  }

  function renderRunsTable(history) {
    const entries = [...history].reverse().slice(0, 15);
    if (!entries.length) {
      return '<div class="empty-state empty-state-compact"><div><h3>Keine Verlaufsdaten</h3><p>Nach weiteren Läufen wird hier die Historie angezeigt.</p></div></div>';
    }
    return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Zeitpunkt</th><th>Status</th><th>Dauer</th><th>Backup</th><th>Repository</th><th>Stände</th></tr></thead>
          <tbody>
            ${entries.map((entry) => {
              const runStatus = entry.status === "ok" ? STATUS.ok : STATUS.error;
              return `
                <tr>
                  <td class="mono">${escapeHtml(formatDateTime(entry.ts))}</td>
                  <td><span class="status-badge ${runStatus.className}">${runStatus.label}</span></td>
                  <td class="mono">${escapeHtml(formatDuration(entry.duration_s))}</td>
                  <td class="mono">${escapeHtml(formatGb(entry.backup_gb))}</td>
                  <td class="mono">${escapeHtml(formatGb(entry.repo_gb))}</td>
                  <td class="mono">${entry.archives ?? "–"}</td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderDetailCharts(history) {
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: {
            color: chartColor("--muted"),
            boxWidth: 10,
            font: { size: 10 },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: chartColor("--muted"), font: { size: 9 } },
          grid: { color: chartColor("--border") },
        },
        y: {
          ticks: { color: chartColor("--muted"), font: { size: 9 } },
          grid: { color: chartColor("--border") },
        },
      },
    };

    const labels = history.map((entry) => formatDate(entry.ts));
    registerChart(document.querySelector("#storage-chart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Backup GB",
            data: history.map((entry) => entry.backup_gb),
            borderColor: chartColor("--primary"),
            backgroundColor: `${chartColor("--primary")}1c`,
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: "Repository GB",
            data: history.map((entry) => entry.repo_gb),
            borderColor: chartColor("--success"),
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      },
      options: commonOptions,
    });

    registerChart(document.querySelector("#duration-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Minuten",
          data: history.map((entry) => entry.duration_s === null ? null : Number((asNumber(entry.duration_s) / 60).toFixed(1))),
          backgroundColor: history.map((entry) => entry.status === "ok" ? `${chartColor("--primary")}aa` : `${chartColor("--danger")}cc`),
          borderRadius: 4,
        }],
      },
      options: commonOptions,
    });
  }

  function renderViewLoading(title, eyebrow) {
    setPageMeta(title, eyebrow);
    dom.main.innerHTML = '<div class="page-loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Daten werden geladen …</span></div>';
  }

  // ── Peers ────────────────────────────────────────────────────────────────
  async function renderPeers(nonce) {
    renderViewLoading("Peers", "Verwaltung");
    try {
      const peers = await api("/api/peers");
      if (nonce !== state.viewNonce || state.route.name !== "peers") return;
      renderPeersPage(Array.isArray(peers) ? peers : []);
    } catch (error) {
      if (nonce !== state.viewNonce) return;
      renderSectionError("Peer-Verwaltung nicht verfügbar", error.message, "peers");
    }
  }

  function renderPeersPage(peers) {
    setPageMeta("Peers", "Verwaltung");
    dom.main.innerHTML = `
      <section class="page-heading">
        <div>
          <h1>Server-Onboarding</h1>
          <p>Neue Mailcow-Systeme kontrolliert registrieren und bestehende Enrollment-Einträge verwalten.</p>
        </div>
      </section>

      <div class="admin-grid">
        <section class="panel" aria-labelledby="new-peer-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="new-peer-title">Neuen Peer anlegen</h3><p>Erzeugt einen Enrollment-Befehl</p></div>
          </div>
          <form class="form-panel" id="peer-form">
            <div class="form-grid">
              <label class="field">
                <span>Hostname</span>
                <input name="name" placeholder="mail2.example.de" maxlength="200" pattern="[A-Za-z0-9._-]+" required>
              </label>
              <label class="field">
                <span>Backup-Uhrzeit</span>
                <select name="hour">
                  ${Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${hour === 3 ? "selected" : ""}>${String(hour).padStart(2, "0")}:00 Uhr</option>`).join("")}
                </select>
              </label>
              <label class="field field-wide">
                <span>Borg-Ziel</span>
                <input name="borg_repo" placeholder="u123456@host:backups/mail2-borg" required>
                <small class="field-hint">SSH-Ziel im Borg-Format Benutzer@Host:Pfad</small>
              </label>
              <label class="field">
                <span>SSH-Port</span>
                <input name="borg_ssh_port" type="number" value="23" min="1" max="65535" required>
              </label>
              <label class="field">
                <span>Aufbewahrung</span>
                <input name="keep_daily" type="number" value="7" min="1" max="3650" required>
              </label>
              <label class="field">
                <span>Backup-Threads</span>
                <input name="threads" type="number" value="4" min="1" max="64" required>
              </label>
              <label class="field">
                <span>Mailcow-Verzeichnis</span>
                <input name="mailcow_dir" value="/opt/mailcow-dockerized" required>
              </label>
              <fieldset class="field-wide components-field">
                <legend>Backup-Komponenten</legend>
                <label class="check-field">
                  <input type="checkbox" id="component-all-toggle" name="component_all" checked>
                  <span>Alle Komponenten (empfohlen)</span>
                </label>
                <div class="components-grid" id="componentsGrid">
                  <label class="check-field"><input type="checkbox" name="component" value="vmail" disabled><span>vmail (Mailboxen)</span></label>
                  <label class="check-field"><input type="checkbox" name="component" value="crypt" disabled><span>crypt (SSL/DKIM)</span></label>
                  <label class="check-field"><input type="checkbox" name="component" value="redis" disabled><span>redis</span></label>
                  <label class="check-field"><input type="checkbox" name="component" value="rspamd" disabled><span>rspamd</span></label>
                  <label class="check-field"><input type="checkbox" name="component" value="postfix" disabled><span>postfix</span></label>
                  <label class="check-field"><input type="checkbox" name="component" value="mysql" disabled><span>mysql / MariaDB</span></label>
                </div>
              </fieldset>
            </div>
            <p class="form-error" id="peer-form-error" role="alert"></p>
            <div class="form-actions">
              <button class="button button-primary" type="submit">Peer anlegen</button>
            </div>
            <div id="enrollment-output"></div>
          </form>
        </section>

        <section class="panel" aria-labelledby="peer-list-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="peer-list-title">Registrierte Peers</h3><p><span id="peer-list-count">${peers.length}</span> Enrollment-Einträge</p></div>
          </div>
          <div id="peer-list">${renderPeerList(peers)}</div>
        </section>
      </div>`;

    const allToggle = document.querySelector("#component-all-toggle");
    const componentInputs = document.querySelectorAll('#componentsGrid input[name="component"]');
    allToggle.addEventListener("change", () => {
      componentInputs.forEach((input) => {
        input.disabled = allToggle.checked;
        if (allToggle.checked) input.checked = false;
      });
    });
  }

  function renderPeerList(peers) {
    if (!peers.length) {
      return `
        <div class="empty-state empty-state-compact">
          <div><span class="empty-state-icon" aria-hidden="true">${icon("plus")}</span><h3>Noch keine Peers</h3><p>Neue Enrollment-Einträge erscheinen hier.</p></div>
        </div>`;
    }
    return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Peer</th><th>Status</th><th class="hide-mobile">Ziel</th><th><span class="sr-only">Aktionen</span></th></tr></thead>
          <tbody>
            ${peers.map((peer) => `
              <tr>
                <td>
                  <span class="peer-name">${escapeHtml(peer.name)}</span>
                  <small class="secondary-line">${escapeHtml(formatDateTime(peer.created_ts))} · ${escapeHtml(peer.config?.backup_components || "all")}</small>
                </td>
                <td><span class="status-badge ${peer.enrolled_ts ? "is-ok" : "is-stale"}">${peer.enrolled_ts ? "Abgerufen" : "Ausstehend"}</span></td>
                <td class="mono repo-cell hide-mobile" title="${escapeHtml(peer.config?.borg_repo || "")}">${escapeHtml(peer.config?.borg_repo || "–")}</td>
                <td>
                  <div class="row-menu">
                    <button class="icon-button icon-button-ghost" type="button" data-action="toggle-menu"
                            aria-haspopup="true" aria-expanded="false" aria-label="Aktionen für ${escapeHtml(peer.name)}">
                      ${icon("more")}
                    </button>
                    <div class="row-menu-list" role="menu">
                      ${peer.enrolled_ts ? "" : `
                        <button class="row-menu-item" type="button" role="menuitem" data-action="show-enroll"
                                data-key="${encodeData(peer.enroll_key)}">${icon("terminal")}<span>Enrollment-Befehl</span></button>`}
                      <button class="row-menu-item is-danger" type="button" role="menuitem" data-action="delete-peer"
                              data-peer="${encodeData(peer.name)}">${icon("trash")}<span>Peer löschen</span></button>
                    </div>
                  </div>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function showEnrollment(command) {
    const container = document.querySelector("#enrollment-output");
    if (!container) return;
    container.innerHTML = `
      <div class="enrollment-box" role="status">
        <h4>Enrollment-Befehl bereit</h4>
        <p>Auf dem neuen Mailcow-Server als root ausführen. Der Schlüssel sollte vertraulich behandelt werden.</p>
        <div class="command-row">
          <code id="enrollment-command"></code>
          <button class="button button-secondary" type="button" data-action="copy-command">${icon("copy")}<span>Kopieren</span></button>
        </div>
      </div>`;
    document.querySelector("#enrollment-command").textContent = command;
  }

  async function refreshPeerList() {
    const peers = await api("/api/peers");
    const list = document.querySelector("#peer-list");
    const count = document.querySelector("#peer-list-count");
    if (list) list.innerHTML = renderPeerList(Array.isArray(peers) ? peers : []);
    if (count) count.textContent = String(Array.isArray(peers) ? peers.length : 0);
  }

  async function submitPeerForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const errorElement = document.querySelector("#peer-form-error");
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const componentAll = form.querySelector('input[name="component_all"]').checked;
    const selectedComponents = componentAll
      ? ["all"]
      : Array.from(form.querySelectorAll('input[name="component"]:checked')).map((el) => el.value);
    const body = {
      name: String(data.get("name") || "").trim(),
      borg_repo: String(data.get("borg_repo") || "").trim(),
      borg_ssh_port: Number(data.get("borg_ssh_port")),
      keep_daily: Number(data.get("keep_daily")),
      hour: Number(data.get("hour")),
      mailcow_dir: String(data.get("mailcow_dir") || "").trim(),
      threads: Number(data.get("threads")),
      backup_components: selectedComponents.length ? selectedComponents.join(",") : "all",
    };

    submit.disabled = true;
    errorElement.textContent = "";
    try {
      const result = await api("/api/peers", { method: "POST", body: JSON.stringify(body) });
      showEnrollment(result.command);
      await refreshPeerList();
      showToast("Peer angelegt", `${body.name} kann jetzt enrolled werden.`, "success");
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function deletePeer(name) {
    const confirmed = await confirmAction({
      eyebrow: "Peer-Verwaltung",
      title: `${name} löschen?`,
      message: "Der Enrollment-Eintrag wird entfernt. Server und vorhandene Backups bleiben unberührt.",
      confirmLabel: "Peer löschen",
      danger: true,
    });
    if (!confirmed) return;

    try {
      await api(`/api/peers/${encodeURIComponent(name)}`, { method: "DELETE" });
      await refreshPeerList();
      showToast("Peer gelöscht", `${name} wurde aus der Verwaltung entfernt.`, "success");
    } catch (error) {
      showToast("Peer konnte nicht gelöscht werden", error.message, "error");
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  async function renderSettings(nonce) {
    renderViewLoading("Einstellungen", "System");
    try {
      const version = await api("/api/settings/version", { timeout: 30_000 });
      if (nonce !== state.viewNonce || state.route.name !== "settings") return;
      renderSettingsPage(version);
      loadUpdateLog();
    } catch (error) {
      if (nonce !== state.viewNonce) return;
      renderSectionError("Systeminformationen nicht verfügbar", error.message, "settings");
    }
  }

  function renderSettingsPage(version) {
    setPageMeta("Einstellungen", "System");
    const updateAvailable = Boolean(version.update_available);
    const installed = version.installed || {};
    const latest = version.latest || {};

    dom.main.innerHTML = `
      <section class="page-heading">
        <div>
          <h1>System &amp; Updates</h1>
          <p>Softwarestand und Update-Protokoll des Dashboards.</p>
        </div>
        <div class="page-heading-actions">
          <button class="button button-secondary" type="button" data-action="refresh-settings">Erneut prüfen</button>
        </div>
      </section>

      <div class="settings-grid">
        <section class="panel" aria-labelledby="version-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="version-title">Software-Version</h3><p>Vergleich mit origin/main</p></div>
            <span class="status-badge ${updateAvailable ? "is-stale" : "is-ok"}">${updateAvailable ? "Update verfügbar" : "Aktuell"}</span>
          </div>
          <div class="version-stack">
            <article class="version-card">
              <div class="version-header"><span>Installiert</span><span>${escapeHtml(installed.date || "Datum unbekannt")}</span></div>
              <strong class="commit-id">${escapeHtml(installed.commit || "?")}</strong>
              <p class="commit-subject">${escapeHtml(installed.subject || "Keine Commit-Information")}</p>
            </article>
            <article class="version-card ${updateAvailable ? "is-update" : ""}">
              <div class="version-header"><span>Neueste Version</span><span>${escapeHtml(latest.date || "Datum unbekannt")}</span></div>
              <strong class="commit-id">${escapeHtml(latest.commit || "?")}</strong>
              <p class="commit-subject">${escapeHtml(latest.subject || "Keine Commit-Information")}</p>
            </article>
            <div class="update-actions">
              <button class="button button-primary" type="button" data-action="install-update"
                      data-installed="${encodeData(installed.commit || "")}" ${updateAvailable ? "" : "disabled"}>
                Update installieren
              </button>
              <span class="status-badge is-info">${asNumber(version.behind)} Commit(s) zurück</span>
            </div>
            <p class="update-message" id="update-message" aria-live="polite">${updateAvailable ? "Das Update startet den Dashboard-Dienst einmal neu." : "Der installierte Stand entspricht origin/main."}</p>
          </div>
        </section>

        <section class="panel" aria-labelledby="log-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="log-title">Update-Protokoll</h3><p>Die letzten 40 Logzeilen</p></div>
            <button class="button button-secondary button-small" type="button" data-action="refresh-log">Log laden</button>
          </div>
          <pre class="log-viewer" id="update-log">Log wird geladen …</pre>
        </section>

        <section class="panel" aria-labelledby="system-title">
          <div class="panel-header"><div class="panel-title"><h3 id="system-title">Systeminformationen</h3><p>Laufzeitkonfiguration</p></div></div>
          <dl class="info-list">
            <div class="info-row"><dt>Repository</dt><dd>${escapeHtml(version.repo_dir || "–")}</dd></div>
            <div class="info-row"><dt>Stale-Schwelle</dt><dd>${asNumber(version.stale_hours)} Stunden</dd></div>
            <div class="info-row"><dt>Agent-Updates</dt><dd>/agent/scripts/*</dd></div>
            <div class="info-row"><dt>Update-Verfahren</dt><dd>Fetch · Deploy · Restart · Rollback</dd></div>
          </dl>
        </section>
      </div>`;
  }

  async function loadUpdateLog() {
    const log = document.querySelector("#update-log");
    if (!log) return;
    try {
      log.textContent = await api("/api/settings/update-log", { responseType: "text" });
      log.scrollTop = log.scrollHeight;
    } catch (error) {
      log.textContent = `Log nicht verfügbar: ${error.message}`;
    }
  }

  async function installUpdate(previousCommit) {
    const confirmed = await confirmAction({
      eyebrow: "Systemupdate",
      title: "Update jetzt installieren?",
      message: "Der aktuelle Stand von origin/main wird deployt. Das Dashboard startet dabei kurz neu und führt bei einem Startfehler ein Rollback durch.",
      confirmLabel: "Update starten",
    });
    if (!confirmed) return;

    const button = document.querySelector('[data-action="install-update"]');
    const message = document.querySelector("#update-message");
    if (button) button.disabled = true;
    if (message) message.textContent = "Update wird gestartet …";

    try {
      const result = await api("/api/settings/update", { method: "POST" });
      if (message) message.textContent = result.message || "Update gestartet. Warte auf den Neustart …";
      state.updatePolling = true;
      await pollForUpdate(previousCommit);
    } catch (error) {
      if (message) message.textContent = `Update fehlgeschlagen: ${error.message}`;
      if (button) button.disabled = false;
      showToast("Update konnte nicht gestartet werden", error.message, "error");
    }
  }

  async function pollForUpdate(previousCommit) {
    const deadline = Date.now() + 90_000;
    let collectorWasUnavailable = false;

    while (Date.now() < deadline && state.updatePolling && state.route.name === "settings") {
      await sleep(3_000);
      const message = document.querySelector("#update-message");
      try {
        const version = await api("/api/settings/version", { timeout: 20_000 });
        const installedCommit = version.installed?.commit || "";
        if (installedCommit && installedCommit !== previousCommit && !version.update_available) {
          if (message) message.textContent = "Update erfolgreich. Die Oberfläche wird neu geladen …";
          showToast("Update erfolgreich", `Version ${installedCommit} ist aktiv.`, "success");
          await sleep(1_500);
          window.location.reload();
          return;
        }
        if (message) {
          message.textContent = collectorWasUnavailable
            ? "Collector ist wieder erreichbar. Deployment wird verifiziert …"
            : "Update läuft. Softwarestand wird geprüft …";
        }
        loadUpdateLog();
      } catch {
        collectorWasUnavailable = true;
        if (message) message.textContent = "Dashboard startet neu. Verbindung wird wiederhergestellt …";
      }
    }

    state.updatePolling = false;
    const message = document.querySelector("#update-message");
    if (message) message.textContent = "Der Abschluss konnte nicht automatisch bestätigt werden. Prüfen Sie das Update-Protokoll.";
    const button = document.querySelector('[data-action="install-update"]');
    if (button) button.disabled = false;
    loadUpdateLog();
  }

  // ── Account (self-service: password, TOTP, passkeys) ───────────────────
  async function renderAccount(nonce) {
    renderViewLoading("Konto", "Verwaltung");
    try {
      const account = await api("/api/account");
      if (nonce !== state.viewNonce || state.route.name !== "account") return;
      renderAccountPage(account);
    } catch (error) {
      if (nonce !== state.viewNonce) return;
      renderSectionError("Konto nicht verfügbar", error.message, "account");
    }
  }

  function renderAccountPage(account) {
    setPageMeta("Konto", "Verwaltung");
    const user = account.user;
    const webauthn = account.webauthn;

    dom.main.innerHTML = `
      <section class="page-heading">
        <div>
          <h1>Konto</h1>
          <p>Passwort, Zwei-Faktor-Authentifizierung und Passkeys für Ihr eigenes Konto verwalten.</p>
        </div>
      </section>

      <div class="settings-grid">
        <section class="panel" aria-labelledby="profile-title">
          <div class="panel-header"><div class="panel-title"><h3 id="profile-title">Profil</h3><p>Kontoinformationen</p></div></div>
          <dl class="info-list">
            <div class="info-row"><dt>Benutzername</dt><dd>${escapeHtml(user.username)}</dd></div>
            <div class="info-row"><dt>Rolle</dt><dd>${user.is_admin ? "Administrator" : "Benutzer"}</dd></div>
            <div class="info-row"><dt>Angelegt</dt><dd>${escapeHtml(formatDateTime(user.created_ts))}</dd></div>
            <div class="info-row"><dt>Letzte Anmeldung</dt><dd>${user.last_login_ts ? escapeHtml(formatDateTime(user.last_login_ts)) : "–"}</dd></div>
          </dl>
        </section>

        <section class="panel" aria-labelledby="password-title">
          <div class="panel-header"><div class="panel-title"><h3 id="password-title">Passwort ändern</h3><p>Meldet alle Sitzungen danach ab</p></div></div>
          <form class="form-panel" id="password-form">
            <div class="form-grid">
              <label class="field field-wide">
                <span>Aktuelles Passwort</span>
                <input name="current_password" type="password" required autocomplete="current-password">
              </label>
              <label class="field field-wide">
                <span>Neues Passwort</span>
                <input name="new_password" type="password" required minlength="10" autocomplete="new-password">
                <small class="field-hint">Mindestens 10 Zeichen.</small>
              </label>
            </div>
            <p class="form-error" id="password-form-error" role="alert"></p>
            <div class="form-actions">
              <button class="button button-primary" type="submit">Passwort ändern</button>
            </div>
          </form>
        </section>

        <section class="panel" aria-labelledby="totp-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="totp-title">Zwei-Faktor-Authentifizierung</h3><p>Zeitbasierter Code (TOTP)</p></div>
            <span class="status-badge ${user.totp_enabled ? "is-ok" : "is-neutral"}">${user.totp_enabled ? "Aktiv" : "Inaktiv"}</span>
          </div>
          <div class="session-panel" id="totp-panel">
            ${user.totp_enabled ? `
              <p>Zwei-Faktor-Authentifizierung ist für Ihr Konto aktiv. Zum Deaktivieren ist Ihr Passwort erforderlich.</p>
              <form id="totp-disable-form" class="form-panel-inline">
                <label class="field"><span>Aktuelles Passwort</span><input name="current_password" type="password" required autocomplete="current-password"></label>
                <p class="form-error" id="totp-disable-error" role="alert"></p>
                <button class="button button-danger-subtle" type="submit">Zwei-Faktor-Authentifizierung deaktivieren</button>
              </form>` : `
              <p>Schützen Sie Ihr Konto zusätzlich mit einer Authenticator-App (z. B. Aegis, Google Authenticator, 1Password).</p>
              <button class="button button-primary" type="button" data-action="start-totp-setup">${icon("smartphone")}<span>Aktivieren</span></button>
              <div id="totp-setup-output"></div>`}
          </div>
        </section>

        <section class="panel" aria-labelledby="passkeys-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="passkeys-title">Passkeys</h3><p>Passwortlose Anmeldung per Gerät</p></div>
            ${webauthn.available ? `<button class="button button-secondary button-small" type="button" data-action="start-passkey-registration">${icon("plus")}<span>Passkey</span></button>` : ""}
          </div>
          <div id="passkey-list">${renderPasskeyList(account.webauthn_credentials)}</div>
          ${!webauthn.available ? `
            <p class="field-hint webauthn-hint">
              Passkeys benötigen HTTPS oder den Hostnamen „localhost" —
              ${webauthn.secure_context ? "über eine IP-Adresse ist das laut Browser-Spezifikation nicht möglich." : "diese Verbindung ist aktuell nicht ausreichend abgesichert."}
            </p>` : ""}
        </section>
      </div>`;
  }

  function renderPasskeyList(credentials) {
    if (!credentials.length) {
      return '<div class="empty-state empty-state-compact"><div><h3>Noch keine Passkeys</h3><p>Registrierte Passkeys erscheinen hier.</p></div></div>';
    }
    return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Name</th><th class="hide-mobile">Angelegt</th><th class="hide-mobile">Zuletzt verwendet</th><th><span class="sr-only">Aktionen</span></th></tr></thead>
          <tbody>
            ${credentials.map((cred) => `
              <tr>
                <td><span class="peer-name">${escapeHtml(cred.nickname)}</span></td>
                <td class="mono hide-mobile">${escapeHtml(formatDateTime(cred.created_ts))}</td>
                <td class="mono hide-mobile">${cred.last_used_ts ? escapeHtml(formatDateTime(cred.last_used_ts)) : "nie"}</td>
                <td class="table-actions">
                  <button class="button button-danger-subtle button-small" type="button" data-action="delete-passkey" data-id="${cred.id}">
                    ${icon("trash")}<span>Entfernen</span>
                  </button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  async function submitPasswordForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const errorElement = document.querySelector("#password-form-error");
    const data = new FormData(form);
    const body = {
      current_password: String(data.get("current_password") || ""),
      new_password: String(data.get("new_password") || ""),
    };
    submit.disabled = true;
    errorElement.textContent = "";
    try {
      const result = await api("/api/account/password", { method: "POST", body: JSON.stringify(body) });
      showToast("Passwort geändert", result.message, "success");
      await logout();
    } catch (error) {
      errorElement.textContent = error.message;
      submit.disabled = false;
    }
  }

  async function startTotpSetup() {
    try {
      const data = await api("/api/account/totp/setup", { method: "POST" });
      const output = document.querySelector("#totp-setup-output");
      if (!output) return;
      output.innerHTML = `
        <div class="totp-setup-box">
          <p>Scannen Sie den QR-Code mit Ihrer Authenticator-App oder geben Sie den Schlüssel manuell ein.</p>
          <div class="totp-qr">${data.qr_svg}</div>
          <code class="totp-secret">${escapeHtml(data.secret)}</code>
          <form id="totp-confirm-form" class="form-panel-inline">
            <label class="field"><span>Bestätigungscode</span><input name="code" inputmode="numeric" pattern="[0-9]{6,10}" maxlength="10" required autocomplete="one-time-code"></label>
            <p class="form-error" id="totp-confirm-error" role="alert"></p>
            <button class="button button-primary" type="submit">Bestätigen und aktivieren</button>
          </form>
        </div>`;
    } catch (error) {
      showToast("TOTP-Einrichtung fehlgeschlagen", error.message, "error");
    }
  }

  async function submitTotpConfirmForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const errorElement = document.querySelector("#totp-confirm-error");
    const code = String(new FormData(form).get("code") || "").trim();
    submit.disabled = true;
    errorElement.textContent = "";
    try {
      await api("/api/account/totp/confirm", { method: "POST", body: JSON.stringify({ code }) });
      showToast("Zwei-Faktor-Authentifizierung aktiviert", "", "success");
      state.viewNonce += 1;
      await renderAccount(state.viewNonce);
    } catch (error) {
      errorElement.textContent = error.message;
      submit.disabled = false;
    }
  }

  async function submitTotpDisableForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const errorElement = document.querySelector("#totp-disable-error");
    const currentPassword = String(new FormData(form).get("current_password") || "");
    submit.disabled = true;
    errorElement.textContent = "";
    try {
      await api("/api/account/totp/disable", { method: "POST", body: JSON.stringify({ current_password: currentPassword }) });
      showToast("Zwei-Faktor-Authentifizierung deaktiviert", "", "success");
      state.viewNonce += 1;
      await renderAccount(state.viewNonce);
    } catch (error) {
      errorElement.textContent = error.message;
      submit.disabled = false;
    }
  }

  async function startPasskeyRegistration() {
    const nickname = window.prompt("Name für diesen Passkey (z. B. YubiKey oder iPhone):", "Passkey");
    if (nickname === null) return;
    try {
      const optionsResponse = await api("/api/account/webauthn/register/options", { method: "POST" });
      const credential = await navigator.credentials.create({
        publicKey: creationOptionsFromServer(optionsResponse.options),
      });
      await api("/api/account/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({
          challenge_token: optionsResponse.challenge_token,
          credential: registrationCredentialToJSON(credential),
          nickname: nickname.trim() || "Passkey",
        }),
      });
      showToast("Passkey hinzugefügt", nickname, "success");
      state.viewNonce += 1;
      await renderAccount(state.viewNonce);
    } catch (error) {
      showToast("Passkey konnte nicht hinzugefügt werden", describeWebauthnError(error), "error");
    }
  }

  async function deletePasskey(id) {
    const confirmed = await confirmAction({
      eyebrow: "Passkey entfernen",
      title: "Diesen Passkey entfernen?",
      message: "Das Gerät kann sich danach nicht mehr mit diesem Passkey anmelden.",
      confirmLabel: "Entfernen",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/account/webauthn/${id}`, { method: "DELETE" });
      state.viewNonce += 1;
      await renderAccount(state.viewNonce);
      showToast("Passkey entfernt", "", "success");
    } catch (error) {
      showToast("Passkey konnte nicht entfernt werden", error.message, "error");
    }
  }

  // ── User management (admin only) ────────────────────────────────────────
  async function renderUsers(nonce) {
    renderViewLoading("Benutzer", "Verwaltung");
    try {
      const users = await api("/api/users");
      if (nonce !== state.viewNonce || state.route.name !== "users") return;
      renderUsersPage(Array.isArray(users) ? users : []);
    } catch (error) {
      if (nonce !== state.viewNonce) return;
      renderSectionError("Benutzerverwaltung nicht verfügbar", error.message, "users");
    }
  }

  function renderUsersPage(users) {
    setPageMeta("Benutzer", "Verwaltung");
    dom.main.innerHTML = `
      <section class="page-heading">
        <div>
          <h1>Benutzerverwaltung</h1>
          <p>Zusätzliche Konten für das Dashboard anlegen und verwalten.</p>
        </div>
      </section>

      <div class="admin-grid">
        <section class="panel" aria-labelledby="new-user-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="new-user-title">Benutzer anlegen</h3><p>Vergibt ein Konto mit Passwort-Login</p></div>
          </div>
          <form class="form-panel" id="user-form">
            <div class="form-grid">
              <label class="field">
                <span>Benutzername</span>
                <input name="username" required minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]{3,64}" autocomplete="off">
              </label>
              <label class="field">
                <span>Passwort</span>
                <input name="password" type="password" required minlength="10" autocomplete="new-password">
              </label>
              <label class="check-field field-wide">
                <input type="checkbox" name="is_admin">
                <span>Administrator (kann Benutzer verwalten)</span>
              </label>
            </div>
            <p class="form-error" id="user-form-error" role="alert"></p>
            <div class="form-actions">
              <button class="button button-primary" type="submit">Benutzer anlegen</button>
            </div>
          </form>
        </section>

        <section class="panel" aria-labelledby="user-list-title">
          <div class="panel-header">
            <div class="panel-title"><h3 id="user-list-title">Registrierte Benutzer</h3><p><span id="user-list-count">${users.length}</span> Konten</p></div>
          </div>
          <div id="user-list">${renderUserList(users)}</div>
        </section>
      </div>`;
  }

  function renderUserList(users) {
    return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Benutzer</th><th>Rolle</th><th class="hide-mobile">2FA / Passkeys</th><th class="hide-mobile">Letzte Anmeldung</th><th><span class="sr-only">Aktionen</span></th></tr></thead>
          <tbody>
            ${users.map((user) => `
              <tr>
                <td>
                  <span class="peer-name">${escapeHtml(user.username)}</span>
                  ${user.id === state.currentUser?.id ? '<small class="secondary-line">Sie</small>' : ""}
                </td>
                <td><span class="status-badge ${user.is_admin ? "is-info" : "is-neutral"}">${user.is_admin ? "Administrator" : "Benutzer"}</span></td>
                <td class="mono hide-mobile">${user.totp_enabled ? "TOTP" : "–"}${user.webauthn_count ? ` · ${user.webauthn_count} Passkey(s)` : ""}</td>
                <td class="mono hide-mobile">${user.last_login_ts ? escapeHtml(formatDateTime(user.last_login_ts)) : "nie"}</td>
                <td class="table-actions">
                  <button class="button button-danger-subtle button-small" type="button" data-action="delete-user" data-id="${user.id}" data-username="${escapeHtml(user.username)}">
                    ${icon("trash")}<span>Löschen</span>
                  </button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  async function refreshUserList() {
    const users = await api("/api/users");
    const list = document.querySelector("#user-list");
    const count = document.querySelector("#user-list-count");
    if (list) list.innerHTML = renderUserList(Array.isArray(users) ? users : []);
    if (count) count.textContent = String(Array.isArray(users) ? users.length : 0);
  }

  async function submitUserForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const errorElement = document.querySelector("#user-form-error");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const body = {
      username: String(data.get("username") || "").trim(),
      password: String(data.get("password") || ""),
      is_admin: data.get("is_admin") === "on",
    };
    submit.disabled = true;
    errorElement.textContent = "";
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify(body) });
      form.reset();
      await refreshUserList();
      showToast("Benutzer angelegt", body.username, "success");
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function deleteUser(id, username) {
    const confirmed = await confirmAction({
      eyebrow: "Benutzerverwaltung",
      title: `${username} löschen?`,
      message: "Das Konto und alle zugehörigen Sitzungen und Passkeys werden entfernt.",
      confirmLabel: "Benutzer löschen",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/users/${id}`, { method: "DELETE" });
      await refreshUserList();
      showToast("Benutzer gelöscht", username, "success");
    } catch (error) {
      showToast("Benutzer konnte nicht gelöscht werden", error.message, "error");
    }
  }

  function renderSectionError(title, message, section) {
    const eyebrowBySection = { peers: "Peers", settings: "Einstellungen", account: "Konto", users: "Benutzer" };
    const refreshActionBySection = {
      peers: "refresh-peers", settings: "refresh-settings", account: "refresh-account", users: "refresh-users",
    };
    setPageMeta(eyebrowBySection[section] || "Verwaltung", "Verwaltung");
    dom.main.innerHTML = `
      <div class="error-state">
        <div>
          <span class="error-state-icon" aria-hidden="true">${icon("alertTriangle")}</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          <button class="button button-primary" type="button" data-action="${refreshActionBySection[section] || "refresh"}">Erneut versuchen</button>
        </div>
      </div>`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.className = "sr-only";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
  }

  function closeAllRowMenus(exceptMenu = null) {
    document.querySelectorAll(".row-menu.is-open").forEach((menu) => {
      if (menu === exceptMenu) return;
      menu.classList.remove("is-open");
      menu.querySelector('[data-action="toggle-menu"]')?.setAttribute("aria-expanded", "false");
    });
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    if (action !== "toggle-menu") closeAllRowMenus();
    switch (action) {
      case "toggle-menu": {
        const menu = button.closest(".row-menu");
        const wasOpen = menu.classList.contains("is-open");
        closeAllRowMenus();
        if (!wasOpen) {
          menu.classList.add("is-open");
          button.setAttribute("aria-expanded", "true");
        }
        break;
      }
      case "open-menu":
        document.body.classList.add("menu-open");
        button.setAttribute("aria-expanded", "true");
        break;
      case "close-menu":
        closeMobileMenu();
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "refresh":
        await refreshData({ manual: true, render: true });
        break;
      case "filter-status":
        state.statusFilter = button.dataset.status || "all";
        document.querySelectorAll('[data-action="filter-status"]').forEach((filter) => {
          filter.setAttribute("aria-pressed", String(filter.dataset.status === state.statusFilter));
        });
        renderFleetResults();
        break;
      case "dismiss-toast":
        button.closest(".toast")?.remove();
        break;
      case "logout":
        await logout();
        break;
      case "login-with-passkey":
        await loginWithPasskeyDirect();
        break;
      case "login-with-passkey-mfa":
        await loginWithPasskeyStepUp();
        break;
      case "back-to-login":
        state.authView = { kind: "login" };
        renderAuthView();
        break;
      case "show-enroll": {
        const key = decodeData(button.dataset.key);
        showEnrollment(`curl -fsSL ${window.location.origin}/enroll/${key} | bash`);
        document.querySelector("#enrollment-output")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        break;
      }
      case "copy-command": {
        const command = document.querySelector("#enrollment-command")?.textContent || "";
        await copyText(command);
        showToast("In Zwischenablage kopiert", "Der Enrollment-Befehl ist bereit.", "success");
        break;
      }
      case "delete-peer":
        await deletePeer(decodeData(button.dataset.peer));
        break;
      case "refresh-peers":
        state.viewNonce += 1;
        await renderPeers(state.viewNonce);
        break;
      case "refresh-settings":
        state.viewNonce += 1;
        await renderSettings(state.viewNonce);
        break;
      case "refresh-account":
        state.viewNonce += 1;
        await renderAccount(state.viewNonce);
        break;
      case "refresh-users":
        state.viewNonce += 1;
        await renderUsers(state.viewNonce);
        break;
      case "refresh-log":
        await loadUpdateLog();
        break;
      case "install-update":
        await installUpdate(decodeData(button.dataset.installed));
        break;
      case "start-totp-setup":
        await startTotpSetup();
        break;
      case "start-passkey-registration":
        await startPasskeyRegistration();
        break;
      case "delete-passkey":
        await deletePasskey(Number(button.dataset.id));
        break;
      case "delete-user":
        await deleteUser(Number(button.dataset.id), decodeData(button.dataset.username));
        break;
      default:
        break;
    }
  }

  function bindEvents() {
    window.addEventListener("hashchange", () => {
      state.route = parseRoute();
      if (state.currentUser) {
        renderCurrentView();
        dom.main.focus({ preventScroll: true });
      }
    });

    document.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) {
        if (!event.target.closest(".row-menu")) closeAllRowMenus();
        return;
      }
      event.preventDefault();
      handleAction(action);
    });

    document.addEventListener("input", (event) => {
      if (event.target.id !== "fleet-search") return;
      state.search = event.target.value;
      renderFleetResults();
    });

    document.addEventListener("submit", (event) => {
      const form = event.target;
      const handlers = {
        "peer-form": submitPeerForm,
        "setup-form": submitSetupForm,
        "login-form": submitLoginForm,
        "totp-login-form": submitTotpLoginForm,
        "password-form": submitPasswordForm,
        "totp-confirm-form": submitTotpConfirmForm,
        "totp-disable-form": submitTotpDisableForm,
        "user-form": submitUserForm,
      };
      const handler = handlers[form.id];
      if (!handler) return;
      event.preventDefault();
      handler(form);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMobileMenu();
        closeAllRowMenus();
      }
    });
  }

  async function init() {
    initializeTheme();
    bindEvents();
    state.route = parseRoute();
    if (!window.location.hash) window.history.replaceState(null, "", "#/overview");

    await checkAuthStatus();

    if (!state.currentUser) {
      showAuthScreen();
      renderAuthView();
      return;
    }

    showAppShell();
    renderNavigation();
    updateConnectionState();
    await refreshData({ render: true });
    if (["peers", "settings", "account", "users"].includes(state.route.name)) renderCurrentView();

    window.setInterval(() => {
      if (!state.currentUser) return;
      refreshData({
        render: state.route.name === "overview" || state.route.name === "server",
      });
    }, REFRESH_INTERVAL_MS);
  }

  init();
})();
