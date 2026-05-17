#!/usr/bin/env node
/**
 * OceanBus Console — Cloud Backend
 *
 * Holds OB identity for H5 user. Relays messages between H5 (SSE+HTTP) and OB (P2P).
 * Also serves H5 static files and pairing API.
 *
 *   H5 (browser) ←── SSE/HTTP ──→ Cloud ──OB──→ Agent (CC)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.OB_CONSOLE_PORT || "3000", 10);
const H5_DIR = path.join(__dirname, "..", "h5");
const STATE_DIR = path.join(os.homedir(), ".oceanbus-console");
const CREDS_FILE = path.join(STATE_DIR, "cloud-creds.json");
const PEERS_FILE = path.join(STATE_DIR, "peers.json");

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

// ── Pairing codes ───────────────────────────────────────────
const pairings = new Map();
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return pairings.has(code) ? generateCode() : code;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pairings) { if (v.expiresAt < now) pairings.delete(k); }
}, 120_000).unref();

// ── Window tracking ─────────────────────────────────────────
const windows = new Map(); // windowName → { lastBeat, cwd, status: "online"|"offline" }
const WINDOW_TIMEOUT = 30_000;

function getWindows() {
  const now = Date.now();
  for (const [name, w] of windows) {
    if (w.status === "online" && now - w.lastBeat > WINDOW_TIMEOUT) w.status = "offline";
  }
  return [...windows.entries()].map(([name, w]) => ({ name, ...w }));
}

// ── SSE clients ─────────────────────────────────────────────
const sseClients = new Set();
function sseBroadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(msg); } catch { sseClients.delete(c); }
  }
}

// ── Serve static ────────────────────────────────────────────
function serveStatic(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(H5_DIR, filePath);
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

  // 1. Load or create OB identity
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

  // 2. Load peers (bound agents)
  let peers = loadJSON(PEERS_FILE) || {}; // { agentName: { openid, name, boundAt } }

  // 3. Start OB listener
  const oceanbus = await import("oceanbus");
  const ob = await oceanbus.createOceanBus({
    keyStore: { type: "memory" },
    identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid },
  });
  const myAddr = await ob.getAddress();
  log(`OB listener: ${myAddr.slice(0, 8)}... (matches stored: ${myAddr === creds.openid})`);

  ob.startListening(async (msg) => {
    if (msg.from_openid === creds.openid) return true;
    let parsed;
    try { parsed = JSON.parse(msg.content || "{}"); } catch { parsed = msg.content || {}; }

    const action = parsed.action || parsed.type;

    switch (action) {
      case "window-open": {
        windows.set(parsed.window, {
          lastBeat: Date.now(),
          cwd: parsed.cwd || "",
          status: "online",
        });
        log(`[window] + ${parsed.window}`);
        sseBroadcast("windows", getWindows());
        break;
      }
      case "window-close": {
        windows.delete(parsed.window);
        log(`[window] - ${parsed.window}`);
        sseBroadcast("windows", getWindows());
        break;
      }
      case "heartbeat": {
        if (windows.has(parsed.window)) {
          windows.get(parsed.window).lastBeat = Date.now();
          windows.get(parsed.window).status = "online";
        }
        break;
      }
      case "message":
      case "reply": {
        // Agent → H5
        log(`[msg] agent → H5 [${parsed.window}] ${(parsed.text||"").slice(0, 40)}`);
        sseBroadcast("message", {
          window: parsed.window,
          text: parsed.text || "",
          from: "agent",
          time: parsed.time || new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        });
        break;
      }
      case "bound": {
        // Agent confirmed binding
        const peerName = parsed.agent_name || parsed.peer_name || "Agent";
        peers[peerName] = {
          openid: msg.from_openid,
          name: peerName,
          boundAt: new Date().toISOString(),
        };
        saveJSON(PEERS_FILE, peers);
        sseBroadcast("bound", { agent: peerName, openid: msg.from_openid });
        break;
      }
    }
    return true;
  });
  log("OB listener started");

  // 4. HTTP Server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }

    try {
      // ── API: Status ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, {
          ok: true,
          cloudOpenId: creds.openid.slice(0, 12) + "...",
          peers: Object.keys(peers).length,
          windows: getWindows().filter(w => w.status === "online").length,
          uptime: process.uptime(),
        });
      }

      // ── API: H5 identity ─────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/identity") {
        return json(res, { openid: creds.openid });
      }

      // ── API: Pairing ──────────────────────────────────────
      if (req.method === "POST" && url.pathname === "/api/pairing") {
        const code = generateCode();
        pairings.set(code, {
          cloudOpenId: creds.openid,
          expiresAt: Date.now() + 600_000,
          used: false,
        });
        log(`[pairing] code=${code}`);
        return json(res, { code, expires_in: 600 });
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/pairing/")) {
        const code = url.pathname.split("/").pop().toUpperCase();
        const data = pairings.get(code);
        if (!data) return json(res, { error: "invalid or expired" }, 404);
        if (data.used) return json(res, { error: "already used" }, 410);
        data.used = true;
        pairings.delete(code);
        log(`[pairing] consumed: ${code}`);
        return json(res, { cloud_openid: data.cloudOpenId });
      }

      // ── API: Send message (H5 → Agent) ──────────────────
      if (req.method === "POST" && url.pathname === "/api/send") {
        const body = await parseBody(req);
        const { window: win, text, agent } = body;
        if (!text) return json(res, { error: "missing text" }, 400);

        // Find peer
        const peerKey = agent || Object.keys(peers)[0];
        const peer = peers[peerKey];
        if (!peer) return json(res, { error: "no bound agent" }, 400);

        await ob.send(peer.openid, JSON.stringify({
          action: "message",
          window: win || "",
          text,
          from: "h5",
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        }));

        sseBroadcast("message", { window: win || "", text, from: "h5",
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) });
        return json(res, { ok: true });
      }

      // ── API: Peers ────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/peers") {
        return json(res, Object.entries(peers).map(([k, v]) => ({ name: k, openid: v.openid, boundAt: v.boundAt })));
      }

      // ── API: Windows ──────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/windows") {
        return json(res, getWindows());
      }

      // ── SSE ───────────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("event: connected\ndata: {}\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // ── Static ─────────────────────────────────────────────
      serveStatic(req, res);

    } catch (e) {
      log(`error: ${e.message}`);
      json(res, { error: "internal" }, 500);
    }
  });

  server.listen(PORT, () => {
    log(`Listening: http://localhost:${PORT}`);
    log(`  Identity: ${creds.openid.slice(0, 8)}...`);
    log(`  Peers: ${Object.keys(peers).length}`);
    log(`  H5: http://localhost:${PORT}`);
  });

  // Heartbeat eviction
  setInterval(() => { getWindows(); }, 15_000).unref();
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
