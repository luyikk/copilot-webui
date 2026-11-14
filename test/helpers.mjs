import https from 'node:https';

export function request(base, route, { method = 'GET', json, raw, cookie, origin = base, headers = {}, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (json === undefined ? undefined : JSON.stringify(json));
    const req = https.request(`${base}${route}`, {
      rejectUnauthorized: false, method, localAddress,
      headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let body;
        if (res.headers['content-type']?.includes('application/json')) body = JSON.parse(text);
        resolve({ status: res.statusCode, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

export function mockTerminal() {
  const terminals = [];
  function spawn(command, args, options) {
    let dataHandler = () => {};
    let exitHandler = () => {};
    const terminal = {
      command, args, options, writes: [], sizes: [], killed: false,
      onData(callback) {
        dataHandler = callback;
        queueMicrotask(() => callback('\x1b[32mCopilot CLI\x1b[0m\r\nReady. Browser terminal connected.\r\n> '));
      },
      onExit(callback) { exitHandler = callback; },
      write(data) { terminal.writes.push(data); dataHandler(data); },
      resize(cols, rows) { terminal.sizes.push([cols, rows]); },
      kill() { terminal.killed = true; exitHandler({ exitCode: 0 }); },
      output(data) { dataHandler(data); },
      exit(exitCode) { exitHandler({ exitCode }); },
    };
    terminals.push(terminal);
    return terminal;
  }
  return { terminals, spawn };
}
