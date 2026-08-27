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

function renderNav(user) {
  const el = document.getElementById("nav");
  if (!el) return;
  const path = window.location.pathname;
  el.innerHTML = `
    <a class="brand" href="/order.html"><span class="paw">🐾</span> WildcatEats</a>
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
