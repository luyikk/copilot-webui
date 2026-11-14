import { before, after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../server.mjs';
import { mockTerminal, request } from './helpers.mjs';

let app, base, temporary, home, cookie, key;
const mock = mockTerminal();
const login = async () => {
  const response = await request(base, '/api/login', { method: 'POST', json: { key } });
  assert.equal(response.status, 200);
  return response.headers['set-cookie'][0].split(';')[0];
};
const createSession = (cwd = home) => request(base, '/api/sessions', { method: 'POST', cookie, json: { cwd } });
function socket(id, overrides = {}, options = {}) {
  return new WebSocket(`${base.replace('https:', 'wss:')}/ws/${id}`, {
    rejectUnauthorized: false, ...options, headers: { Origin: base, Cookie: cookie, ...overrides },
  });
}
async function rejectedSocket(id, overrides, expectedStatus, options = {}) {
  const ws = socket(id, overrides, options);
  const result = await new Promise((resolve, reject) => {
    ws.on('unexpected-response', (req, res) => {
      res.resume();
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('WebSocket unexpectedly accepted')); });
  });
  assert.equal(result, expectedStatus);
}

before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-webui-test-'));
  home = path.join(temporary, 'home');
  await fs.mkdir(path.join(home, 'project'), { recursive: true });
  await fs.mkdir(path.join(home, '.hidden'));
  await fs.symlink(os.tmpdir(), path.join(home, 'outside'));
  const dataDir = path.join(temporary, 'state');
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.writeFile(path.join(dataDir, 'access-key'), 'custom7\n', { mode: 0o600 });
  app = await createApplication({ home, dataDir, host: '127.0.0.1', port: 0, allowedSubnets: ['127.0.0.1/32'], spawnPty: mock.spawn, maxSessions: 2 });
  base = await app.listen();
  key = (await fs.readFile(app.keyFile, 'utf8')).trim();
  cookie = await login();
});
afterEach(async () => {
  for (const id of [...app.sessions.keys()]) await request(base, `/api/sessions/${id}`, { method: 'DELETE', cookie });
});
after(async () => {
  await app?.close();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test('requires authentication and protects the login cookie and credentials', async () => {
  assert.equal((await request(base, '/api/sessions')).status, 401);
  assert.deepEqual((await request(base, '/api/auth')).body, { authenticated: false });
  const response = await request(base, '/api/login', { method: 'POST', json: { key } });
  assert.match(response.headers['set-cookie'][0], /__Host-copilot-webui=/);
  assert.match(response.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict; Path=\//);
  assert.equal((await fs.stat(app.keyFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(app.keyFile))).mode & 0o777, 0o700);
  assert.equal((await request(base, '/api/login', { method: 'POST', json: { key: 'wrong' } })).status, 401);
});

test('blocks untrusted Host, cross-site mutation, and cross-site WebSocket requests', async () => {
  assert.equal((await request(base, '/api/auth', { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal((await request(base, '/api/login', { method: 'POST', origin: 'https://evil.example', json: { key } })).status, 403);
  assert.equal((await request(base, '/api/sessions', { method: 'POST', origin: 'https://evil.example', cookie, json: { cwd: home } })).status, 403);
  const session = await createSession();
  await rejectedSocket(session.body.id, { Origin: 'https://evil.example' }, 403);
  await rejectedSocket(session.body.id, { Cookie: '' }, 401);
});

test('rejects clients outside allowed subnets, including forged proxy headers and WebSocket upgrades', async () => {
  const disallowed = { localAddress: '127.0.0.2', headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' } };
  assert.equal((await request(base, '/', disallowed)).status, 403);
  assert.equal((await request(base, '/api/auth', disallowed)).status, 403);
  assert.equal((await request(base, '/api/login', { ...disallowed, method: 'POST', json: { key } })).status, 403);
  assert.equal((await request(base, '/api/sessions', { ...disallowed, cookie })).status, 403);
  const session = await createSession();
  await rejectedSocket(session.body.id, disallowed.headers, 403, { localAddress: '127.0.0.2' });
});

test('fails closed on invalid or empty network allowlists', async () => {
  for (const allowedSubnets of [[], ['not-a-subnet'], ['192.168.50.0/33'], ['0.0.0.999/24']]) {
    await assert.rejects(createApplication({ home, allowedSubnets, spawnPty: mock.spawn }), /WEBUI_ALLOWED_SUBNETS/);
  }
});

test('serves local assets with security headers, without leaking arbitrary files', async () => {
  for (const route of ['/', '/app.js', '/style.css', '/vendor/xterm.js', '/vendor/addon-fit.js', '/vendor/xterm.css']) {
    const response = await request(base, route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(response.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await request(base, '/server.mjs', { cookie })).status, 404);
  assert.equal((await request(base, '/..%2fserver.mjs', { cookie })).status, 404);
});

test('validates workspaces, including symlink escapes, and hides dot directories', async () => {
  const response = await request(base, '/api/workspaces', { cookie });
  assert.equal(response.body.path, home);
  assert.equal(response.body.parent, null);
  assert.deepEqual(response.body.directories.map(d => d.name), ['project']);
  assert.equal((await createSession('/etc')).status, 403);
  assert.equal((await createSession(path.join(home, 'outside'))).status, 403);
  assert.equal((await createSession(path.join(home, 'missing'))).status, 400);
  assert.equal((await createSession(42)).status, 400);
  assert.equal((await createSession('bad\0path')).status, 400);
});

test('launches the actual command without a shell or approval-bypass arguments', async () => {
  const response = await createSession(path.join(home, 'project'));
  assert.equal(response.status, 201);
  const terminal = mock.terminals.at(-1);
  assert.equal(terminal.options.cwd, path.join(home, 'project'));
  assert.deepEqual(terminal.args, []);
  assert.equal(terminal.options.env.TERM, 'xterm-256color');
  assert.equal(response.body.status, 'running');
  assert.equal((await request(base, '/api/sessions', { cookie })).body.sessions.length, 1);
  const result = await request(base, `/api/sessions/${response.body.id}`, { method: 'DELETE', cookie });
  assert.equal(result.status, 200);
  assert.equal(terminal.killed, true);
});

test('enforces session limits even for simultaneous creation requests', async () => {
  const responses = await Promise.all([createSession(), createSession(), createSession(), createSession()]);
  assert.equal(responses.filter(r => r.status === 201).length, 2);
  assert.equal(responses.filter(r => r.status === 409).length, 2);
});

test('streams terminal input/output, resizes, replays history, and preserves disconnected sessions', async () => {
  const response = await createSession();
  const terminal = mock.terminals.at(-1);
  const ws = socket(response.body.id);
  const [initial] = await once(ws, 'message');
  assert.match(JSON.parse(initial).data, /Browser terminal connected/);
  const output = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', data: 'hello\r' }));
  assert.equal(JSON.parse((await output)[0]).data, 'hello\r');
  const resizeOutput = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'resize', cols: 99, rows: 35 }));
  ws.send(JSON.stringify({ type: 'input', data: 'after resize' }));
  await resizeOutput;
  assert.deepEqual(terminal.sizes.at(-1), [99, 35]);
  ws.close();
  await once(ws, 'close');
  assert.equal(terminal.killed, false);
  terminal.output('background output');
  const reconnect = socket(response.body.id);
  const replay = JSON.parse((await once(reconnect, 'message'))[0]);
  assert.match(replay.data, /background output/);
  assert.match(replay.data, /hello/);
  const exited = once(reconnect, 'message');
  terminal.exit(7);
  assert.deepEqual(JSON.parse((await exited)[0]), { type: 'exit', exitCode: 7 });
  reconnect.close();
  await once(reconnect, 'close');
});

test('caps terminal output history and rejects malformed messages', async () => {
  const response = await createSession();
  const terminal = mock.terminals.at(-1);
  terminal.output('a'.repeat(2 * 1024 * 1024));
  assert.equal(app.sessions.get(response.body.id).history.length, 1024 * 1024);
  const ws = socket(response.body.id);
  await once(ws, 'message');
  const closed = once(ws, 'close');
  ws.send('not json');
  assert.equal((await closed)[0], 1008);
});

test('logout invalidates the login and existing WebSockets', async () => {
  const separateCookie = await login();
  const response = await createSession();
  const ws = socket(response.body.id, { Cookie: separateCookie });
  await once(ws, 'message');
  const closed = once(ws, 'close');
  assert.equal((await request(base, '/api/logout', { method: 'POST', cookie: separateCookie, json: {} })).status, 200);
  assert.equal((await closed)[0], 4001);
  assert.equal((await request(base, '/api/sessions', { cookie: separateCookie })).status, 401);
});

test('rate limits repeated failed logins', async () => {
  for (let i = 0; i < 8; i++) {
    assert.equal((await request(base, '/api/login', { method: 'POST', json: { key: 'incorrect' } })).status, 401);
  }
  assert.equal((await request(base, '/api/login', { method: 'POST', json: { key } })).status, 429);
});
