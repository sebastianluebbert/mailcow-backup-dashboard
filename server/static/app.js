(() => {
  "use strict";

  const REFRESH_INTERVAL_MS = 60_000;
  const REQUEST_TIMEOUT_MS = 15_000;
  const TOKEN_KEY = "backupdash.adminToken";
  const LEGACY_TOKEN_KEY = "dashToken";
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
  };

  const dom = {
    main: document.querySelector("#main-content"),
    pageTitle: document.querySelector("#page-title"),
    pageEyebrow: document.querySelector("#page-eyebrow"),
    serverNav: document.querySelector("#server-nav"),
    serverCount: document.querySelector("#server-count"),
    syncLabel: document.querySelector("#sync-label"),
    footerSummary: document.querySelector("#footer-summary"),
    sidebarStatus: document.querySelector("#sidebar-status"),
    sidebarStatusDetail: document.querySelector("#sidebar-status-detail"),
    sidebarStatusDot: document.querySelector("#sidebar-status-dot"),
    lockButton: document.querySelector("#lock-button"),
    authDialog: document.querySelector("#auth-dialog"),
    authForm: document.querySelector("#auth-form"),
    authToken: document.querySelector("#auth-token"),
    authRemember: document.querySelector("#auth-remember"),
    authError: document.querySelector("#auth-error"),
    confirmDialog: document.querySelector("#confirm-dialog"),
    confirmEyebrow: document.querySelector("#confirm-eyebrow"),
    confirmTitle: document.querySelector("#confirm-title"),
    confirmMessage: document.querySelector("#confirm-message"),
    confirmSubmit: document.querySelector("#confirm-submit"),
    toastRegion: document.querySelector("#toast-region"),
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
  const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function setPageMeta(title, eyebrow) {
    dom.pageTitle.textContent = title;
    dom.pageEyebrow.textContent = eyebrow;
    document.title = `${title} · Backup Control`;
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

  function getToken() {
    const sessionToken = sessionStorage.getItem(TOKEN_KEY);
    if (sessionToken) return sessionToken;

    const storedToken = localStorage.getItem(TOKEN_KEY);
    if (storedToken) return storedToken;

    const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacyToken) {
      localStorage.setItem(TOKEN_KEY, legacyToken);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      return legacyToken;
    }
    return "";
  }

  function tokenStorageMode() {
    if (sessionStorage.getItem(TOKEN_KEY)) return "Nur diese Browser-Sitzung";
    if (localStorage.getItem(TOKEN_KEY)) return "Dauerhaft auf diesem Gerät";
    return "Nicht entsperrt";
  }

  function storeToken(token, remember) {
    clearToken();
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem(TOKEN_KEY, token);
    updateSessionControls();
  }

  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    updateSessionControls();
  }

  function updateSessionControls() {
    dom.lockButton.classList.toggle("is-hidden", !getToken());
  }

  let authRequest = null;

  function requestToken(message = "") {
    const existing = getToken();
    if (existing) return Promise.resolve(existing);

    if (authRequest) {
      if (message) dom.authError.textContent = message;
      return authRequest.promise;
    }

    dom.authForm.reset();
    dom.authError.textContent = message;
    dom.authDialog.showModal();
    window.setTimeout(() => dom.authToken.focus(), 0);

    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    authRequest = { promise, resolve: resolveRequest, reject: rejectRequest };
    return promise;
  }

  function cancelTokenRequest() {
    if (!authRequest) return;
    const request = authRequest;
    authRequest = null;
    dom.authDialog.close();
    request.reject(new ApiError("Admin-Bereich wurde nicht entsperrt.", 401));
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

  async function api(path, options = {}, retryOnUnauthorized = true) {
    const {
      auth = false,
      responseType = "json",
      timeout = REQUEST_TIMEOUT_MS,
      headers: suppliedHeaders = {},
      ...fetchOptions
    } = options;

    const headers = new Headers(suppliedHeaders);
    if (fetchOptions.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (auth) headers.set("Authorization", `Bearer ${await requestToken()}`);

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await fetch(path, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("Die Anfrage hat zu lange gedauert.");
      throw new ApiError("Collector nicht erreichbar.");
    } finally {
      window.clearTimeout(timer);
    }

    if (response.status === 401 && auth && retryOnUnauthorized) {
      clearToken();
      await requestToken("Der Token ist ungültig oder wurde geändert.");
      return api(path, options, false);
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
      <button type="button" data-action="dismiss-toast" aria-label="Hinweis schließen">×</button>`;
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

  function parseRoute() {
    const raw = (window.location.hash || "#/overview").replace(/^#\//, "");
    const [name, ...parts] = raw.split("/");
    if (name === "server" && parts.length) {
      return { name: "server", server: decodeData(parts.join("/")) };
    }
    if (["overview", "peers", "settings"].includes(name)) return { name };
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
    const hasProblems = asNumber(state.summary.error) > 0 || asNumber(state.summary.stale) > 0;
    dom.sidebarStatusDot.className = `connection-dot ${state.online ? "is-online" : "is-offline"}`;
    dom.sidebarStatus.textContent = state.online ? "Collector verbunden" : "Collector offline";
    dom.sidebarStatusDetail.textContent = state.online
      ? hasProblems
        ? `${asNumber(state.summary.error) + asNumber(state.summary.stale)} Server prüfen`
        : "Alle Dienste erreichbar"
      : "Verbindung unterbrochen";
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
          <span class="error-state-icon" aria-hidden="true">!</span>
          <h2>Collector nicht erreichbar</h2>
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

    switch (state.route.name) {
      case "peers":
        renderPeers(state.viewNonce);
        break;
      case "settings":
        renderSettings(state.viewNonce);
        break;
      case "server":
        renderServerDetail(state.route.server);
        break;
      default:
        renderOverview();
    }
  }

  function metricCard(label, value, detail, tone = "", valueTone = "") {
    return `
      <article class="metric-card ${tone}">
        <div class="metric-label">${escapeHtml(label)}</div>
        <p class="metric-value ${valueTone}">${escapeHtml(value)}</p>
        <p class="metric-detail">${escapeHtml(detail)}</p>
      </article>`;
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
          <h2>Fleet Operations</h2>
          <p>Backup-Zustand, Kapazität und Laufzeiten Ihrer Mailcow-Infrastruktur auf einen Blick.</p>
        </div>
        <div class="page-heading-actions">
          <a class="button button-secondary" href="#/peers">Peer verwalten</a>
        </div>
      </section>

      ${!state.online ? `
        <div class="banner is-warning" role="alert">
          <span aria-hidden="true">!</span>
          <span><strong>Live-Verbindung unterbrochen</strong><small>Es werden die zuletzt geladenen Daten angezeigt.</small></span>
        </div>` : ""}

      <section class="metrics" aria-label="Fleet-Kennzahlen">
        ${metricCard("Fleet-Status", fleetStatus.value, fleetStatus.detail, fleetStatus.tone, fleetStatus.valueTone)}
        ${metricCard("Server", String(asNumber(summary.servers)), "Aktiv angebunden")}
        ${metricCard("Speicher", formatGb(summary.repo_total_gb), "Alle Borg-Repositories")}
        ${metricCard("Läufe · 24 h", String(asNumber(summary.runs_24h)), "Empfangene Reports")}
        ${metricCard("Fehler · 7 Tage", String(asNumber(summary.fails_7d)), "Fehlgeschlagene Läufe", asNumber(summary.fails_7d) ? "is-danger" : "", asNumber(summary.fails_7d) ? "is-danger" : "")}
        ${metricCard("Verify-Fehler · 30 T", String(asNumber(summary.verify_fails_30d)), "Fehlgeschlagene Restore-Tests", asNumber(summary.verify_fails_30d) ? "is-warning" : "", asNumber(summary.verify_fails_30d) ? "is-warning" : "")}
        ${metricCard("Watchdog-Fehler · 24 h", String(asNumber(summary.watchdog_fails_24h)), "Health-Check-Warnungen", asNumber(summary.watchdog_fails_24h) ? "is-warning" : "", asNumber(summary.watchdog_fails_24h) ? "is-warning" : "")}
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
            <span aria-hidden="true">⌕</span>
            <span class="sr-only">Server suchen</span>
            <input id="fleet-search" type="search" placeholder="Server suchen …" value="${escapeHtml(state.search)}" autocomplete="off">
          </label>
          <div class="filter-group" aria-label="Nach Status filtern">
            ${[
              ["all", "Alle"],
              ["ok", "Gesund"],
              ["error", "Fehler"],
              ["stale", "Überfällig"],
            ].map(([value, label]) => `
              <button class="filter-button" type="button" data-action="filter-status" data-status="${value}"
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
            <span class="empty-state-icon" aria-hidden="true">＋</span>
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
            <span class="empty-state-icon" aria-hidden="true">⌕</span>
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
                  <td><a class="row-action" href="#/server/${encodeURIComponent(server.server)}" aria-label="${escapeHtml(server.server)} öffnen">›</a></td>
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
            <span class="error-state-icon" aria-hidden="true">?</span>
            <h2>Server nicht gefunden</h2>
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
          <h2>${escapeHtml(server.server)}</h2>
          <p>Backup-Verlauf und Betriebsmetriken dieses Mailcow-Servers.</p>
        </div>
        <div class="page-heading-actions">
          <a class="button button-secondary" href="#/overview">← Zur Übersicht</a>
        </div>
      </section>

      ${server.state !== "ok" ? `
        <div class="banner ${server.state === "error" ? "is-danger" : "is-warning"}" role="alert">
          <span aria-hidden="true">!</span>
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
            <div><span class="empty-state-icon" aria-hidden="true">✓</span><h3>Keine Fehler aufgezeichnet</h3><p>Für diesen Server liegen keine Fehlermeldungen vor.</p></div>
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

  async function renderPeers(nonce) {
    renderViewLoading("Peers", "Verwaltung");
    try {
      const peers = await api("/api/peers", { auth: true });
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
          <h2>Server-Onboarding</h2>
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
              <fieldset class="field field-wide components-field">
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
          <div><span class="empty-state-icon" aria-hidden="true">＋</span><h3>Noch keine Peers</h3><p>Neue Enrollment-Einträge erscheinen hier.</p></div>
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
                  <div class="table-actions">
                    ${peer.enrolled_ts ? "" : `
                      <button class="button button-secondary button-small" type="button" data-action="show-enroll"
                              data-key="${encodeData(peer.enroll_key)}">Befehl</button>`}
                    <button class="button button-danger-subtle button-small" type="button" data-action="delete-peer"
                            data-peer="${encodeData(peer.name)}">Löschen</button>
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
          <button class="button button-secondary" type="button" data-action="copy-command">Kopieren</button>
        </div>
      </div>`;
    document.querySelector("#enrollment-command").textContent = command;
  }

  async function refreshPeerList() {
    const peers = await api("/api/peers", { auth: true });
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
      const result = await api("/api/peers", {
        auth: true,
        method: "POST",
        body: JSON.stringify(body),
      });
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
      await api(`/api/peers/${encodeURIComponent(name)}`, { auth: true, method: "DELETE" });
      await refreshPeerList();
      showToast("Peer gelöscht", `${name} wurde aus der Verwaltung entfernt.`, "success");
    } catch (error) {
      showToast("Peer konnte nicht gelöscht werden", error.message, "error");
    }
  }

  async function renderSettings(nonce) {
    renderViewLoading("Einstellungen", "System");
    try {
      const version = await api("/api/settings/version", { auth: true, timeout: 30_000 });
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
          <h2>System & Updates</h2>
          <p>Softwarestand, Update-Protokoll und lokale Admin-Sitzung verwalten.</p>
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
            <div class="info-row"><dt>Agent-Updates</dt><dd>/agent/script</dd></div>
            <div class="info-row"><dt>Update-Verfahren</dt><dd>Fetch · Deploy · Restart · Rollback</dd></div>
          </dl>
        </section>

        <section class="panel" aria-labelledby="session-title">
          <div class="panel-header"><div class="panel-title"><h3 id="session-title">Admin-Sitzung</h3><p>Lokaler Browserzugriff</p></div></div>
          <div class="session-panel">
            <div class="session-state">
              <span class="connection-dot is-online" aria-hidden="true"></span>
              <strong>Admin-Bereich entsperrt</strong>
            </div>
            <p>Tokenspeicherung: ${escapeHtml(tokenStorageMode())}. Beim Sperren wird der Token aus diesem Browser entfernt.</p>
            <button class="button button-danger-subtle" type="button" data-action="lock-session">Sitzung sperren</button>
          </div>
        </section>
      </div>`;
  }

  async function loadUpdateLog() {
    const log = document.querySelector("#update-log");
    if (!log) return;
    try {
      log.textContent = await api("/api/settings/update-log", { auth: true, responseType: "text" });
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
      const result = await api("/api/settings/update", { auth: true, method: "POST" });
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
        const version = await api("/api/settings/version", {
          auth: true,
          timeout: 20_000,
        });
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

  function renderSectionError(title, message, section) {
    setPageMeta(section === "peers" ? "Peers" : "Einstellungen", "Verwaltung");
    dom.main.innerHTML = `
      <div class="error-state">
        <div>
          <span class="error-state-icon" aria-hidden="true">!</span>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(message)}</p>
          <button class="button button-primary" type="button" data-action="${section === "peers" ? "refresh-peers" : "refresh-settings"}">Erneut versuchen</button>
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

  function lockSession() {
    clearToken();
    state.updatePolling = false;
    showToast("Admin-Sitzung gesperrt", "Der Token wurde aus diesem Browser entfernt.", "success");
    if (state.route.name === "peers" || state.route.name === "settings") {
      window.location.hash = "#/overview";
    }
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    switch (action) {
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
      case "cancel-auth":
        cancelTokenRequest();
        break;
      case "lock-session":
        lockSession();
        break;
      case "dismiss-toast":
        button.closest(".toast")?.remove();
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
      case "refresh-log":
        await loadUpdateLog();
        break;
      case "install-update":
        await installUpdate(decodeData(button.dataset.installed));
        break;
      default:
        break;
    }
  }

  function bindEvents() {
    window.addEventListener("hashchange", () => {
      state.route = parseRoute();
      renderCurrentView();
      dom.main.focus({ preventScroll: true });
    });

    document.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) return;
      event.preventDefault();
      handleAction(action);
    });

    document.addEventListener("input", (event) => {
      if (event.target.id !== "fleet-search") return;
      state.search = event.target.value;
      renderFleetResults();
    });

    document.addEventListener("submit", (event) => {
      if (event.target.id === "peer-form") {
        event.preventDefault();
        submitPeerForm(event.target);
      }
    });

    dom.authForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = dom.authToken.value.trim();
      if (!token || !authRequest) return;
      storeToken(token, dom.authRemember.checked);
      const request = authRequest;
      authRequest = null;
      dom.authDialog.close();
      request.resolve(token);
    });

    dom.authDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelTokenRequest();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMobileMenu();
    });
  }

  async function init() {
    initializeTheme();
    updateSessionControls();
    bindEvents();
    state.route = parseRoute();
    if (!window.location.hash) window.history.replaceState(null, "", "#/overview");
    renderNavigation();
    updateConnectionState();
    await refreshData({ render: true });
    if (state.route.name === "peers" || state.route.name === "settings") renderCurrentView();

    window.setInterval(() => {
      refreshData({
        render: state.route.name === "overview" || state.route.name === "server",
      });
    }, REFRESH_INTERVAL_MS);
  }

  init();
})();
