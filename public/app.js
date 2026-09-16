async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
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
  return user;
}

// White vector paw (matches favicon.svg) — used instead of the 🐾 emoji,
// whose colors are baked in and can't be recolored via CSS.
const PAW_ICON = `<svg class="paw" viewBox="0 0 100 100" width="20" height="20" fill="currentColor" style="vertical-align:-4px;">
  <ellipse cx="50" cy="66" rx="20" ry="16"/>
  <ellipse cx="26" cy="42" rx="9" ry="12" transform="rotate(-18 26 42)"/>
  <ellipse cx="46" cy="30" rx="9" ry="12" transform="rotate(-6 46 30)"/>
  <ellipse cx="66" cy="30" rx="9" ry="12" transform="rotate(6 66 30)"/>
  <ellipse cx="86" cy="42" rx="9" ry="12" transform="rotate(18 86 42)"/>
</svg>`;

// ---------- page loader ----------
// The overlay markup ships inline in each page's HTML (so it paints before
// any script runs) with class "page-loader" and id "pageLoader". Every
// page's init script should call this once it has real content to show.
function hidePageLoader() {
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
    <a class="brand" href="/order.html">${PAW_ICON} WildcatEats</a>
    <nav>
      <a class="navlink ${path === "/order.html" ? "active" : ""}" href="/order.html">Order Food</a>
      <a class="navlink ${path === "/deliver.html" ? "active" : ""}" href="/deliver.html">Deliver</a>
      <a class="navlink ${path === "/messages.html" ? "active" : ""}" href="/messages.html">Messages</a>
      ${user.isAdmin ? `<a class="navlink ${path === "/admin.html" ? "active" : ""}" href="/admin.html">Reports</a>` : ""}
      <span class="nav-user">Hi, ${escapeHtml(user.name.split(" ")[0])}</span>
      <button class="logout" id="logoutBtn">Log out</button>
    </nav>
  `;
  document.getElementById("logoutBtn").onclick = async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/";
  };
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
  } catch (err) {
    // transient poll failure — leave the box as-is, next poll will retry
  }
}
