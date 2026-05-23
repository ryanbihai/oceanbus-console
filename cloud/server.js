#!/usr/bin/env node
/**
 * OceanBus Console — Multi-User Cloud Backend
 *
 * Each Board user gets their own OB identity (real keypair).
 * Cloud holds the private key and listens on behalf of the Board.
 * Agents send OB messages directly to the Board's OB openid.
 *
 *   H5 (browser) ←── SSE/HTTP ──→ Cloud ──OB──→ Agent
 *
 * Data partitioned by h5_openid (UUID):
 *   users[h5OpenId] = { peers, windows, windowAgents, sse, boardOpenId }
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.OB_CONSOLE_PORT || "3456", 10);
const H5_DIR = path.join(__dirname, "..", "h5");
const STATE_DIR = path.join(os.homedir(), ".oceanbus-console");
const STATE_FILE = path.join(STATE_DIR, "sessions.json");

// ── MIME ───────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
};

// ── Helpers ─────────────────────────────────────────────────
function log(msg) { process.stderr.write(`[cloud] ${msg}\n`); }
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}
function loadJSON(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf-8")) : null; } catch { return null; } }
function saveJSON(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); } catch { resolve({}); }
    });
  });
}

// ── Multi-user state ────────────────────────────────────────
const users = new Map();   // h5_openid (UUID) → { peers, windows, windowAgents, sse, boardOpenId }
const boardObs = new Map(); // h5_openid → { ob, openid, credentials }

async function getOrCreateBoardOb(h5openid, oceanbus) {
  if (boardObs.has(h5openid)) return boardObs.get(h5openid);

  const credFile = path.join(STATE_DIR, 'users', h5openid, 'ob-identity.json');
  let credentials = loadJSON(credFile);
  let ob, openid;

  if (credentials?.agent_id && credentials?.encryption_key) {
    ob = await oceanbus.createOceanBus({
      keyStore: { type: 'memory' },
      identity: { agent_id: credentials.agent_id, api_key: credentials.api_key, openid: credentials.openid, encryption_key: credentials.encryption_key },
    });
    openid = credentials.openid || await ob.getAddress();
    log(`Board OB: ${openid.slice(0, 8)}... (restored for ${h5openid.slice(0, 8)}...)`);
  } else {
    ob = await oceanbus.createOceanBus({ keyStore: { type: 'memory' } });
    await ob.createIdentity();
    openid = await ob.getAddress();
    const state = ob.identity.exportState();
    credentials = { agent_id: state.agent_id, api_key: state.api_key, openid, encryption_key: state.encryption_key };
    saveJSON(credFile, credentials);
    log(`Board OB: ${openid.slice(0, 8)}... (new for ${h5openid.slice(0, 8)}...)`);
  }

  const entry = { ob, openid, credentials };
  boardObs.set(h5openid, entry);

  // OB listener — this Board's messages from Agents
  ob.startListening(async (msg) => {
    if (msg.from_openid === openid) return;
    let parsed;
    try { parsed = JSON.parse(msg.content || '{}'); } catch { parsed = { text: msg.content || '' }; }
    const action = parsed.action || parsed.type;
    const user = users.get(h5openid);
    if (!user) return;

    if (action === 'window-open') {
      const win = parsed.window || '';
      if (win) {
        user.windows.set(win, { lastBeat: Date.now(), cwd: parsed.cwd || '', status: 'online' });
        if (parsed.agent_openid) {
          const peerName = parsed.agent_name || win;
          user.peers[peerName] = { openid: parsed.agent_openid, boundAt: new Date().toISOString() };
          user.windowAgents[win] = parsed.agent_openid;
          sseBroadcastForUser(user, 'bound', { agent: peerName, openid: parsed.agent_openid });
        }
        sseBroadcastForUser(user, 'windows', getWindows(user));
        log(`[ob] window + ${win}`);
      }
    } else if (action === 'heartbeat') {
      const win = parsed.window || '';
      const newName = parsed.newname;
      if (newName && newName !== win && user.windows.has(win) && !user.windows.has(newName)) {
        user.windows.set(newName, { ...user.windows.get(win), lastBeat: Date.now(), status: 'online' });
        user.windows.delete(win);
      } else if (user.windows.has(win)) {
        user.windows.get(win).lastBeat = Date.now();
        user.windows.get(win).status = 'online';
      }
      // Re-register agent if Cloud restarted and lost windowAgents
      if (parsed.agent_openid && !user.windowAgents[win]) {
        user.windowAgents[win] = parsed.agent_openid;
        user.peers[win] = { openid: parsed.agent_openid, boundAt: new Date().toISOString() };
      }
    } else if (action === 'window-close') {
      const closeWin = parsed.window || '';
      user.windows.delete(closeWin);
      delete user.windowAgents[closeWin];
      sseBroadcastForUser(user, 'windows', getWindows(user));
    } else if (action === 'message' || action === 'reply') {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      sseBroadcastForUser(user, 'message', {
        window: parsed.window || '', text: parsed.text || '',
        from: 'agent', time, msg_id: parsed.msg_id || '',
      });
    }
  });

  return entry;
}

function getUser(h5OpenId) {
  if (!users.has(h5OpenId)) {
    users.set(h5OpenId, {
      peers: {},
      windows: new Map(),
      windowAgents: {},
      sse: new Set(),
      boardOpenId: '',
    });
  }
  return users.get(h5OpenId);
}

function getWindows(user) {
  const now = Date.now();
  for (const [name, w] of user.windows) {
    if (w.status === "online" && now - w.lastBeat > 30_000) w.status = "offline";
  }
  return [...user.windows.entries()].map(([name, w]) => ({ name, ...w }));
}

function sseBroadcastForUser(user, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of user.sse) {
    try { c.write(msg); } catch { user.sse.delete(c); }
  }
}

// ── Static serve ────────────────────────────────────────────
function serveStatic(req, res) {
  let fp = req.url === "/" ? "/index.html" : req.url;
  fp = path.normalize(fp).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(H5_DIR, fp);
  if (!fullPath.startsWith(H5_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  const ext = path.extname(fullPath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(H5_DIR, "index.html"), (e2, d2) => {
        res.writeHead(e2 ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(e2 ? "Not Found" : d2);
      });
    } else {
      res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
      res.end(data);
    }
  });
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const oceanbus = await import("oceanbus");

  // 1. Restore persisted users and their OB identities
  const saved = loadJSON(STATE_FILE);
  if (saved?.users) {
    for (const [h5openid, userData] of Object.entries(saved.users)) {
      const user = getUser(h5openid);
      user.peers = userData.peers || {};
      user.windowAgents = userData.windowAgents || {};
      // Restore OB identity for each known user
      try {
        await getOrCreateBoardOb(h5openid, oceanbus);
      } catch (e) {
        log(`Failed to restore OB identity for ${h5openid.slice(0, 8)}...: ${e.message}`);
      }
    }
    log(`restored ${Object.keys(saved.users).length} user(s) with OB identities`);
  }

  // 2. HTTP Server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }

    function getH5OpenId(body, query) {
      return (body && body.h5_openid) || query.get("h5_openid") || "";
    }

    try {
      const body = req.method === "POST" ? await parseBody(req) : {};
      const h5openid = getH5OpenId(body, url.searchParams);
      const user = h5openid ? getUser(h5openid) : null;

      // ── SSE ───────────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/events") {
        if (!h5openid) return json(res, { error: "missing h5_openid" }, 400);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("event: connected\ndata: {}\n\n");
        user.sse.add(res);
        req.on("close", () => user.sse.delete(res));
        return;
      }

      // ── API: Status ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, {
          ok: true,
          users: users.size,
          boardObs: boardObs.size,
          uptime: process.uptime(),
        });
      }

      // ── API: Identity (SDK bootstrap — backward compat) ──
      if (req.method === "GET" && (url.pathname === "/identity" || url.pathname === "/api/identity")) {
        // If h5_openid provided, return that user's OB openid
        if (h5openid) {
          const { openid } = await getOrCreateBoardOb(h5openid, oceanbus);
          user.boardOpenId = openid;
          return json(res, { openid });
        }
        // Fallback: return first available (backward compat for SDK)
        if (boardObs.size > 0) {
          const first = boardObs.values().next().value;
          return json(res, { openid: first.openid });
        }
        return json(res, { error: "no board identity yet. Open H5 Board first." }, 400);
      }

      // Static files don't need user context
      if (!user && !url.pathname.startsWith("/api/")) {
        serveStatic(req, res);
        return;
      }

      if (!user) {
        return json(res, { error: "missing h5_openid. Create identity on H5 first." }, 400);
      }

      // ── API: Board Address (Board's real OB openid) ─────
      if (req.method === "GET" && url.pathname === "/api/my-address") {
        const { openid } = await getOrCreateBoardOb(h5openid, oceanbus);
        user.boardOpenId = openid;
        return json(res, { openid });
      }

      // ── API: Peers ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/peers") {
        return json(res, Object.entries(user.peers).map(([k, v]) => ({ name: k, ...v })));
      }

      // ── API: Windows ────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/windows") {
        return json(res, getWindows(user));
      }

      // ── API: Send (H5 → Agent via OB) ──────────────────
      if (req.method === "POST" && url.pathname === "/api/send") {
        const { window: win, text } = body;
        if (!text) return json(res, { error: "missing text" }, 400);

        const targetWin = win || "";
        const agentOpenId = (targetWin && user.windowAgents[targetWin])
          || (Object.keys(user.windowAgents).length > 0 ? Object.values(user.windowAgents)[0] : null);
        if (!agentOpenId) return json(res, { error: "no bound agent for this window" }, 400);

        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        const msgObj = { action: "message", window: win || "", text, from: "h5", time, msg_id: body.msg_id || "", h5_openid: h5openid };

        // Use this Board's OB identity to send
        const { ob } = await getOrCreateBoardOb(h5openid, oceanbus);
        ob.send(agentOpenId, JSON.stringify(msgObj)).catch((e) => log(`OB send failed: ${e.message}`));

        sseBroadcastForUser(user, "message", { window: win || "", text, from: "h5", time, msg_id: body.msg_id || "" });
        return json(res, { ok: true });
      }

      // ── Static ──────────────────────────────────────────
      serveStatic(req, res);

    } catch (e) {
      log(`error: ${e.message}`);
      json(res, { error: "internal" }, 500);
    }
  });

  server.listen(PORT, () => {
    log(`Multi-user Cloud: http://localhost:${PORT}`);
    log(`  Boards: ${boardObs.size} OB identities loaded`);
    log(`  H5: http://localhost:${PORT}`);
  });

  // Heartbeat eviction + session persistence
  setInterval(() => {
    for (const [, user] of users) getWindows(user);
    const state = { savedAt: new Date().toISOString(), users: {} };
    for (const [key, user] of users) {
      state.users[key] = {
        peers: user.peers,
        windowAgents: user.windowAgents || {},
      };
    }
    if (Object.keys(state.users).length > 0) saveJSON(STATE_FILE, state);
  }, 30_000).unref();
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
