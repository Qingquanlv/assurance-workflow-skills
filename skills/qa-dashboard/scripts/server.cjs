// skills/qa-dashboard/scripts/server.cjs
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== Configuration ==========
const PORT = process.env.QA_DASHBOARD_PORT || (49152 + Math.floor(Math.random() * 16383));
const HOST = process.env.QA_DASHBOARD_HOST || '127.0.0.1';
const URL_HOST = process.env.QA_DASHBOARD_URL_HOST || (HOST === '127.0.0.1' ? 'localhost' : HOST);
const SESSION_DIR = process.env.QA_DASHBOARD_DIR || '/tmp/qa-dashboard';
const STATE_DIR = path.join(SESSION_DIR, 'state');
const PROJECT_DIR = process.env.QA_DASHBOARD_PROJECT_DIR || process.cwd();
let ownerPid = process.env.QA_DASHBOARD_OWNER_PID ? Number(process.env.QA_DASHBOARD_OWNER_PID) : null;

const CASE_CENTER_HTML = path.join(__dirname, 'case-center.html');

// ========== Route Helpers ==========
function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendJson(res, status, data) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// ========== File Scanning ==========
function walkYaml(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'case.yaml') {
        results.push(path.relative(PROJECT_DIR, full));
      }
    }
  }
  walk(dir);
  return results;
}

// ========== Request Handler ==========
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // GET /cases — serve Case Center SPA
  if (req.method === 'GET' && pathname === '/cases') {
    if (!fs.existsSync(CASE_CENTER_HTML)) {
      send(res, 500, 'text/plain', 'case-center.html not found');
      return;
    }
    send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(CASE_CENTER_HTML, 'utf-8'));
    return;
  }

  // GET /yaml?path=<relative-path> — serve raw yaml file content
  if (req.method === 'GET' && pathname === '/yaml') {
    const relPath = url.searchParams.get('path');
    if (!relPath) { sendError(res, 400, 'Missing path parameter'); return; }
    // Security: resolve and verify the file is under PROJECT_DIR
    const absPath = path.resolve(PROJECT_DIR, relPath);
    const safeRoot = path.resolve(PROJECT_DIR);
    if (absPath !== safeRoot && !absPath.startsWith(safeRoot + path.sep)) {
      sendError(res, 403, 'Path traversal not allowed');
      return;
    }
    if (!fs.existsSync(absPath)) { sendError(res, 404, 'File not found'); return; }
    send(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(absPath, 'utf-8'));
    return;
  }

  // GET /api/cases — list all case.yaml paths under qa/cases/
  if (req.method === 'GET' && pathname === '/api/cases') {
    const casesDir = path.join(PROJECT_DIR, 'qa', 'cases');
    const files = walkYaml(casesDir);
    sendJson(res, 200, { files });
    return;
  }

  // GET /api/changes — list change-id directories under qa/changes/
  if (req.method === 'GET' && pathname === '/api/changes') {
    const changesDir = path.join(PROJECT_DIR, 'qa', 'changes');
    let changes = [];
    if (fs.existsSync(changesDir)) {
      try {
        changes = fs.readdirSync(changesDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name);
      } catch (_) {}
    }
    sendJson(res, 200, { changes });
    return;
  }

  // GET /api/changes/:changeId — list case.yaml paths for a specific change
  const changeMatch = pathname.match(/^\/api\/changes\/([^/]+)$/);
  if (req.method === 'GET' && changeMatch) {
    const changeId = changeMatch[1];
    // Validate changeId is a safe directory name (no path separators)
    if (!/^[\w.-]+$/.test(changeId)) {
      sendError(res, 400, 'Invalid changeId');
      return;
    }
    const changeDir = path.join(PROJECT_DIR, 'qa', 'changes', changeId, 'cases');
    const files = walkYaml(changeDir);
    sendJson(res, 200, { changeId, files });
    return;
  }

  sendError(res, 404, 'Not found');
}

// ========== Lifecycle ==========
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
let lastActivity = Date.now();

function ownerAlive() {
  if (!ownerPid) return true;
  try { process.kill(ownerPid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function startServer() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    handleRequest(req, res);
  });

  server.on('error', (err) => {
    console.error(JSON.stringify({ type: 'server-error', code: err.code, message: err.message }));
    process.exit(1);
  });

  function shutdown(reason) {
    clearInterval(lifecycleCheck);
    console.log(JSON.stringify({ type: 'server-stopped', reason }));
    const infoFile = path.join(STATE_DIR, 'server-info');
    if (fs.existsSync(infoFile)) fs.unlinkSync(infoFile);
    server.close(() => process.exit(0));
  }

  const lifecycleCheck = setInterval(() => {
    if (!ownerAlive()) shutdown('owner process exited');
    else if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) shutdown('idle timeout');
  }, 60 * 1000);
  lifecycleCheck.unref();

  server.listen(PORT, HOST, () => {
    const info = {
      type: 'server-started',
      port: Number(PORT),
      host: HOST,
      url_host: URL_HOST,
      url: `http://${URL_HOST}:${PORT}/cases`,
      project_dir: PROJECT_DIR,
      session_dir: SESSION_DIR,
      state_dir: STATE_DIR,
    };
    const infoStr = JSON.stringify(info);
    console.log(infoStr);
    fs.writeFileSync(path.join(STATE_DIR, 'server-info'), infoStr + '\n');
  });
}

if (require.main === module) startServer();
module.exports = { walkYaml };
