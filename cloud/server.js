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
const CREDS_FILE = path.join(STATE_DIR, "cloud-creds.json");

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
const users = new Map(); // h5OpenId → { peers, windows, queues, sse }

function getUser(h5OpenId) {
  if (!users.has(h5OpenId)) {
    users.set(h5OpenId, {
      peers: {},
      windows: new Map(),  // windowName → { lastBeat, cwd, status }
      queues: {},          // windowName → [{action,text,from,time,...}]
      sse: new Set(),
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

  // 1. Cloud OB identity
  let creds = loadJSON(CREDS_FILE);
  if (!creds) {
    log("Creating Cloud OB identity...");
    const oceanbus = await import("oceanbus");
    const ob = await oceanbus.createOceanBus({ keyStore: { type: "memory" } });
    const reg = await ob.createIdentity();
    const openid = await ob.getAddress();
    creds = { agent_id: reg.agent_id, api_key: reg.api_key, openid };
    saveJSON(CREDS_FILE, creds);
    await ob.destroy();
  }
  log(`Cloud OB: ${creds.openid.slice(0, 8)}...`);

  // 2. OB listener (receives from Agent → forwards to H5 via SSE)
  const oceanbus = await import("oceanbus");
  const ob = await oceanbus.createOceanBus({
    keyStore: { type: "memory" },
    identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid },
  });
  log(`OB listener started`);

  ob.startListening(async (msg) => {
    if (msg.from_openid === creds.openid) return;
    let parsed;
    try { parsed = JSON.parse(msg.content || "{}"); } catch { parsed = {}; }
    const action = parsed.action || parsed.type;

    if (action === "window-open" || action === "bound" || action === "heartbeat"
        || action === "window-close" || action === "message" || action === "reply") {
      // These are handled via HTTP /api/agent/announce with user context
      // OB listener serves as fallback only
      log(`[ob] ${action} from ${msg.from_openid.slice(0, 8)}...`);
    }
  });

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

      // ── SSE broadcast helper ──────────────────────────────
      function sseBroadcast(user, event, data) {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const c of user.sse) {
          try { c.write(msg); } catch { user.sse.delete(c); }
        }
      }

      // ── API: Status ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, {
          ok: true,
          cloudOpenId: creds.openid.slice(0, 12) + "...",
          users: users.size,
          uptime: process.uptime(),
        });
      }

      // ── API: Identity ─────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/identity") {
        return json(res, { openid: creds.openid });
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

      // ── API: Peers ────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/peers") {
        return json(res, Object.entries(user.peers).map(([k, v]) => ({ name: k, ...v })));
      }

      // ── API: Windows ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/windows") {
        return json(res, getWindows(user));
      }

      // ── API: Send (H5 → Agent) ────────────────────────────
      if (req.method === "POST" && url.pathname === "/api/send") {
        const { window: win, text } = body;
        if (!text) return json(res, { error: "missing text" }, 400);

        // Find first bound agent
        const peerNames = Object.keys(user.peers);
        if (peerNames.length === 0) return json(res, { error: "no bound agent" }, 400);
        const peer = user.peers[peerNames[0]];

        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        const msgObj = { action: "message", window: win || "", text, from: "h5", time, msg_id: body.msg_id || "" };

        // Queue for Agent polling
        const qk = win || "__default";
        if (!user.queues[qk]) user.queues[qk] = [];
        user.queues[qk].push(msgObj);

        // Try OB send
        ob.send(peer.openid, JSON.stringify(msgObj)).catch(() => {});

        sseBroadcast(user, "message", { window: win || "", text, from: "h5", time, msg_id: body.msg_id || "" });
        return json(res, { ok: true });
      }

      // ── API: Reply (CC AI → H5) ───────────────────────────
      if (req.method === "POST" && url.pathname === "/api/reply") {
        const { window: win, text } = body;
        if (!text) return json(res, { error: "missing text" }, 400);
        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        sseBroadcast(user, "message", { window: win || "", text, from: "agent", time, msg_id: body.msg_id || "" });
        log(`[reply] → H5 [${win}] ${text.slice(0, 40)}`);
        return json(res, { ok: true });
      }

      // ── API: Poll (Agent → Cloud) ─────────────────────────
      if (req.method === "GET" && url.pathname === "/api/poll") {
        const win = url.searchParams.get("window") || "__default";
        const queue = user.queues[win] || [];
        const batch = queue.splice(0);
        return json(res, { messages: batch });
      }

      // ── API: Agent announce ────────────────────────────────
      if (req.method === "POST" && url.pathname === "/api/agent/announce") {
        const action = body.action;
        const win = body.window || "";

        if (action === "window-open" && win) {
          user.windows.set(win, { lastBeat: Date.now(), cwd: body.cwd || "", status: "online" });
          if (body.agent_openid) {
            const peerName = body.agent_name || win;
            user.peers[peerName] = { openid: body.agent_openid, boundAt: new Date().toISOString() };
            sseBroadcast(user, "bound", { agent: peerName, openid: body.agent_openid });
          }
          log(`[window] + ${win}`);
          sseBroadcast(user, "windows", getWindows(user));
          return json(res, { ok: true, action: "window-open" });
        }

        if (action === "heartbeat" && win) {
          const newName = body.newname;
          if (newName && newName !== win && user.windows.has(win) && !user.windows.has(newName)) {
            user.windows.set(newName, { ...user.windows.get(win), lastBeat: Date.now(), status: "online" });
            user.windows.delete(win);
            log(`[window] renamed ${win} → ${newName}`);
          } else if (user.windows.has(win)) {
            user.windows.get(win).lastBeat = Date.now();
            user.windows.get(win).status = "online";
          }
          sseBroadcast(user, "windows", getWindows(user));
          return json(res, { ok: true, action: "heartbeat" });
        }

        if (action === "window-close" && win) {
          user.windows.delete(win);
          sseBroadcast(user, "windows", getWindows(user));
          return json(res, { ok: true, action: "window-close" });
        }

        return json(res, { error: "unknown action" }, 400);
      }

      // ── Static ─────────────────────────────────────────────
      serveStatic(req, res);

    } catch (e) {
      log(`error: ${e.message}`);
      json(res, { error: "internal" }, 500);
    }
  });

  server.listen(PORT, () => {
    log(`Multi-user Cloud: http://localhost:${PORT}`);
    log(`  Identity: ${creds.openid.slice(0, 8)}...`);
    log(`  H5: http://localhost:${PORT}`);
    log(`  Guide: http://localhost:${PORT}/guide.html`);
  });

  // Heartbeat eviction
  setInterval(() => {
    for (const [, user] of users) getWindows(user);
  }, 15_000).unref();
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
