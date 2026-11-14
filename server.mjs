import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { BlockList, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { parse as parseYaml } from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = '__Host-copilot-webui';
const AUTH_TTL = 12 * 60 * 60 * 1000;
const HISTORY_LIMIT = 1024 * 1024;
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/vendor/xterm.js', ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript']],
  ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css']],
  ['/vendor/addon-fit.js', ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript']],
]);
const digest = value => createHash('sha256').update(value).digest();
const clamp = (value, min, max, fallback) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, '请求必须使用 JSON。');
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw new HttpError(413, '请求内容过长。');
  }
  try {
    const value = JSON.parse(body);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'JSON 格式不正确。');
  }
}

export async function createApplication(options = {}) {
  const home = fs.realpathSync(options.home ?? os.homedir());
  const host = options.host ?? process.env.WEBUI_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.WEBUI_PORT ?? 8000);
  if (isIP(host) !== 4) throw new Error('WEBUI_HOST must be an IPv4 address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid WEBUI_PORT.');
  const allowedSubnets = options.allowedSubnets ?? (process.env.WEBUI_ALLOWED_SUBNETS ?? '127.0.0.0/8').split(',');
  if (!Array.isArray(allowedSubnets) || !allowedSubnets.length) throw new Error('WEBUI_ALLOWED_SUBNETS must not be empty.');
  const allowedNetworks = new BlockList();
  for (const subnet of allowedSubnets) {
    const match = typeof subnet === 'string' && subnet.trim().match(/^([^/]+)\/(\d{1,2})$/);
    if (!match || isIP(match[1]) !== 4 || Number(match[2]) > 32) throw new Error('Invalid IPv4 CIDR in WEBUI_ALLOWED_SUBNETS.');
    allowedNetworks.addSubnet(match[1], Number(match[2]), 'ipv4');
  }
  const allowedClient = req => isIP(req.socket.remoteAddress ?? '') === 4 && allowedNetworks.check(req.socket.remoteAddress, 'ipv4');
  const dataDir = options.dataDir ?? process.env.WEBUI_DATA_DIR ?? path.join(home, '.local/share/copilot-webui');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const keyFile = path.join(dataDir, 'access-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, `${randomBytes(24).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const accessKey = fs.readFileSync(keyFile, 'utf8').trim();
  if (accessKey.length < 7) throw new Error('Access key must contain at least 7 characters.');
  const passwordHash = digest(accessKey);
  const tlsKey = path.join(dataDir, 'tls-key.pem');
  const tlsCert = path.join(dataDir, 'tls-cert.pem');
  const tlsHostFile = path.join(dataDir, 'tls-host');
  const previousHost = fs.existsSync(tlsHostFile) ? fs.readFileSync(tlsHostFile, 'utf8').trim() : '';
  if (!fs.existsSync(tlsKey) || !fs.existsSync(tlsCert) || previousHost !== host) {
    const result = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes',
      '-keyout', tlsKey, '-out', tlsCert, '-days', '365',
      '-subj', '/CN=Copilot Local Workspace',
      '-addext', `subjectAltName=IP:${host},IP:127.0.0.1,DNS:localhost`,
    ], { encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error(`TLS certificate generation failed: ${result.error?.message ?? result.stderr}`);
    fs.writeFileSync(tlsHostFile, host, { mode: 0o600 });
  }
  fs.chmodSync(tlsKey, 0o600);

  const sessions = new Map();
  const stoppingSessions = new Set();
  const recordsFile = path.join(dataDir, 'sessions.json');
  const records = new Map();
  const sessionStateDir = options.sessionStateDir ?? path.join(process.env.COPILOT_HOME ?? path.join(home, '.copilot'), 'session-state');
  if (fs.existsSync(recordsFile)) {
    const saved = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Invalid saved WebUI session index.');
    for (const record of saved) {
      if (!record || !SESSION_ID.test(record.id) || typeof record.cwd !== 'string' ||
          typeof record.title !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
        throw new Error('Invalid saved WebUI session metadata.');
      }
      records.set(record.id, { ...record, status: 'archived' });
    }
  }
  const saveRecords = () => {
    const temporary = `${recordsFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...records.values()]), { mode: 0o600 });
    fs.renameSync(temporary, recordsFile);
  };
  const authSessions = new Map();
  const attempts = new Map();
  const spawnPty = options.spawnPty ?? pty.spawn;
  const command = options.command ?? process.env.COPILOT_BIN ?? path.join(home, '.local/bin/copilot');
  if (!options.spawnPty) fs.accessSync(command, fs.constants.X_OK);
  const maxSessions = options.maxSessions ?? 6;
  let authority;
  let origin;
  let closing = false;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });

  const send = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(value));
  };
  const authId = req => {
    const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
    const id = cookie?.slice(COOKIE.length + 1);
    const expires = authSessions.get(id);
    if (!expires || expires <= Date.now()) {
      if (id) authSessions.delete(id);
      return null;
    }
    return id;
  };
  const workspace = value => {
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new HttpError(400, '工作目录无效。');
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(home, value));
      if (!fs.statSync(resolved).isDirectory()) throw new HttpError(400, '请选择文件夹。');
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw new HttpError(400, '目录不存在或无访问权限。');
      throw error;
    }
    if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) throw new HttpError(403, '工作目录必须位于当前用户的主目录内。');
    return resolved;
  };
  const describe = s => ({ id: s.id, title: s.title, cwd: s.cwd, status: s.status, createdAt: s.createdAt, exitCode: s.exitCode });
  const inUse = directory => {
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory).some(name => {
      const match = name.match(/^inuse\.(\d+)\.lock$/);
      if (!match) return false;
      try { process.kill(Number(match[1]), 0); return true; }
      catch (error) {
        if (error.code === 'ESRCH') return false;
        if (error.code === 'EPERM') return true;
        throw error;
      }
    });
  };
  const getHistory = () => {
    const history = new Map();
    if (fs.existsSync(sessionStateDir)) {
      for (const entry of fs.readdirSync(sessionStateDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
        const directory = path.join(sessionStateDir, entry.name);
        const metadata = path.join(directory, 'workspace.yaml');
        if (!fs.existsSync(metadata)) continue;
        const record = parseYaml(fs.readFileSync(metadata, 'utf8'));
        if (!record || record.id !== entry.name || typeof record.cwd !== 'string' ||
            !Number.isFinite(Date.parse(record.created_at))) {
          console.error(`Invalid CLI session metadata: ${metadata}`);
          continue;
        }
        const title = typeof record.name === 'string' ? record.name.trim() : '';
        if (!title) {
          const eventsFile = path.join(directory, 'events.jsonl');
          const hasMessages = fs.existsSync(eventsFile) && fs.readFileSync(eventsFile, 'utf8')
            .split('\n').some(line => {
              if (!line.trim()) return false;
              return JSON.parse(line).type === 'user.message';
            });
          if (!hasMessages) continue;
        }
        history.set(entry.name, {
          id: entry.name, cwd: record.cwd,
          title: title || path.basename(record.cwd),
          createdAt: record.created_at, status: 'archived', exitCode: null,
          busy: sessions.has(entry.name) || stoppingSessions.has(entry.name) || inUse(directory),
        });
      }
    }
    return [...history.values()].filter(record => {
      try { workspace(record.cwd); return true; }
      catch (error) {
        if (error instanceof HttpError) return false;
        throw error;
      }
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  };
  const emit = (s, message) => {
    const payload = JSON.stringify(message);
    for (const ws of s.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > HISTORY_LIMIT * 2) ws.terminate();
      else ws.send(payload);
    }
  };
  const dispose = s => {
    records.set(s.id, { ...describe(s), status: s.status === 'running' ? 'stopping' : 'archived' });
    saveRecords();
    if (s.status === 'running') {
      stoppingSessions.add(s.id);
      try { s.pty.kill('SIGTERM'); } catch (error) { console.error(`Failed to stop terminal ${s.id}: ${error.message}`); }
      const timer = setTimeout(() => {
        if (s.status === 'running') {
          try { s.pty.kill('SIGKILL'); } catch (error) { console.error(`Failed to kill terminal ${s.id}: ${error.message}`); }
        }
      }, 4000);
      timer.unref();
    }
    for (const ws of s.clients) ws.close(1000, 'Session closed');
    sessions.delete(s.id);
  };

  const server = https.createServer({
    key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert), minVersion: 'TLSv1.2',
    requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384,
  }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!allowedClient(req)) throw new HttpError(403, '仅允许指定局域网网段访问。');
      if (req.headers.host !== authority) throw new HttpError(421, '主机地址不匹配。');
      const url = new URL(req.url, origin);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw new HttpError(403, '请求来源不被允许。');
      if (url.pathname === '/api/auth' && req.method === 'GET') return send(res, 200, { authenticated: Boolean(authId(req)) });
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const address = req.socket.remoteAddress;
        let record = attempts.get(address);
        if (record && record.until > Date.now() && record.count >= 8) throw new HttpError(429, '登录尝试过多，请在 15 分钟后重试。');
        const { key } = await jsonBody(req);
        record = attempts.get(address);
        if (record && record.until > Date.now() && record.count >= 8) throw new HttpError(429, '登录尝试过多，请在 15 分钟后重试。');
        if (typeof key !== 'string' || !timingSafeEqual(digest(key), passwordHash)) {
          const current = record?.until > Date.now() ? record : { count: 0, until: Date.now() + 15 * 60 * 1000 };
          current.count++;
          if (attempts.size < 1024 || attempts.has(address)) attempts.set(address, current);
          throw new HttpError(401, '登录口令不正确。');
        }
        attempts.delete(address);
        if (authSessions.size >= 32) authSessions.delete(authSessions.keys().next().value);
        const id = randomBytes(32).toString('base64url');
        authSessions.set(id, Date.now() + AUTH_TTL);
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL / 1000}` });
      }
      const asset = assets.get(url.pathname);
      if (asset && ['GET', 'HEAD'].includes(req.method)) {
        const content = await fs.promises.readFile(path.join(root, asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1] });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      const id = authId(req);
      if (!id) throw new HttpError(401, '请先登录。');
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        authSessions.delete(id);
        for (const ws of wsServer.clients) if (ws.authId === id) ws.close(4001, 'Logged out');
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (url.pathname === '/api/info' && req.method === 'GET') {
        return send(res, 200, { home, user: os.userInfo().username, hostname: os.hostname(), maxSessions });
      }
      if (url.pathname === '/api/workspaces' && req.method === 'GET') {
        const cwd = workspace(url.searchParams.get('path') ?? home);
        const entries = await fs.promises.readdir(cwd, { withFileTypes: true });
        const directories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({ name: e.name, path: path.join(cwd, e.name) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
        return send(res, 200, { path: cwd, parent: cwd === home ? null : path.dirname(cwd), directories });
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') return send(res, 200, { sessions: [...sessions.values()].map(describe) });
      if (url.pathname === '/api/history' && req.method === 'GET') return send(res, 200, { sessions: getHistory() });
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (sessions.size >= maxSessions) throw new HttpError(409, `最多保留 ${maxSessions} 个会话，请先关闭不需要的会话。`);
        let previous;
        if (body.resumeId !== undefined) {
          if (typeof body.resumeId !== 'string' || !SESSION_ID.test(body.resumeId)) throw new HttpError(400, '历史会话 ID 无效。');
          if (sessions.has(body.resumeId)) throw new HttpError(409, '该会话已经打开，请切换到现有会话。');
          previous = getHistory().find(record => record.id === body.resumeId);
          if (!previous) throw new HttpError(404, '历史会话不存在、正在使用或工作目录不可用。');
          if (previous.busy) throw new HttpError(409, '该会话正在其他终端使用，暂时不能恢复。');
        }
        const cwd = workspace(previous?.cwd ?? body.cwd ?? home);
        const sessionId = previous?.id ?? randomUUID();
        const terminal = spawnPty(command, ['--session-id', sessionId], {
          name: 'xterm-256color', cols: clamp(body.cols, 40, 300, 120), rows: clamp(body.rows, 8, 120, 32),
          cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
        const s = {
          id: sessionId, title: previous?.title ?? path.basename(cwd), cwd, status: 'running',
          createdAt: previous?.createdAt ?? new Date().toISOString(), pty: terminal, history: '', clients: new Set(), exitCode: null,
        };
        sessions.set(s.id, s);
        terminal.onData(data => {
          s.history = (s.history + data).slice(-HISTORY_LIMIT);
          emit(s, { type: 'output', data });
        });
        terminal.onExit(({ exitCode }) => {
          stoppingSessions.delete(s.id);
          s.status = 'exited';
          s.exitCode = exitCode;
          records.set(s.id, { ...describe(s), status: 'archived' });
          try { saveRecords(); }
          catch (error) {
            console.error(`Unable to save session history: ${error.message}`);
            emit(s, { type: 'error', message: '保存历史会话失败，请查看服务日志。' });
          }
          emit(s, { type: 'exit', exitCode });
        });
        records.set(s.id, { ...describe(s), status: 'running' });
        try { saveRecords(); }
        catch (error) {
          sessions.delete(s.id);
          terminal.kill('SIGTERM');
          throw error;
        }
        return send(res, 201, describe(s));
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
      if (match && req.method === 'DELETE') {
        const s = sessions.get(match[1]);
        if (!s) throw new HttpError(404, '会话不存在。');
        dispose(s);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, '页面或接口不存在。');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      if (!res.headersSent) send(res, error.status ?? 500, { error: error instanceof HttpError ? error.message : '服务器发生错误，请查看服务日志。' });
      else res.end();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (closing || !allowedClient(req) || req.headers.host !== authority || req.headers.origin !== origin) return reject('403 Forbidden');
    const id = authId(req);
    if (!id) return reject('401 Unauthorized');
    const url = new URL(req.url, origin);
    const match = url.pathname.match(/^\/ws\/([a-f0-9-]{36})$/);
    const s = match && sessions.get(match[1]);
    if (!s) return reject('404 Not Found');
    if (s.clients.size >= 8) return reject('429 Too Many Requests');
    wsServer.handleUpgrade(req, socket, head, ws => {
      ws.authId = id;
      ws.alive = true;
      s.clients.add(ws);
      ws.send(JSON.stringify({ type: 'ready', session: describe(s), data: s.history }));
      ws.on('pong', () => { ws.alive = true; });
      ws.on('close', () => s.clients.delete(ws));
      ws.on('error', error => console.error(`WebSocket error: ${error.message}`));
      ws.on('message', data => {
        if (!authSessions.has(id) || authSessions.get(id) <= Date.now()) return ws.close(4001, 'Login expired');
        if (s.status !== 'running') return;
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) s.pty.write(message.data);
          else if (message.type === 'resize') s.pty.resize(clamp(message.cols, 40, 300, 120), clamp(message.rows, 8, 120, 32));
          else ws.close(1008, 'Invalid message');
        } catch (error) {
          console.error(`Terminal message rejected: ${error.message}`);
          ws.close(1008, 'Invalid terminal message');
        }
      });
    });
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, expires] of authSessions) if (expires <= now) authSessions.delete(id);
    for (const [ip, record] of attempts) if (record.until <= now) attempts.delete(ip);
    for (const ws of wsServer.clients) {
      if (!authSessions.has(ws.authId)) { ws.close(4001, 'Login expired'); continue; }
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    server, sessions, keyFile,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          authority = `${host}:${server.address().port}`;
          origin = `https://${authority}`;
          resolve();
        });
      });
      return origin;
    },
    async close() {
      closing = true;
      clearInterval(heartbeat);
      for (const s of sessions.values()) dispose(s);
      for (const ws of wsServer.clients) ws.terminate();
      wsServer.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApplication();
  const address = await app.listen();
  console.log(`Copilot WebUI listening on ${address}`);
  console.log(`Access key file: ${app.keyFile}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await app.close(); } catch (error) { console.error(error); process.exitCode = 1; }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
