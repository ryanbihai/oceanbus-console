/**
 * OceanBus Console — H5 App
 *
 * SSE → Cloud → OB → Agent
 */

const G = ""; // relative API paths
let sse = null;
let activeWindow = null;
let peers = {};    // { name: { openid, boundAt } }
let windows = [];  // [{ name, status, cwd, lastBeat }]

// ── Shortcuts ─────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("show"); setTimeout(() => e.classList.remove("show"), 2500); }

// ── API ──────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(G + path, opts);
  return res.json();
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  // SSE
  sse = new EventSource(G + "/api/events");
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
    list.innerHTML = '<div class="note">暂无窗口。在 CC 中运行 npx oceanbus start</div>';
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
    list.innerHTML = '<div class="note">暂无绑定。点击下方按钮绑定 Agent</div>';
  } else {
    list.innerHTML = names.map(n => `<div class="agent-item">
      <span>🖥</span>
      <span class="agent-name">${esc(n)}</span>
      <span style="font-size:10px;color:#64748b">${peers[n].openid.slice(0,8)}...</span>
    </div>`).join("");
  }
}

function selectWindow(name) {
  activeWindow = name;
  renderWindows();
  renderMain();
  loadMessages(name);
}

// ── Messages ──────────────────────────────────────────────────
const messageStore = {}; // windowName → [{from, text, time}]

function onMsg(data) {
  const win = data.window || "";
  if (!messageStore[win]) messageStore[win] = [];
  messageStore[win].push({ from: data.from, text: data.text, time: data.time || now() });

  // If viewing this window, render
  if (activeWindow === win) {
    addBubble(data.from === "h5" ? "h5" : "agent", data.text, data.time);
  }

  // If not viewing any window, auto-switch
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

  addBubble("h5", text, now());

  try {
    await api("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ window: activeWindow, text, agent: peerNames[0] }),
    });
  } catch (e) { toast("发送失败: " + e.message); }
}

// ── Render main ─────────────────────────────────────────────────
function renderMain() {
  if (activeWindow) {
    $("input-bar").classList.remove("hidden");
    $("main-header").innerHTML = `<span style="font-size:20px">💬</span><div>
      <div class="title">${esc(activeWindow)}</div><div class="meta">已连接 · OB 加密</div></div>`;
    $("msg-container").innerHTML = '<div class="messages" id="messages"></div>';
    loadMessages(activeWindow);
  } else {
    $("input-bar").classList.add("hidden");
    $("main-header").innerHTML = `<span style="font-size:24px">📡</span><div>
      <div class="title">OceanBus Console</div><div class="meta">选择一个窗口开始对话</div></div>`;
    $("msg-container").innerHTML = '<div class="placeholder">👈 选择窗口或绑定 Agent</div>';
  }
}

// ── Pairing ─────────────────────────────────────────────────────
async function startPairing() {
  $("pairing-modal").classList.remove("hidden");
  $("pairing-code").textContent = "生成中...";
  $("pairing-cmd").textContent = "";

  try {
    const r = await api("/api/pairing", { method: "POST" });
    $("pairing-code").textContent = r.code;
    $("pairing-cmd").textContent = `npx oceanbus start --code ${r.code}`;
  } catch (e) {
    $("pairing-code").textContent = "失败";
    toast("生成配对码失败");
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

// ── Utils ──────────────────────────────────────────────────────
function now() { return new Date().toLocaleTimeString("zh-CN", { hour12: false }); }
function esc(s) { return (s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function escHtml(s) { return (s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

init();
