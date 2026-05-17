/**
 * OceanBus Console — Multi-User H5 App
 *
 * Identity: UUID v4 → localStorage (future: OB keypair via Web Crypto)
 * All API calls include h5_openid for user partitioning.
 */

const G = ""; // relative API paths
let sse = null;
let activeWindow = null;
let peers = {};    // { name: { openid, boundAt } }
let windows = [];  // [{ name, status, cwd, lastBeat }]
let myOpenId = ""; // this H5 user's identity

// ── Identity (UUID v4, stored in localStorage) ──────────────
function loadIdentity() {
  let id = localStorage.getItem("ob-h5-openid");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("ob-h5-openid", id);
  }
  return id;
}

// ── Shortcuts ─────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("show"); setTimeout(() => e.classList.remove("show"), 2500); }

// ── API (auto-includes h5_openid) ────────────────────────────
async function api(path, opts = {}) {
  let fullPath = G + path;
  if (!fullPath.includes("h5_openid=")) {
    fullPath += (fullPath.includes("?") ? "&" : "?") + "h5_openid=" + myOpenId;
  }
  const res = await fetch(fullPath, opts);
  return res.json();
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  myOpenId = loadIdentity();
  console.log("H5 identity:", myOpenId.slice(0, 8) + "...");

  // SSE with user context
  sse = new EventSource(G + "/api/events?h5_openid=" + myOpenId);
  sse.addEventListener("connected", () => console.log("SSE connected"));
  sse.addEventListener("windows",  (e) => { windows = JSON.parse(e.data); renderWindows(); renderMain(); });
  sse.addEventListener("message",  (e) => onMsg(JSON.parse(e.data)));
  sse.addEventListener("bound",    (e) => { loadPeers(); toast("Agent 绑定成功!"); });
  sse.onerror = () => {}; // auto-reconnect

  await loadPeers();
  await loadWindows();
  renderWindows();
  renderMain();

  $("msg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });
}

// ── Peers ──────────────────────────────────────────────────────
async function loadPeers() {
  try { peers = (await api("/api/peers")).reduce((acc, p) => { acc[p.name] = p; return acc; }, {}); }
  catch { peers = {}; }
  renderPeers();
}

// ── Windows ────────────────────────────────────────────────────
async function loadWindows() {
  try { windows = await api("/api/windows"); } catch { windows = []; }
}

function renderWindows() {
  const list = $("window-list");
  const online = windows.filter(w => w.status === "online");
  const offline = windows.filter(w => w.status !== "online");

  if (online.length === 0 && offline.length === 0) {
    list.innerHTML = '<div class="note">暂无窗口。<br>在 CC 中绑定 Agent 后出现</div>';
    return;
  }

  list.innerHTML = [
    ...online.map(w => `<div class="window-item${activeWindow===w.name?' active':''}" onclick="selectWindow('${w.name}')">
      <span class="window-status ws-online"></span>
      <span class="window-name">${esc(w.name)}</span>
    </div>`),
    ...offline.map(w => `<div class="window-item" onclick="toast('${esc(w.name)} 已离线')">
      <span class="window-status ws-offline"></span>
      <span class="window-name" style="color:#64748b">${esc(w.name)}</span>
    </div>`),
  ].join("");
}

function renderPeers() {
  const list = $("agent-list");
  const names = Object.keys(peers);
  if (names.length === 0) {
    list.innerHTML = '<div class="note">暂无绑定</div>';
  } else {
    list.innerHTML = names.map(n => {
      const shortId = peers[n].openid.slice(0, 6);
      return `<div class="agent-item">
        <span>🖥</span>
        <span class="agent-name">${esc(n)}</span>
        <span style="font-size:10px;color:var(--text-dim)">${shortId}...</span>
      </div>`;
    }).join("");
  }
}

function selectWindow(name) {
  activeWindow = name;
  renderWindows();
  renderMain();
  loadMessages(name);
}

// ── Messages ──────────────────────────────────────────────────
const messageStore = {}; // windowName → [{from, text, time, id}]
const seenMsgIds = new Set();
let msgIdCtr = 0;

function onMsg(data) {
  if (data.msg_id && seenMsgIds.has(data.msg_id)) return;
  if (data.msg_id) seenMsgIds.add(data.msg_id);

  const win = data.window || "";
  if (!messageStore[win]) messageStore[win] = [];
  const mid = data.msg_id || ("sse_" + (++msgIdCtr));
  messageStore[win].push({ from: data.from, text: data.text, time: data.time || now(), id: mid });

  if (activeWindow === win) {
    addBubble(data.from === "h5" ? "h5" : "agent", data.text, data.time, mid);
  }
  if (!activeWindow && win) {
    activeWindow = win;
    renderWindows();
    renderMain();
    loadMessages(win);
  }
}

async function loadMessages(win) {
  const container = $("messages");
  if (!container) return;
  container.innerHTML = "";
  const msgs = messageStore[win] || [];
  msgs.forEach(m => addBubble(m.from === "h5" ? "h5" : "agent", m.text, m.time));
  container.scrollTop = container.scrollHeight;
}

function addBubble(from, text, time) {
  const container = $("messages");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "msg msg-" + from;
  const sender = from === "h5" ? "你" : "Agent";
  div.innerHTML = `<div class="msg-sender">${sender}</div><div>${escHtml(text)}</div><div class="msg-time">${time||now()}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Send ────────────────────────────────────────────────────────
async function sendMsg() {
  if (!activeWindow) { toast("请先选择窗口"); return; }
  const peerNames = Object.keys(peers);
  if (peerNames.length === 0) { toast("请先绑定 Agent"); return; }

  const input = $("msg-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  const mid = "h5_" + (++msgIdCtr);
  seenMsgIds.add(mid);
  addBubble("h5", text, now(), mid);

  try {
    await api("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ h5_openid: myOpenId, window: activeWindow, text, agent: peerNames[0], msg_id: mid }),
    });
  } catch (e) { toast("发送失败: " + e.message); }
}

// ── Render main ─────────────────────────────────────────────────
function renderMain() {
  if (activeWindow) {
    $("input-bar").classList.remove("hidden");
    $("main-header").innerHTML = `<button class="menu-btn" onclick="toggleSidebar()">☰</button>
      <span style="font-size:20px">💬</span><div>
      <div class="title">${esc(activeWindow)}</div><div class="meta">已连接</div></div>`;
    $("msg-container").innerHTML = '<div class="messages" id="messages"></div>';
    loadMessages(activeWindow);
  } else {
    $("input-bar").classList.add("hidden");
    $("main-header").innerHTML = `<button class="menu-btn" onclick="toggleSidebar()">☰</button>
      <span style="font-size:24px">📡</span><div>
      <div class="title">OceanBus Console</div><div class="meta">选择一个窗口开始对话</div></div>`;
    $("msg-container").innerHTML = '<div class="placeholder">点击左侧窗口或绑定 Agent</div>';
  }
}

// ── Pairing ─────────────────────────────────────────────────────
async function startPairing() {
  $("pairing-modal").classList.remove("hidden");
  $("pairing-cmd").textContent = "加载中...";

  try {
    const gwUrl = window.location.origin || "http://localhost:3456";
    // Peer is THIS H5 user's identity — Cloud routes by h5_openid
    $("pairing-cmd").textContent = `npx oceanbus@latest start --peer ${myOpenId} --gateway-url ${gwUrl}`;
  } catch (e) {
    $("pairing-cmd").textContent = "加载失败";
    toast("获取身份失败");
  }
}

function closePairing() {
  $("pairing-modal").classList.add("hidden");
}

function copyCmd() {
  const text = $("pairing-cmd").textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast("已复制!"));
  } else {
    prompt("复制以下命令:", text);
  }
}

// ── Sidebar ──────────────────────────────────────────────────
function toggleSidebar() {
  const sb = $("sidebar");
  sb.classList.toggle("open");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
}

// ── Utils ──────────────────────────────────────────────────────
function now() { return new Date().toLocaleTimeString("zh-CN", { hour12: false }); }
function esc(s) { return (s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function escHtml(s) { return (s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

init();
