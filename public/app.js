if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

async function api(path, opts = {}) {
  const method = opts.method || "GET";
  if (method === "GET") {
    const cached = consumePrefetch(path);
    if (cached) return cached;
  }
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// ---------- nav prefetch (hover/touch warm-up) ----------
// Warms up the exact GET requests a destination page will make as soon as
// the user shows intent to go there — hover on desktop, touchstart on
// mobile — so that by the time the click actually lands, the response is
// often already back and the destination page's first paint can show real
// content instead of a skeleton. Cached in sessionStorage, since plain JS
// state doesn't survive the full-page navigation a nav link triggers.
// Consumed (deleted) on first read so a page's own live polling never
// serves a stale prefetch snapshot on its second call, and the short TTL
// keeps a missed/late prefetch from ever answering with genuinely stale
// data — this app leans on frequent live polling elsewhere for the same
// reason (see sw.js's deliberate refusal to cache /api/*).
const PREFETCH_TTL_MS = 6000;
const PREFETCH_ROUTES = {
  "/deliver.html": ["/api/stripe/config", "/api/orders/open", "/api/orders/delivering"],
  "/order.html": ["/api/config", "/api/stripe/config", "/api/mapbox/config", "/api/orders/mine", "/api/stats/active-deliverers"],
  "/messages.html": ["/api/messages/threads"]
};

function consumePrefetch(path) {
  const key = `prefetch:${path}`;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key);
    const { data, ts } = JSON.parse(raw);
    return Date.now() - ts <= PREFETCH_TTL_MS ? data : null;
  } catch (e) {
    return null;
  }
}

function warmPrefetch(pathname) {
  const routes = PREFETCH_ROUTES[pathname];
  if (!routes) return;
  routes.forEach((path) => {
    const key = `prefetch:${path}`;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw && Date.now() - JSON.parse(raw).ts <= PREFETCH_TTL_MS) return; // already warm
    } catch (e) {}
    fetch(path, { headers: { "Content-Type": "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data == null) return;
        try { sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch (e) {}
      })
      .catch(() => {});
  });
}

function wireNavPrefetch() {
  document.querySelectorAll("a.navlink[href]").forEach((link) => {
    const href = link.getAttribute("href");
    if (!PREFETCH_ROUTES[href]) return;
    const start = () => warmPrefetch(href);
    link.addEventListener("mouseenter", start, { passive: true });
    link.addEventListener("touchstart", start, { passive: true });
    link.addEventListener("focus", start, { passive: true });
  });
}

async function getMe() {
  const { user } = await api("/api/me");
  return user;
}

async function requireAuthOrRedirect() {
  const user = await getMe();
  if (!user) {
    window.location.href = "/";
    return null;
  }
  renderNav(user);
  startUnreadBadgePolling();
  return user;
}

const PAW_ICON = '<img src="/wildcat-eats-logo.png" alt="" style="height:28px; width:auto; vertical-align:-8px; margin-right:2px;" />';

const GEAR_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="vertical-align:-4px;">
  <path d="M19.14 12.94a7.14 7.14 0 0 0 .06-.94 7.14 7.14 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.14 7.14 0 0 0 0 1.88L2.83 14.5a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.4.32.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.24.1.5 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
</svg>`;

// ---------- page loader ----------
// The overlay markup ships inline in each page's HTML (so it paints before
// any script runs) with class "page-loader" and id "pageLoader". Every
// page's init script should call this once it has real content to show.
function hidePageLoader() {
  // Also the "content is ready" signal page-reveal.js waits on to delay a
  // View Transition's reveal until real content — not a skeleton — is
  // what actually slides in. Unconditional (ahead of the element check
  // below) so it still fires even if the loader element is already gone.
  window.__resolvePageReady?.();
  const el = document.getElementById("pageLoader");
  if (!el) return;
  el.setAttribute("aria-hidden", "true");
  el.classList.add("hidden");
  setTimeout(() => el.remove(), 50);
}
// Belt-and-suspenders: if something throws before a page's init script
// reaches hidePageLoader(), don't leave the user staring at this forever.
setTimeout(hidePageLoader, 4000);

// Renders `count` placeholder cards shaped like a real .order-item, styled
// via CSS to shimmer — used for the very first fetch on a list so it never
// pops from blank to content. Real renders overwrite this on the next poll.
function skeletonList(count = 3) {
  return Array.from({ length: count })
    .map(
      () => `
    <div class="order-item skeleton" aria-hidden="true">
      <div class="top-row">
        <div><div class="store">Loading order</div><div class="hall">placeholder</div></div>
        <span class="badge open">Open</span>
      </div>
      <div class="items">Placeholder item text so the card takes its real height</div>
      <div class="meta">Placeholder</div>
    </div>
  `
    )
    .join("");
}

function renderNav(user) {
  const el = document.getElementById("nav");
  if (!el) return;
  const path = window.location.pathname;
  el.innerHTML = `
    <div class="nav-top">
      <a class="brand" href="/order.html">${PAW_ICON} <span class="dash-text">NovaDash</span></a>
      <div class="nav-actions">
        <span class="nav-user">Hi, ${escapeHtml(user.name.split(" ")[0])}</span>
        <a class="navlink ${path === "/settings.html" ? "active" : ""}" href="/settings.html" aria-label="Settings" title="Settings">${GEAR_ICON}</a>
        <button class="logout" id="logoutBtn">Log out</button>
      </div>
    </div>
    <nav>
      <a class="navlink ${path === "/order.html" ? "active" : ""}" href="/order.html">Order Food</a>
      <a class="navlink ${path === "/deliver.html" ? "active" : ""}" href="/deliver.html">Deliver</a>
      <a class="navlink ${path === "/messages.html" ? "active" : ""}" href="/messages.html">Messages<span class="unread-badge" id="messagesUnreadBadge" style="display:none;"></span></a>
      ${user.isAdmin ? `<a class="navlink ${path === "/admin.html" ? "active" : ""}" href="/admin.html">Reports</a>` : ""}
    </nav>
  `;
  document.getElementById("logoutBtn").onclick = async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/";
  };
  wireNavPrefetch();
}

// ---------- unread badge ----------
// One poller per page (guarded so a page that calls requireAuthOrRedirect
// more than once doesn't stack intervals), refreshing at the same 4s cadence
// everything else in the app already polls at.
let unreadPollStarted = false;
function startUnreadBadgePolling() {
  if (unreadPollStarted) return;
  unreadPollStarted = true;
  refreshUnreadBadge();
  setInterval(refreshUnreadBadge, 4000);
}

async function refreshUnreadBadge() {
  const badge = document.getElementById("messagesUnreadBadge");
  if (!badge) return;
  try {
    const { unreadCount } = await api("/api/messages/threads");
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }
  } catch (err) {
    // Non-critical — just leave the last known badge state showing.
  }
}

// Called once a thread's messages have actually been loaded (i.e. the user
// is looking at them) — clears that thread's unread state, then refreshes
// the badge right away instead of waiting up to 4s for the next poll.
async function markThreadRead(threadKey) {
  try {
    await api(`/api/messages/threads/${encodeURIComponent(threadKey)}/read`, { method: "POST" });
    refreshUnreadBadge();
  } catch (err) {
    // Non-critical.
  }
}

// ---------- push notifications ----------
// Subscribes this browser to Web Push and sends the subscription to the
// server. Safe to call repeatedly — re-subscribing just refreshes the same
// endpoint. Returns true/false so callers (the Settings toggle) can show
// whether it actually worked.
async function enablePushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push notifications aren't supported in this browser.");
  }
  const { enabled, publicKey } = await api("/api/push/config");
  if (!enabled) {
    throw new Error("Push notifications aren't configured on this server yet.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was denied.");
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  await api("/api/push/subscribe", { method: "POST", body: subscription.toJSON() });
  return true;
}

async function disablePushNotifications() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: subscription.endpoint } });
    await subscription.unsubscribe();
  }
}

async function getPushSubscriptionStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? "subscribed" : "unsubscribed";
}

// PushManager wants the VAPID key as a raw Uint8Array, not the base64url
// string the server hands back.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(ts) {
  if (!ts) return "";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

const STATUS_LABEL = {
  open: "Open",
  claimed: "Claimed",
  picked_up: "Picked up",
  delivered: "Delivered"
};

// ---------- toasts (replaces alert() everywhere) ----------

function toastContainer() {
  let el = document.querySelector(".toast-container");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast-container";
    document.body.appendChild(el);
  }
  return el;
}

function toast(message, type = "info") {
  const container = toastContainer();
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// ---------- in-order chat (orderer <-> runner, once claimed) ----------

const openChatIds = new Set();

// A conversation with admin is rare and important enough that it shouldn't
// hide behind a collapsed toggle someone has to know to click — expand it
// automatically the first time it's rendered. Tracked separately from
// openChatIds so a deliberate manual collapse afterward is still respected
// (this only forces it open once, not on every re-render).
const autoOpenedThreads = new Set();
function ensureThreadOpen(threadKey) {
  if (autoOpenedThreads.has(threadKey)) return;
  autoOpenedThreads.add(threadKey);
  openChatIds.add(threadKey);
}

// otherName is the counterpart's display name — the runner's name on the
// orderer's page, the orderer's name on the runner's page, or a specific
// party's name for one of the admin's private investigation threads. No
// otherName means no one to message, so the block is omitted entirely.
//
// An order can carry more than one distinct conversation (the orderer<->
// runner thread, plus separate private admin<->orderer / admin<->runner
// threads once reported) — threadKey tells them apart in the DOM and in
// openChatIds; endpoint is where that thread's messages actually live.
// Both default to the plain order-level thread so existing call sites don't
// need to change.
function chatSectionHtml(order, otherName, opts = {}) {
  if (!otherName) return "";
  const threadKey = opts.threadKey || `order-${order.id}`;
  const endpoint = opts.endpoint || `/api/orders/${order.id}/messages`;
  const isOpen = openChatIds.has(threadKey);
  return `
    <div class="chat-block">
      <button type="button" class="chat-toggle" data-thread-key="${threadKey}" data-other-name="${escapeHtml(otherName)}">
        ${isOpen ? "Hide messages" : `Message ${escapeHtml(otherName)}`}
      </button>
      <div class="chat-thread-wrap ${isOpen ? "open" : ""}" id="chat-wrap-${threadKey}">
        <div class="chat-thread-inner">
          <div class="chat-thread">
            <div class="chat-messages" id="chat-messages-${threadKey}"></div>
            <form class="chat-form" data-thread-key="${threadKey}" data-endpoint="${endpoint}">
              <input type="text" class="chat-input" placeholder="Type a message…" maxlength="1000" required />
              <button class="btn" type="submit">Send</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Call after rendering any list containing chatSectionHtml() blocks — wires
// up the toggle/send buttons and loads messages for threads already open.
function wireChatBlocks(container, currentUserId) {
  container.querySelectorAll(".chat-toggle[data-thread-key]").forEach((btn) => {
    const key = btn.dataset.threadKey;
    const endpoint = container.querySelector(`form[data-thread-key="${key}"]`)?.dataset.endpoint;
    btn.onclick = () => {
      const wrap = document.getElementById(`chat-wrap-${key}`);
      if (openChatIds.has(key)) {
        openChatIds.delete(key);
        wrap.classList.remove("open");
        btn.textContent = `Message ${btn.dataset.otherName}`;
      } else {
        openChatIds.add(key);
        wrap.classList.add("open");
        btn.textContent = "Hide messages";
        loadChatMessages(key, currentUserId, endpoint);
      }
    };
    if (openChatIds.has(key)) loadChatMessages(key, currentUserId, endpoint);
  });

  container.querySelectorAll("form[data-thread-key]").forEach((form) => {
    const key = form.dataset.threadKey;
    const endpoint = form.dataset.endpoint;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      try {
        await api(endpoint, { method: "POST", body: { text } });
        input.value = "";
        await loadChatMessages(key, currentUserId, endpoint);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        input.disabled = false;
        input.focus();
      }
    };
  });
}

// The order list's innerHTML gets rebuilt on every poll (same situation as
// the Mapbox instances above), which would otherwise wipe out whatever
// someone is mid-typing into an open chat reply — and their focus on it —
// every few seconds. Call capture right before the rebuild and restore
// right after re-wiring the new DOM; a message typed between two polls
// survives instead of silently vanishing.
function captureChatDrafts(container) {
  const drafts = {};
  container.querySelectorAll("form[data-thread-key] .chat-input").forEach((input) => {
    const focused = document.activeElement === input;
    if (!input.value && !focused) return;
    drafts[input.closest("form").dataset.threadKey] = {
      value: input.value,
      focused,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd
    };
  });
  return drafts;
}

function restoreChatDrafts(container, drafts) {
  Object.entries(drafts).forEach(([threadKey, draft]) => {
    const input = container.querySelector(`form[data-thread-key="${threadKey}"] .chat-input`);
    if (!input) return;
    input.value = draft.value;
    if (draft.focused) {
      input.focus();
      try { input.setSelectionRange(draft.selectionStart, draft.selectionEnd); } catch (e) {}
    }
  });
}

async function loadChatMessages(threadKey, currentUserId, endpoint) {
  endpoint = endpoint || `/api/orders/${threadKey}/messages`;
  const box = document.getElementById(`chat-messages-${threadKey}`);
  if (!box) return;
  try {
    const { messages } = await api(endpoint);
    box.innerHTML =
      messages
        .map(
          (m) => `
        <div class="chat-msg ${m.senderId === currentUserId ? "mine" : ""}">
          <span class="chat-sender">${escapeHtml(m.senderName)}</span>
          <span class="chat-text">${escapeHtml(m.text)}</span>
        </div>
      `
        )
        .join("") || `<div class="chat-empty">No messages yet — say hi!</div>`;
    box.scrollTop = box.scrollHeight;
    markThreadRead(threadKey);
  } catch (err) {
    // transient poll failure — leave the box as-is, next poll will retry
  }
}
