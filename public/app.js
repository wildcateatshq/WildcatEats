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

function renderNav(user) {
  const el = document.getElementById("nav");
  if (!el) return;
  const path = window.location.pathname;
  el.innerHTML = `
    <a class="brand" href="/order.html">${PAW_ICON} WildcatEats</a>
    <nav>
      <a class="navlink ${path === "/order.html" ? "active" : ""}" href="/order.html">Order Food</a>
      <a class="navlink ${path === "/deliver.html" ? "active" : ""}" href="/deliver.html">Deliver</a>
      <span style="color:white; opacity:0.85; font-size:0.9rem; margin-left:6px;">Hi, ${escapeHtml(user.name.split(" ")[0])}</span>
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
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 3800);
}

// ---------- in-order chat (orderer <-> runner, once claimed) ----------

const openChatIds = new Set();

// otherName is the counterpart's display name — the runner's name on the
// orderer's page, the orderer's name on the runner's page. No runner yet
// means no one to message, so the block is omitted entirely.
function chatSectionHtml(order, otherName) {
  if (!otherName) return "";
  const isOpen = openChatIds.has(order.id);
  return `
    <div class="chat-block">
      <button type="button" class="chat-toggle" data-chat-id="${order.id}" data-other-name="${escapeHtml(otherName)}">
        💬 ${isOpen ? "Hide messages" : `Message ${escapeHtml(otherName)}`}
      </button>
      <div class="chat-thread-wrap ${isOpen ? "open" : ""}" id="chat-wrap-${order.id}">
        <div class="chat-thread-inner">
          <div class="chat-thread">
            <div class="chat-messages" id="chat-messages-${order.id}"></div>
            <form class="chat-form" data-order-id="${order.id}">
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
  container.querySelectorAll("[data-chat-id]").forEach((btn) => {
    const id = Number(btn.dataset.chatId);
    btn.onclick = () => {
      const wrap = document.getElementById(`chat-wrap-${id}`);
      if (openChatIds.has(id)) {
        openChatIds.delete(id);
        wrap.classList.remove("open");
        btn.textContent = `💬 Message ${btn.dataset.otherName}`;
      } else {
        openChatIds.add(id);
        wrap.classList.add("open");
        btn.textContent = "💬 Hide messages";
        loadChatMessages(id, currentUserId);
      }
    };
    if (openChatIds.has(id)) loadChatMessages(id, currentUserId);
  });

  container.querySelectorAll("form[data-order-id]").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const id = Number(form.dataset.orderId);
      const input = form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      try {
        await api(`/api/orders/${id}/messages`, { method: "POST", body: { text } });
        input.value = "";
        await loadChatMessages(id, currentUserId);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        input.disabled = false;
        input.focus();
      }
    };
  });
}

async function loadChatMessages(orderId, currentUserId) {
  const box = document.getElementById(`chat-messages-${orderId}`);
  if (!box) return;
  try {
    const { messages } = await api(`/api/orders/${orderId}/messages`);
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
