/* global Terminal, FitAddon */
'use strict';
const $ = id => document.getElementById(id);
$('favicon').href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#c9f277">${$('i-bot').innerHTML}</svg>`)}`;
const state = {
  info: null, sessions: [], history: [], sessionTab: 'active', selected: null, cwd: '', directory: '', terminal: null, fit: null,
  socket: null, reconnect: null, refresh: null, closeTarget: null, toastTimer: null,
  selectionText: '',
  selectionDrag: null,
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
  state.selectionDrag = null;
  clearCopySelection();
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
  const [body, history] = await Promise.all([api('/api/sessions'), api('/api/history')]);
  state.sessions = body.sessions;
  state.history = history.sessions;
  renderSessions();
  if (state.selected && !state.sessions.some(s => s.id === state.selected)) showWelcome();
}
function renderSessions() {
  $('session-list').replaceChildren();
  $('session-count').textContent = `${state.sessions.length} / ${state.info.maxSessions}`;
  $('history-count').textContent = state.history.length;
  $('active-tab').setAttribute('aria-selected', state.sessionTab === 'active');
  $('history-tab').setAttribute('aria-selected', state.sessionTab === 'history');
  const list = state.sessionTab === 'history' ? state.history : state.sessions;
  $('no-sessions').hidden = list.length > 0;
  $('no-sessions').textContent = state.sessionTab === 'history' ? '暂无可恢复的历史会话' : '暂无当前会话，可在“历史会话”中恢复对话。';
  for (const session of list) {
    const button = document.createElement('button');
    button.className = `session-item${state.selected === session.id ? ' active' : ''}`;
    button.title = session.cwd;
    if (state.sessionTab === 'history' && session.busy) {
      button.disabled = true;
      button.title = `${session.cwd} · 正在使用，不能重复恢复`;
    }
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
    meta.textContent = state.sessionTab === 'history'
      ? `${new Date(session.createdAt).toLocaleDateString('zh-CN')} ${date} · ${session.busy ? '正在使用' : '点击恢复'}`
      : `${date} · ${session.status === 'running' ? '运行中' : `已结束 (${session.exitCode})`}`;
    info.append(name, meta);
    const dot = document.createElement('span');
    dot.className = `status-dot${session.status === 'running' ? '' : ' offline'}`;
    button.append(info, dot);
    button.addEventListener('click', () => {
      if (state.sessionTab === 'history') resumeSession(session.id, button);
      else openSession(session.id);
    });
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
  state.sessionTab = 'active';
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
  state.terminal.onSelectionChange(() => {
    const text = state.terminal?.getSelection();
    if (text) rememberCopySelection(text);
  });
  state.terminal.onData(data => {
    if (state.socket?.readyState !== WebSocket.OPEN) {
      toast('终端尚未连接，输入未发送。', true);
      return;
    }
    for (let i = 0; i < data.length; i += 16000) sendTerminal({ type: 'input', data: data.slice(i, i + 16000) });
  });
  state.terminal.attachCustomKeyEventHandler(event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
      return false;
    }
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
      else if (message.type === 'error') toast(message.message, true);
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
async function resumeSession(id, button) {
  button.disabled = true;
  try {
    const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ resumeId: id }) });
    await refreshSessions();
    openSession(session.id);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
$('active-tab').addEventListener('click', () => { state.sessionTab = 'active'; renderSessions(); });
$('history-tab').addEventListener('click', () => { state.sessionTab = 'history'; refreshSessions().catch(error => toast(error.message, true)); });
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
    state.sessionTab = 'history';
    $('confirm-dialog').close();
    await refreshSessions();
  } catch (error) { toast(error.message, true); }
  finally { $('confirm-close').disabled = false; }
});
function showCopyText(text) {
  $('copy-text').value = text;
  if (!$('copy-dialog').open) $('copy-dialog').showModal();
  $('copy-text').focus();
  $('copy-text').select();
}
async function copyText(text) {
  const previousFocus = document.activeElement;
  const temporary = document.createElement('textarea');
  temporary.value = text;
  temporary.readOnly = true;
  temporary.setAttribute('aria-label', '临时复制文本');
  temporary.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;font-size:16px;';
  (document.querySelector('dialog[open]') ?? document.body).append(temporary);
  let copied = false;
  try {
    temporary.focus();
    temporary.select();
    copied = document.execCommand('copy');
  } catch (error) {
    console.warn('Browser synchronous copy is unavailable:', error.name);
  } finally {
    temporary.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }
  if (copied) {
    toast('已复制文字。');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制文字。');
  } catch {
    showCopyText(text);
    toast('剪贴板访问被拒绝，请在文本框中长按或按 Ctrl C 复制。', true);
  }
}
function copySelection() {
  const selection = selectedTerminalText();
  if (!selection) return toast('请先选中文字，或点击“复制终端文本”。Ctrl C 不会发送给 Copilot。');
  return copyText(selection);
}
function selectedTerminalText() {
  const nativeSelection = window.getSelection();
  if (nativeSelection && !nativeSelection.isCollapsed &&
      $('terminal-container').contains(nativeSelection.anchorNode) &&
      $('terminal-container').contains(nativeSelection.focusNode)) {
    const text = nativeSelection.toString();
    if (text) return text;
  }
  return state.terminal?.getSelection() || state.selectionText;
}
function rememberCopySelection(text) {
  state.selectionText = text;
  $('selection-status').textContent = `已选 ${text.length} 字`;
  $('copy-selection').classList.add('has-selection');
}
function clearCopySelection() {
  state.selectionText = '';
  $('selection-status').textContent = '';
  $('copy-selection').classList.remove('has-selection');
}
$('terminal-container').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  clearCopySelection();
  state.selectionDrag = event.shiftKey && event.pointerType === 'mouse'
    ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, sessionId: state.selected }
    : null;
}, true);
document.addEventListener('pointermove', event => {
  const drag = state.selectionDrag;
  if (drag?.id === event.pointerId && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 3) drag.moved = true;
}, true);
document.addEventListener('pointerup', event => {
  const drag = state.selectionDrag;
  if (!drag || drag.id !== event.pointerId) return;
  state.selectionDrag = null;
  if (!drag.moved || drag.sessionId !== state.selected) return;
  const text = selectedTerminalText();
  if (text) {
    rememberCopySelection(text);
    copyText(text);
  }
});
document.addEventListener('pointercancel', () => { state.selectionDrag = null; }, true);
$('terminal-container').addEventListener('pointerup', () => {
  const text = selectedTerminalText();
  if (text) rememberCopySelection(text);
});
$('terminal-container').addEventListener('keydown', event => {
  if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) clearCopySelection();
}, true);
$('terminal-container').addEventListener('paste', clearCopySelection, true);
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed &&
      $('terminal-container').contains(selection.anchorNode) &&
      $('terminal-container').contains(selection.focusNode)) {
    const text = selection.toString();
    if (text) rememberCopySelection(text);
  }
});
let buttonSelection = '';
$('copy-selection').addEventListener('pointerdown', () => { buttonSelection = selectedTerminalText(); });
$('copy-selection').addEventListener('click', () => {
  const text = selectedTerminalText() || buttonSelection;
  buttonSelection = '';
  if (text) copyText(text);
  else copySelection();
});
document.addEventListener('copy', event => {
  if ($('terminal-view').hidden || document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') &&
      !$('terminal-container').contains(target)) return;
  const text = selectedTerminalText();
  if (!text || !event.clipboardData) return;
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
  event.stopImmediatePropagation();
  toast('已复制文字。');
}, true);
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'c' ||
      $('terminal-view').hidden || document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') &&
      !$('terminal-container').contains(target)) return;
  const text = selectedTerminalText();
  if (!$('terminal-container').contains(target) && !text) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  if (!event.repeat) copySelection();
}, true);
$('copy-all').addEventListener('click', () => {
  if (!state.terminal) return;
  const buffer = state.terminal.buffer.active;
  let text = '';
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const wrapped = buffer.getLine(i + 1)?.isWrapped;
    text += line.translateToString(!wrapped);
    if (!wrapped) text += '\n';
  }
  showCopyText(text.trimEnd());
});
$('close-copy').addEventListener('click', () => $('copy-dialog').close());
$('copy-text-button').addEventListener('click', () => copyText($('copy-text').value));
let interruptTarget = null;
function confirmInterrupt() {
  interruptTarget = state.selected;
  $('interrupt-dialog').showModal();
}
$('interrupt-session').addEventListener('click', confirmInterrupt);
$('cancel-interrupt').addEventListener('click', () => $('interrupt-dialog').close());
$('confirm-interrupt').addEventListener('click', () => {
  clearCopySelection();
  if (state.selected !== interruptTarget || !sendTerminal({ type: 'input', data: '\x03' })) {
    toast('会话已切换或连接已断开，中断未发送。', true);
  }
  $('interrupt-dialog').close();
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
const mobileKeys = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', enter: '\r' };
for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => {
    if (button.dataset.key === 'interrupt') return confirmInterrupt();
    clearCopySelection();
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
