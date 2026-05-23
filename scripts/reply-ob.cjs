#!/usr/bin/env node
/**
 * reply-ob.cjs — One-shot OB reply for OceanBus Console
 *
 * Usage:
 *   node reply-ob.cjs --text "<msg>" --h5-openid "<uuid>" --window "<name>"
 *     [--cloud-ob-openid "<o>"] [--gateway-url "<url>"]
 *     [--window-name "<name>"] [--agent-id "<id>" --api-key "<key>" --openid "<openid>"]
 *
 * Identity resolution (priority):
 *   1. --agent-id + --api-key + --openid (inline, temp-identity)
 *   2. --window-name → ~/.oceanbus/windows/<name>/credentials.json (per-window)
 *   3. ~/.oceanbus/credentials.json (legacy shared)
 *
 * Sends reply from Agent to Cloud via OB, then exits.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  text: '', h5OpenId: '', window: '',
  cloudObOpenId: '', gatewayUrl: 'http://127.0.0.1:3456',
  credsFile: '', windowName: '',
  agentId: '', apiKey: '', openid: '',
};

for (let i = 0; i < args.length; i++) {
  const a = args[i]; const v = args[i + 1];
  if (a === '--text') { opts.text = v; i++; }
  else if (a === '--h5-openid') { opts.h5OpenId = v; i++; }
  else if (a === '--window') { opts.window = v; i++; }
  else if (a === '--cloud-ob-openid') { opts.cloudObOpenId = v; i++; }
  else if (a === '--gateway-url') { opts.gatewayUrl = v; i++; }
  else if (a === '--window-name') { opts.windowName = v; i++; }
  else if (a === '--agent-id') { opts.agentId = v; i++; }
  else if (a === '--api-key') { opts.apiKey = v; i++; }
  else if (a === '--openid') { opts.openid = v; i++; }
  else if (a === '--creds-file') { opts.credsFile = v; i++; }
  else if (a === '--help') {
    console.error('Usage: node reply-ob.cjs --text "<msg>" --h5-openid "<uuid>" --window "<name>"');
    console.error('              [--window-name "<name>"] [--cloud-ob-openid "<o>"] [--gateway-url "<url>"]');
    console.error('              [--agent-id "<id>" --api-key "<key>" --openid "<openid>"]');
    process.exit(0);
  }
}

if (!opts.text || !opts.h5OpenId || !opts.window) {
  console.error('Error: --text, --h5-openid, and --window are required.');
  process.exit(1);
}

function log(msg) { process.stderr.write(`[reply-ob] ${msg}\n`); }

function slugify(name) { return name.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_'); }

// ── Resolve credentials file ───────────────────────────────
function resolveCredsFile() {
  // 1. Explicit --creds-file
  if (opts.credsFile) return opts.credsFile;
  // 2. Per-window via --window-name
  if (opts.windowName) {
    const f = path.join(os.homedir(), '.oceanbus', 'windows', slugify(opts.windowName), 'credentials.json');
    if (fs.existsSync(f)) return f;
    log(`per-window creds not found: ${f}, falling back to shared`);
  }
  // 3. Legacy shared
  return path.join(os.homedir(), '.oceanbus', 'credentials.json');
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const { text, h5OpenId, window: win } = opts;
  let { cloudObOpenId, gatewayUrl } = opts;

  // Resolve identity
  let creds;
  if (opts.agentId && opts.apiKey && opts.openid) {
    creds = { agent_id: opts.agentId, api_key: opts.apiKey, openid: opts.openid };
    log(`inline identity: ${creds.openid.slice(0, 8)}...`);
  } else {
    const credsFile = resolveCredsFile();
    if (!fs.existsSync(credsFile)) {
      log(`Error: Credentials file not found: ${credsFile}`);
      log('  Use --window-name, --agent-id/--api-key/--openid, or run agent-daemon first.');
      process.exit(1);
    }
    try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8')); } catch {
      log(`Error: Failed to parse: ${credsFile}`);
      process.exit(1);
    }
    if (!creds?.openid) {
      log('Error: Credentials missing openid.');
      process.exit(1);
    }
  }

  // OB instance — send directly to Board (h5OpenId), no Cloud OB needed
  const oceanbus = await import('oceanbus');
  const ob = await oceanbus.createOceanBus({
    keyStore: { type: 'memory' },
    identity: { agent_id: creds.agent_id, api_key: creds.api_key, openid: creds.openid, encryption_key: creds.encryption_key },
  });

  try {
    await ob.send(h5OpenId, JSON.stringify({
      action: 'reply', window: win, text, h5_openid: h5OpenId, from: 'agent',
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    }));
    log(`sent → Cloud [${win}] ${text.slice(0, 40)}`);
  } catch (e) {
    log(`Error: OB send failed: ${e.message}`);
    await ob.destroy().catch(() => {});
    process.exit(1);
  }

  await ob.destroy().catch(() => {});
  console.log('OK');
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
