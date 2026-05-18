#!/usr/bin/env node
/**
 * OceanBus Console — Multi-User Cloud Backend
 *
 * Single deployment, serves all users. Identity = OB keypair (no login).
 *
 *   H5 (browser) ←── SSE/HTTP ──→ Cloud ──OB──→ Agent
 *
 * Data partitioned by h5_openid:
 *   users[h5OpenId] = { peers, windows, messageQueues, sseClients }
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.OB_CONSOLE_PORT || "3456", 10);
const H5_DIR = path.join(__dirname, "..", "h5");
const STATE_DIR = path.join(os.homedir(), ".oceanbus-console");

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
const users = new Map(); // h5OpenId → { peers, windows, sse, boardOpenId }
let cloudOpenId = ""; // set after OB identity creation

function deriveBoardOpenId(cloudId, uuid) {
  return require('crypto').createHash('sha256').update(cloudOpenId + ':' + uuid).digest('hex');
}

function getUser(h5OpenId) {
  // Bootstrapping: if user connects with UUID before openid is assigned,
  // derive the openid and migrate to openid-based key.
  let key = h5OpenId;
  if (h5OpenId.length < 40 && cloudOpenId) {
    const derived = deriveBoardOpenId(cloudOpenId, h5OpenId);
    if (users.has(h5OpenId)) {
      const existing = users.get(h5OpenId);
      users.delete(h5OpenId);
      if (!existing.boardOpenId) existing.boardOpenId = derived;
      users.set(derived, existing);
    }
    key = derived;
  }
  if (!users.has(key)) {
    users.set(key, {
      peers: {},
      windows: new Map(),
      sse: new Set(),
      boardOpenId: key,
    });
  }
  return users.get(key);
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

  // 1. Cloud OB identity (fresh each restart)
  log("Creating Cloud OB identity...");
  const oceanbus = await import("oceanbus");
  const ob = await oceanbus.createOceanBus({ keyStore: { type: "memory" } });
  await ob.createIdentity();
  cloudOpenId = await ob.getAddress();
  log(`Cloud OB: ${cloudOpenId.slice(0, 8)}...`);

  // 2. OB listener — Agent ↔ Cloud message channel
  ob.startListening(async (msg) => {
    if (msg.from_openid === cloudOpenId) return;
    let parsed;
    try { parsed = JSON.parse(msg.content || "{}"); } catch { parsed = { text: msg.content || "" }; }
    const action = parsed.action || parsed.type;
    const h5openid = parsed.h5_openid || "";
    const user = h5openid ? getUser(h5openid) : null;
    if (!user) return;

    if (action === "window-open") {
      const win = parsed.window || "";
      if (win) {
        user.windows.set(win, { lastBeat: Date.now(), cwd: parsed.cwd || "", status: "online" });
        if (parsed.agent_openid) {
          const peerName = parsed.agent_name || win;
          user.peers[peerName] = { openid: parsed.agent_openid, boundAt: new Date().toISOString() };
          sseBroadcastForUser(user, "bound", { agent: peerName, openid: parsed.agent_openid });
        }
        sseBroadcastForUser(user, "windows", getWindows(user));
        log(`[ob] window + ${win}`);
      }
    } else if (action === "heartbeat") {
      const win = parsed.window || "";
      const newName = parsed.newname;
      if (newName && newName !== win && user.windows.has(win) && !user.windows.has(newName)) {
        user.windows.set(newName, { ...user.windows.get(win), lastBeat: Date.now(), status: "online" });
        user.windows.delete(win);
      } else if (user.windows.has(win)) {
        user.windows.get(win).lastBeat = Date.now();
        user.windows.get(win).status = "online";
      }
    } else if (action === "window-close") {
      user.windows.delete(parsed.window || "");
      sseBroadcastForUser(user, "windows", getWindows(user));
    } else if (action === "message" || action === "reply") {
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      sseBroadcastForUser(user, "message", {
        window: parsed.window || "", text: parsed.text || "",
        from: "agent", time, msg_id: parsed.msg_id || "",
      });
    }
  });
  log("OB listener started");

  // 3. HTTP Server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }

    // Extract user context from body or query
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
          cloudOpenId: cloudOpenId.slice(0, 12) + "...",
          users: users.size,
          uptime: process.uptime(),
        });
      }

      // ── API: Identity ─────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/identity") {
        return json(res, { openid: cloudOpenId });
      }

      // Static files don't need user context
      if (!user && !url.pathname.startsWith("/api/")) {
        serveStatic(req, res);
        return;
      }

      if (!user) {
        // API endpoints that don't need user context
        if (req.method === "GET" && (url.pathname === "/api/status" || url.pathname === "/api/identity")) {
          // continue below
        } else {
          return json(res, { error: "missing h5_openid. Create identity on H5 first." }, 400);
        }
      }

      // ── API: Board Address (per-user OB openid) ─────────────
      if (req.method === "GET" && url.pathname === "/api/my-address") {
        if (!user.boardOpenId) {
          user.boardOpenId = deriveBoardOpenId(cloudOpenId, h5openid);
        }
        return json(res, { openid: user.boardOpenId });
      }

      // ── API: Peers ────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/peers") {
        return json(res, Object.entries(user.peers).map(([k, v]) => ({ name: k, ...v })));
      }

      // ── API: Windows ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/windows") {
        return json(res, getWindows(user));
      }

      // ── API: Send (H5 → Agent via OB) ──────────────────────
      if (req.method === "POST" && url.pathname === "/api/send") {
        const { window: win, text } = body;
        if (!text) return json(res, { error: "missing text" }, 400);

        // Find first bound agent → OB send
        const peerNames = Object.keys(user.peers);
        if (peerNames.length === 0) return json(res, { error: "no bound agent" }, 400);
        const peer = user.peers[peerNames[0]];

        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        const msgObj = { action: "message", window: win || "", text, from: "h5", time, msg_id: body.msg_id || "", h5_openid: h5openid };

        // OB send — the only message path
        ob.send(peer.openid, JSON.stringify(msgObj)).catch((e) => log(`OB send failed: ${e.message}`));

        sseBroadcastForUser(user, "message", { window: win || "", text, from: "h5", time, msg_id: body.msg_id || "" });
        return json(res, { ok: true });
      }

      // /api/reply removed — all Agent→Cloud communication now goes through OB.
      // CC AI uses reply-ob.cjs → OB send → Cloud OB listener handles 'reply' action → SSE → H5

      // ── Static ─────────────────────────────────────────────
      serveStatic(req, res);

    } catch (e) {
      log(`error: ${e.message}`);
      json(res, { error: "internal" }, 500);
    }
  });

  server.listen(PORT, () => {
    log(`Multi-user Cloud: http://localhost:${PORT}`);
    log(`  Identity: ${cloudOpenId.slice(0, 8)}...`);
    log(`  H5: http://localhost:${PORT}`);
    log(`  Guide: http://localhost:${PORT}/guide.html`);
  });

  // Heartbeat eviction
  setInterval(() => {
    for (const [, user] of users) getWindows(user);
  }, 15_000).unref();
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
