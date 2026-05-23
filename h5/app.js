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
let myOpenId = ""; // UUID for Cloud API calls (h5_openid)
let myBoardObId = ""; // Board's real OB openid for Agent pairing (--peer)

// ── Identity (UUID v4, stored in localStorage) ──────────────
function generateUUID() {
  // crypto.randomUUID() may be unavailable on HTTP (non-localhost)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* fall through */ }
  }
  // Fallback: RFC 4122 v4 UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function loadIdentity() {
  // UUID for Cloud API calls — always use the stored UUID
  let uuid = localStorage.getItem("ob-h5-openid");
  if (!uuid) {
    uuid = generateUUID();
    localStorage.setItem("ob-h5-openid", uuid);
  }
  return uuid;
}

async function loadBoardObId() {
  // Board's real OB openid for Agent pairing
  let obId = localStorage.getItem("ob-board-openid");
  // Migration: old SHA256 hashes are 64 hex chars, real OB openids are not
  if (obId && obId.length !== 64) return obId;

  // Fetch (or re-fetch after migration) from Cloud
  const uuid = localStorage.getItem("ob-h5-openid");
  if (!uuid) return '';
  try {
    const res = await fetch(G + "/api/my-address?h5_openid=" + uuid);
    const data = await res.json();
    if (data.openid) {
      localStorage.setItem("ob-board-openid", data.openid);
      return data.openid;
    }
  } catch { /* Cloud unreachable, fall back */ }
  return obId || '';
}

// ── Messages ──────────────────────────────────────────────────
const messageStore = {}; // windowName → [{from, text, time, id}]
const seenMsgIds = new Set();
let msgIdCtr = 0;

// ── Message Persistence (localStorage) ────────────────────────
const MSG_PREFIX = "ob-msgs-";
const MSG_KEYS_KEY = "ob-msg-keys";
const MAX_MSGS = 500;

function persistMessages(win) {
  const msgs = messageStore[win] || [];
  try {
    localStorage.setItem(MSG_PREFIX + win, JSON.stringify(msgs));
    const keys = JSON.parse(localStorage.getItem(MSG_KEYS_KEY) || "[]");
    if (!keys.includes(win)) {
      keys.push(win);
      localStorage.setItem(MSG_KEYS_KEY, JSON.stringify(keys));
    }
  } catch {
    if (msgs.length > 100) {
      messageStore[win] = msgs.slice(-100);
      try { localStorage.setItem(MSG_PREFIX + win, JSON.stringify(messageStore[win])); } catch {}
    }
  }
}

function loadPersistedMessages() {
  try {
    const keys = JSON.parse(localStorage.getItem(MSG_KEYS_KEY) || "[]");
    keys.forEach(win => {
      const raw = localStorage.getItem(MSG_PREFIX + win);
      if (raw) {
        const msgs = JSON.parse(raw);
        messageStore[win] = msgs.slice(-MAX_MSGS);
        msgs.forEach(m => { if (m.id) seenMsgIds.add(m.id); });
      }
    });
  } catch {}
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
  myOpenId = await loadIdentity();
  myBoardObId = await loadBoardObId();
  $("sidebar-id").textContent = "ID: " + myOpenId.slice(0, 12) + "...";
  loadPersistedMessages();
  document.body.classList.remove("chat-open");
  console.log("H5 identity:", myOpenId.slice(0, 8) + "...", "OB:", myBoardObId.slice(0, 8) + "...");

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

function lastMsgPreview(win) {
  const msgs = messageStore[win];
  if (!msgs || msgs.length === 0) return "";
  const m = msgs[msgs.length - 1];
  const prefix = m.from === "h5" ? "你: " : "";
  const txt = prefix + m.text;
  return txt.length > 30 ? txt.slice(0, 30) + "..." : txt;
}

function renderWindows() {
  const list = $("window-list");
  const online = windows.filter(w => w.status === "online");

  if (online.length === 0) {
    list.innerHTML = '<div class="note">暂无活跃窗口。<br><br>点击下方「+ 绑定 Agent」<br>复制命令到 CC 终端粘贴运行<br><br>或点击右上角 <b>?</b> 查看完整说明</div>';
    return;
  }

  list.innerHTML = online.map(w => {
    const preview = lastMsgPreview(w.name);
    return `<div class="window-item${activeWindow===w.name?' active':''}" onclick="selectWindow('${w.name}')">
      <span class="window-status ws-online"></span>
      <div class="window-info">
        <span class="window-name">${esc(w.name)}</span>
        ${preview ? `<span class="window-lastmsg">${esc(preview)}</span>` : ""}
      </div>
    </div>`;
  }).join("");
}

function renderPeers() {
  // Peer data rendered as window list items instead (windows = agents)
  // Internal peers map used by sendMsg()
}

function selectWindow(name) {
  activeWindow = name;
  if (name) document.body.classList.add("chat-open");
  renderWindows();
  renderMain();
  if (name) loadMessages(name);
}

function goBack() {
  activeWindow = null;
  document.body.classList.remove("chat-open");
  renderWindows();
  renderMain();
}

function onMsg(data) {
  if (data.msg_id && seenMsgIds.has(data.msg_id)) return;
  if (data.msg_id) seenMsgIds.add(data.msg_id);

  const win = data.window || "";
  if (!messageStore[win]) messageStore[win] = [];
  const mid = data.msg_id || ("sse_" + (++msgIdCtr));
  messageStore[win].push({ from: data.from, text: data.text, time: data.time || now(), id: mid });
  persistMessages(win);

  if (activeWindow === win) {
    addBubble(data.from === "h5" ? "h5" : "agent", data.text, data.time, mid);
  }
  if (!activeWindow && win) {
    activeWindow = win;
    document.body.classList.add("chat-open");
    renderWindows();
    renderMain();
    loadMessages(win);
  }
  renderWindows();
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

  if (!messageStore[activeWindow]) messageStore[activeWindow] = [];
  messageStore[activeWindow].push({ from: "h5", text, time: now(), id: mid });
  persistMessages(activeWindow);
  renderWindows();

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
    $("main-header").innerHTML = `<button class="back-btn" onclick="goBack()">←</button>
      <button class="menu-btn" onclick="toggleSidebar()">☰</button>
      <span style="font-size:20px">💬</span><div>
      <div class="title">${esc(activeWindow)}</div><div class="meta">已连接</div></div>`;
    $("msg-container").innerHTML = '<div class="messages" id="messages"></div>';
    loadMessages(activeWindow);
  } else {
    $("input-bar").classList.add("hidden");
    $("main-header").innerHTML = `<button class="back-btn" onclick="goBack()">←</button>
      <button class="menu-btn" onclick="toggleSidebar()">☰</button>
      <span style="font-size:24px">📡</span><div>
      <div class="title">OceanBus Console</div><div class="meta">选择一个窗口开始对话</div></div>`;
    $("msg-container").innerHTML = '<div class="placeholder">点击左侧窗口或绑定 Agent</div>';
  }
}

// ── Pairing ─────────────────────────────────────────────────────
async function startPairing() {
  // Ensure identity is loaded (defensive: button may be clicked before init completes)
  if (!myOpenId) myOpenId = await loadIdentity();
  if (!myBoardObId) myBoardObId = await loadBoardObId();

  $("pairing-modal").classList.remove("hidden");
  $("pairing-cmd").textContent = "加载中...";

  try {
    const gwUrl = window.location.origin;
    // --peer uses Board's real OB openid (myBoardObId), not the UUID
    $("pairing-cmd").textContent = `mkdir -p ~/.oceanbus && echo '{"peer":"${myBoardObId}"}' > ~/.oceanbus/console-peer.json && echo '{"url":"${gwUrl}"}' > ~/.oceanbus/console-gateway.json && npx oceanbus@latest start --peer ${myBoardObId} --gateway-url ${gwUrl} --temp-identity`;
  } catch (e) {
    $("pairing-cmd").textContent = "加载失败";
    toast("获取身份失败");
  }
}

function closePairing() {
  $("pairing-modal").classList.add("hidden");
}

function showHelp() {
  $("help-modal").classList.remove("hidden");
}
function closeHelp() {
  $("help-modal").classList.add("hidden");
}

function copyCmd() {
  const text = $("pairing-cmd").textContent;
  // Try modern clipboard API first (works on HTTPS / localhost)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("已复制!")).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  // Use visibility/opacity instead of off-screen positioning (more reliable on mobile)
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;width:1px;height:1px';
  ta.readOnly = true;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  toast(ok ? '已复制!' : '复制失败，请手动复制');
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
