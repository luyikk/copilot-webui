/* global Terminal, FitAddon */
'use strict';
const $ = id => document.getElementById(id);
const state = {
  info: null, sessions: [], selected: null, cwd: '', directory: '', terminal: null, fit: null,
  socket: null, reconnect: null, refresh: null, closeTarget: null, toastTimer: null,
  fontSize: Math.max(10, Math.min(24, Number(localStorage.getItem('copilot-font-size')) || 14)), viewVersion: 0, authenticated: false,
};
const icons = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3500);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    throw new Error(body.error ?? '请求失败。');
  }
  return body;
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-shade').hidden = true;
}
function disconnect() {
  state.viewVersion++;
  clearTimeout(state.reconnect);
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close();
  }
  if (state.terminal) {
    state.terminal.dispose();
    state.terminal = null;
    state.fit = null;
  }
}
function showLogin() {
  state.authenticated = false;
  clearInterval(state.refresh);
  state.refresh = null;
  disconnect();
  $('app').hidden = true;
  $('login-view').hidden = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('access-key').value = '';
  $('access-key').focus();
}
async function loadApp() {
  state.info = await api('/api/info');
  state.authenticated = true;
  state.cwd = localStorage.getItem('copilot-workspace') || state.info.home;
  $('selected-workspace').textContent = state.cwd;
  $('machine-label').textContent = `${state.info.user} @ ${state.info.hostname}`;
  $('user-avatar').textContent = state.info.user.charAt(0).toUpperCase();
  $('login-view').hidden = true;
  $('app').hidden = false;
  await refreshSessions();
  const previous = localStorage.getItem('copilot-active-session');
  if (state.sessions.some(s => s.id === previous)) openSession(previous);
  else showWelcome();
  clearInterval(state.refresh);
  state.refresh = setInterval(() => {
    if (!document.hidden) refreshSessions().catch(error => {
      if (state.authenticated) toast(`无法刷新会话：${error.message}`, true);
    });
  }, 7000);
}
async function refreshSessions() {
  const body = await api('/api/sessions');
  state.sessions = body.sessions;
  renderSessions();
  if (state.selected && !state.sessions.some(s => s.id === state.selected)) showWelcome();
}
function renderSessions() {
  $('session-list').replaceChildren();
  $('session-count').textContent = `${state.sessions.length} / ${state.info.maxSessions}`;
  $('no-sessions').hidden = state.sessions.length > 0;
  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.className = `session-item${state.selected === session.id ? ' active' : ''}`;
    button.title = session.cwd;
    button.setAttribute('aria-current', state.selected === session.id ? 'page' : 'false');
    button.append(icons('terminal'));
    const info = document.createElement('span');
    info.className = 'session-info';
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    const date = new Date(session.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    meta.textContent = `${date} · ${session.status === 'running' ? '运行中' : `已结束 (${session.exitCode})`}`;
    info.append(name, meta);
    const dot = document.createElement('span');
    dot.className = `status-dot${session.status === 'running' ? '' : ' offline'}`;
    button.append(info, dot);
    button.addEventListener('click', () => openSession(session.id));
    $('session-list').append(button);
  }
}
function showWelcome() {
  disconnect();
  state.selected = null;
  localStorage.removeItem('copilot-active-session');
  $('welcome').hidden = false;
  $('terminal-view').hidden = true;
  $('page-title').textContent = '概览';
  renderSessions();
  closeSidebar();
}
function setConnection(label, mode = '') {
  $('connection-label').textContent = label;
  $('terminal-dot').className = `status-dot ${mode}`;
}
function sendTerminal(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}
function fitTerminal() {
  if (!state.fit || $('terminal-view').hidden) return;
  state.fit.fit();
  if (state.terminal) sendTerminal({ type: 'resize', cols: state.terminal.cols, rows: state.terminal.rows });
}
function openSession(id) {
  const session = state.sessions.find(s => s.id === id);
  if (!session) return;
  disconnect();
  state.selected = id;
  localStorage.setItem('copilot-active-session', id);
  $('welcome').hidden = true;
  $('terminal-view').hidden = false;
  $('page-title').textContent = session.title;
  $('terminal-title').textContent = session.title;
  $('terminal-path').textContent = session.cwd;
  $('terminal-container').replaceChildren();
  state.terminal = new Terminal({
    cursorBlink: true, cursorStyle: 'bar', fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: state.fontSize, lineHeight: 1.25, scrollback: 10000,
    theme: { background: '#111318', foreground: '#d8dfe9', cursor: '#c9f277', selectionBackground: '#c9f27735',
      black: '#212631', red: '#f28796', green: '#c9f277', yellow: '#ebcc86', blue: '#98b9ff',
      magenta: '#c5a5ed', cyan: '#8fd5d0', white: '#e1e6ef', brightBlack: '#7d8798' },
    allowProposedApi: false, convertEol: false, minimumContrastRatio: 4.5,
  });
  state.fit = new FitAddon.FitAddon();
  state.terminal.loadAddon(state.fit);
  state.terminal.open($('terminal-container'));
  state.terminal.onData(data => {
    if (state.socket?.readyState !== WebSocket.OPEN) {
      toast('终端尚未连接，输入未发送。', true);
      return;
    }
    for (let i = 0; i < data.length; i += 16000) sendTerminal({ type: 'input', data: data.slice(i, i + 16000) });
  });
  state.terminal.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
      sendTerminal({ type: 'input', data: '\x1b[13;2u' });
      return false;
    }
    return true;
  });
  fitTerminal();
  renderSessions();
  closeSidebar();
  const version = state.viewVersion;
  let backoff = 1000;
  function connect() {
    if (version !== state.viewVersion) return;
    setConnection('连接中', 'reconnecting');
    const socket = new WebSocket(`wss://${location.host}/ws/${id}`);
    state.socket = socket;
    socket.addEventListener('message', event => {
      if (state.socket !== socket) return;
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        backoff = 1000;
        state.terminal.reset();
        state.terminal.write(message.data, () => {
          if (version !== state.viewVersion) return;
          fitTerminal();
          state.terminal.focus();
        });
        setConnection(message.session.status === 'running' ? '已连接' : `已结束 · ${message.session.exitCode}`, message.session.status === 'running' ? '' : 'offline');
      } else if (message.type === 'output') state.terminal.write(message.data);
      else if (message.type === 'exit') {
        setConnection(`已结束 · ${message.exitCode}`, 'offline');
        state.terminal.write(`\r\n\x1b[90m[会话已结束，退出码 ${message.exitCode}]\x1b[0m\r\n`);
        refreshSessions().catch(error => toast(error.message, true));
      }
    });
    socket.addEventListener('close', async event => {
      if (state.socket !== socket || version !== state.viewVersion) return;
      state.socket = null;
      if (event.code === 4001) {
        showLogin();
        toast('登录已过期，请重新输入口令。', true);
      } else if (event.code === 1000) {
        refreshSessions().catch(error => toast(error.message, true));
        setConnection('已断开', 'offline');
      } else {
        setConnection('连接断开，正在重连', 'reconnecting');
        try {
          const auth = await api('/api/auth');
          if (version !== state.viewVersion) return;
          if (!auth.authenticated) return showLogin();
          await refreshSessions();
        } catch (error) {
          if (version === state.viewVersion) toast(`重连等待中：${error.message}`, true);
        }
        if (version !== state.viewVersion) return;
        state.reconnect = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 1.5, 12000);
      }
    });
    socket.addEventListener('error', () => setConnection('连接异常', 'reconnecting'));
  }
  connect();
}
async function startSession() {
  const button = $('start-session');
  button.disabled = true;
  try {
    const width = Math.max(320, document.querySelector('.main').clientWidth - 28);
    const session = await api('/api/sessions', {
      method: 'POST', body: JSON.stringify({ cwd: state.cwd, cols: Math.floor(width / 8.5), rows: Math.floor((window.innerHeight - 170) / 18) }),
    });
    state.sessions.push(session);
    openSession(session.id);
  } catch (error) {
    toast(error.message, true);
  } finally { button.disabled = false; }
}
let browseVersion = 0;
async function browseDirectory(directory) {
  const version = ++browseVersion;
  $('choose-directory').disabled = true;
  $('directory-error').textContent = '';
  try {
    const body = await api(`/api/workspaces?path=${encodeURIComponent(directory)}`);
    if (version !== browseVersion) return;
    state.directory = body.path;
    $('path-input').value = body.path;
    $('directory-current').textContent = body.path;
    $('directory-list').replaceChildren();
    const entries = body.parent ? [{ name: '返回上级目录', path: body.parent, parent: true }, ...body.directories] : body.directories;
    for (const entry of entries) {
      const row = document.createElement('button');
      row.className = 'directory-row';
      row.type = 'button';
      row.append(icons('folder'));
      const label = document.createElement('span');
      label.className = 'directory-name';
      label.textContent = entry.parent ? '↑ 返回上级目录' : entry.name;
      row.append(label, icons('chevron'));
      row.addEventListener('click', () => browseDirectory(entry.path));
      $('directory-list').append(row);
    }
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'directory-empty';
      empty.textContent = '这个目录下没有可显示的子文件夹。';
      $('directory-list').append(empty);
    }
    $('choose-directory').disabled = false;
  } catch (error) {
    if (version === browseVersion) $('directory-error').textContent = error.message;
  }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-submit').disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ key: $('access-key').value.trim() }) });
    $('access-key').value = '';
    await loadApp();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); showLogin(); }
  catch (error) { toast(error.message, true); }
});
$('new-session').addEventListener('click', showWelcome);
$('start-session').addEventListener('click', startSession);
$('workspace-picker').addEventListener('click', () => {
  $('workspace-dialog').showModal();
  browseDirectory(state.cwd);
});
$('close-workspace').addEventListener('click', () => $('workspace-dialog').close());
$('path-form').addEventListener('submit', event => { event.preventDefault(); browseDirectory($('path-input').value); });
$('choose-directory').addEventListener('click', () => {
  state.cwd = state.directory;
  localStorage.setItem('copilot-workspace', state.cwd);
  $('selected-workspace').textContent = state.cwd;
  $('workspace-dialog').close();
});
$('menu-toggle').addEventListener('click', () => { $('sidebar').classList.toggle('open'); $('sidebar-shade').hidden = !$('sidebar').classList.contains('open'); });
$('sidebar-shade').addEventListener('click', closeSidebar);
$('close-session').addEventListener('click', () => {
  state.closeTarget = state.selected;
  $('confirm-dialog').showModal();
});
$('cancel-close').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-close').addEventListener('click', async () => {
  $('confirm-close').disabled = true;
  try {
    await api(`/api/sessions/${state.closeTarget}`, { method: 'DELETE' });
    $('confirm-dialog').close();
    await refreshSessions();
  } catch (error) { toast(error.message, true); }
  finally { $('confirm-close').disabled = false; }
});
$('copy-selection').addEventListener('click', async () => {
  const selection = state.terminal?.getSelection();
  if (!selection) return toast('请先在终端中选中需要复制的文字。');
  try { await navigator.clipboard.writeText(selection); toast('已复制选中的文字。'); }
  catch { toast('浏览器未允许剪贴板访问，可使用 Ctrl Shift C 复制。', true); }
});
function changeFont(amount) {
  state.fontSize = Math.max(10, Math.min(24, state.fontSize + amount));
  localStorage.setItem('copilot-font-size', state.fontSize);
  if (state.terminal) state.terminal.options.fontSize = state.fontSize;
  fitTerminal();
}
$('font-smaller').addEventListener('click', () => changeFont(-1));
$('font-larger').addEventListener('click', () => changeFont(1));
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('terminal-view').requestFullscreen();
  } catch { toast('当前浏览器不支持全屏，请使用浏览器的全屏功能。', true); }
});
const mobileKeys = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', interrupt: '\x03', enter: '\r' };
for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => {
    if (!sendTerminal({ type: 'input', data: mobileKeys[button.dataset.key] })) toast('终端未连接，按键未发送。', true);
    state.terminal?.focus();
  });
}
document.addEventListener('keydown', event => {
  if (event.altKey && event.key.toLowerCase() === 'n' && state.authenticated) { event.preventDefault(); showWelcome(); }
});
new ResizeObserver(() => requestAnimationFrame(fitTerminal)).observe($('terminal-container'));
document.addEventListener('fullscreenchange', () => requestAnimationFrame(fitTerminal));
window.addEventListener('online', () => { if (state.authenticated) refreshSessions().catch(error => toast(error.message, true)); });
api('/api/auth').then(auth => auth.authenticated ? loadApp() : showLogin()).catch(error => {
  showLogin();
  $('login-error').textContent = `无法连接本机服务：${error.message}`;
});
