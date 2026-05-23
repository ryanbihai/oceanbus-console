#!/usr/bin/env node
/**
 * OceanBus Console — Version Check
 *
 * Compares installed version with latest, emits upgrade hints.
 * Run on hook Setup (like claude-mem).
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PLUGIN_JSON = path.join(ROOT, '.claude-plugin', 'plugin.json');
const VERSION_FILE = path.join(ROOT, '.install-version');

function log(msg) { process.stderr.write(`[ob-version] ${msg}\n`); }

try {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf-8'));
  const current = plugin.version || '0.0.0';
  const installed = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf-8').trim() : current;

  if (installed !== current) {
    // First run or version changed — write marker
    fs.writeFileSync(VERSION_FILE, current);
    log(`OceanBus Console v${current}`);
  }

  // Check SDK version
  try {
    const pkg = require('oceanbus/package.json');
    log(`SDK: oceanbus v${pkg.version}`);
  } catch {
    log('WARNING: oceanbus SDK not found. Install: npm install -g oceanbus@latest');
  }
} catch (e) {
  log(`Version check failed: ${e.message}`);
}
