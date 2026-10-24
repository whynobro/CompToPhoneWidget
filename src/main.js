const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, screen, safeStorage, nativeImage, nativeTheme, shell, Notification, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const sender = require('./sender');
const dropserver = require('./dropserver');
const { startInbox } = require('./ntfyinbox');
const taskbar = require('./taskbar');
const { readWallpaper, watchWallpaper } = require('./wallpaper');

const CARD = 136; // desktop glass tile, a bit under a 2x2 block of desktop icons
const MARGIN = 16; // transparent room for the drop shadow
const SIZE = CARD + MARGIN * 2;
const BAR_W = 150; // taskbar capsule window (capsule itself is drawn narrower in CSS)
const BAR_W_COMPACT = 52; // icon-only capsule once apps crowd the gap left of Start
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.whynobro.sendtophone');

// ---------- settings (password encrypted with Windows DPAPI via safeStorage) ----------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  method: 'auto', // 'auto' (Gmail, Drive for big files) | 'email' | 'drive' | 'ntfy'
  email: { user: '', to: '', passEnc: '' },
  drive: { remote: 'stp_gdrive', folder: 'From PC', rclone: '' },
  ntfy: { server: 'https://ntfy.sh', topic: '' },
  placement: 'taskbar', // 'taskbar' | 'desktop'
  pos: null,
  barBounds: null, // last UI Automation fix, so the capsule opens in place instead of jumping
  onTop: false,
  // Phone -> PC. Off until the Receive window is first opened, so the Windows firewall
  // prompt for the Wi-Fi page shows up when the user is expecting it, not at boot.
  receive: { on: null, port: 47800, token: '', topic: '', cursor: '' },
};

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s.method === 'both') s.method = 'auto'; // "Both" sent every file twice; retired
    return {
      ...DEFAULTS,
      ...s,
      email: { ...DEFAULTS.email, ...s.email },
      drive: { ...DEFAULTS.drive, ...s.drive },
      ntfy: { ...DEFAULTS.ntfy, ...s.ntfy },
      receive: { ...DEFAULTS.receive, ...s.receive },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
const firstRun = !fs.existsSync(SETTINGS_FILE);
let settings = loadSettings();
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
// Short enough to type off the screen, no look-alike characters (0/o, 1/l/i).
const newToken = () => [...crypto.randomBytes(8)].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
if (!settings.ntfy.topic || !settings.receive.token || !settings.receive.topic) {
  settings.ntfy.topic ||= 'phone-' + crypto.randomBytes(6).toString('hex');
  settings.receive.token ||= newToken();
  settings.receive.topic ||= 'pc-' + crypto.randomBytes(6).toString('hex');
  saveSettings();
}

async function decryptPass() {
  if (!settings.email.passEnc) return '';
  try {
    const r = await safeStorage.decryptStringAsync(Buffer.from(settings.email.passEnc, 'base64'));
    return typeof r === 'string' ? r : r.result;
  } catch {
    return '';
  }
}

async function encryptPass(plain) {
  const buf = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(plain) : safeStorage.encryptString(plain);
  return Buffer.from(buf).toString('base64');
}

// ---------- Google Drive (rclone) ----------
const RCLONE_CONF = path.join(process.env.APPDATA || '', 'rclone', 'rclone.conf');

// winget puts rclone under WinGet\Packages and links it on PATH; the Run-key launch may predate PATH changes.
function findRclone() {
  if (settings.drive.rclone && fs.existsSync(settings.drive.rclone)) return settings.drive.rclone;
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [path.join(local, 'Microsoft', 'WinGet', 'Links', 'rclone.exe')];
  try {
    candidates.push(...execFileSync('where', ['rclone'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean));
  } catch {}
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgs).filter((n) => n.startsWith('Rclone.Rclone'))) {
      for (const sub of fs.readdirSync(path.join(pkgs, d))) candidates.push(path.join(pkgs, d, sub, 'rclone.exe'));
    }
  } catch {}
  const found = candidates.find((p) => fs.existsSync(p)) || '';
  if (found && found !== settings.drive.rclone) {
    settings.drive.rclone = found;
    saveSettings();
  }
  return found;
}

function driveReady() {
  try {
    return !!findRclone() && fs.readFileSync(RCLONE_CONF, 'utf8').includes(`[${settings.drive.remote}]`);
  } catch {
    return false;
  }
}

async function sendConfig() {
  return {
    method: settings.method,
    email: { ...settings.email, pass: await decryptPass() },
    drive: { ...settings.drive, rclone: findRclone() },
    ntfy: settings.ntfy,
  };
}

const emailReady = () => !!(settings.email.user && settings.email.passEnc);
const isConfigured = () =>
  ({ auto: emailReady(), email: emailReady(), drive: driveReady(), ntfy: !!settings.ntfy.topic })[settings.method];

// Taskbar uses its own light/dark switch, separate from the app theme. Read once, then
// refreshed off the main thread (geometry() runs on every move event, so no sync spawn there).
const PERSONALIZE = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'];
let taskbarLight = null;
function taskbarIsLight() {
  if (taskbarLight === null) {
    try {
      taskbarLight = /0x1\b/.test(execFileSync('reg', PERSONALIZE, { encoding: 'utf8', windowsHide: true }));
    } catch {
      taskbarLight = false;
    }
  }
  return taskbarLight;
}
function refreshTaskbarLight() {
  execFile('reg', PERSONALIZE, { windowsHide: true }, (err, out) => {
    const light = !err && /0x1\b/.test(out);
    if (light !== taskbarLight) {
      taskbarLight = light;
      pushGeo();
    }
  });
}

// ---------- windows ----------
let widget = null;
let settingsWin = null;
let noteWin = null;
let receiveWin = null;
let tray = null;
let barTimer = null;
let locateTimer = null;
let menuOpen = false;

const inTaskbar = () => settings.placement === 'taskbar';

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - SIZE - 24, y: wa.y + 24 };
}

function clampToScreen(pos) {
  const d = screen.getDisplayNearestPoint(pos);
  const wa = d.workArea;
  return {
    x: Math.min(Math.max(pos.x, wa.x - MARGIN), wa.x + wa.width - SIZE + MARGIN),
    y: Math.min(Math.max(pos.y, wa.y - MARGIN), wa.y + wa.height - SIZE + MARGIN),
  };
}

// First guess before UI Automation answers: the bottom strip left of center.
function guessBarBounds() {
  const d = screen.getPrimaryDisplay();
  const h = Math.max(d.bounds.height - d.workArea.height, 40);
  return { x: Math.round(d.bounds.x + d.bounds.width * 0.18), y: d.bounds.y + d.bounds.height - h, width: BAR_W, height: h };
}

// Remembered capsule spot, if it still sits on the bottom edge of the primary display.
function rememberedBar() {
  const b = settings.barBounds;
  const d = screen.getPrimaryDisplay().bounds;
  if (!b || b.x < d.x || b.x + b.width > d.x + d.width || Math.abs(b.y + b.height - (d.y + d.height)) > 2) return null;
  return b;
}

async function positionBar() {
  refreshTaskbarLight();
  const loc = await taskbar.locate();
  if (!loc || !widget || widget.isDestroyed() || !inTaskbar()) return;
  const dip = (r) => r && screen.screenToDipRect(null, r);
  const t = dip(loc.tray);
  const start = dip(loc.start);
  const widgets = dip(loc.widgets);
  const left = widgets ? widgets.x + widgets.width : t.x + 8;
  const right = start && start.x > left ? start.x : t.x + t.width / 2;
  const w = right - left >= BAR_W + 8 ? BAR_W : BAR_W_COMPACT;
  let x = Math.round((left + right) / 2 - w / 2);
  if (right - left < w + 8) x = Math.round(right - w - 4);
  const next = { x, y: Math.round(t.y), width: w, height: Math.round(t.height) };
  const cur = widget.getBounds();
  if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) widget.setBounds(next);
  const saved = settings.barBounds;
  if (!saved || saved.x !== next.x || saved.y !== next.y || saved.width !== next.width || saved.height !== next.height) {
    settings.barBounds = next;
    saveSettings();
  }
}

// Keep the capsule above the taskbar, and out of the way of fullscreen video/games.
function tickBar() {
  if (!widget || widget.isDestroyed() || menuOpen) return;
  const d = screen.getDisplayMatching(widget.getBounds());
  if (taskbar.foregroundIsFullscreen(screen.dipToScreenRect(null, d.bounds))) {
    if (widget.isVisible()) widget.hide();
    return;
  }
  if (!widget.isVisible()) widget.showInactive();
  taskbar.raise(widget);
}

function geometry() {
  const b = widget.getBounds();
  const d = screen.getDisplayMatching(b);
  const all = screen.getAllDisplays().map((x) => x.bounds);
  const virt = {
    x: Math.min(...all.map((r) => r.x)),
    y: Math.min(...all.map((r) => r.y)),
  };
  virt.width = Math.max(...all.map((r) => r.x + r.width)) - virt.x;
  virt.height = Math.max(...all.map((r) => r.y + r.height)) - virt.y;
  return { win: b, display: d.bounds, virtual: virt, margin: MARGIN, card: CARD, placement: settings.placement, taskbarLight: taskbarIsLight() };
}

function pushGeo() {
  if (widget && !widget.isDestroyed()) widget.webContents.send('geometry', geometry());
}

function createWidget() {
  const bar = inTaskbar();
  const remembered = bar && rememberedBar();
  const bounds = bar ? remembered || guessBarBounds() : { ...clampToScreen(settings.pos || defaultPos()), width: SIZE, height: SIZE };
  const win = (widget = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: bar || settings.onTop,
    show: false,
    title: 'Send to Phone',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  }));
  widget.setMenu(null);
  if (bar) widget.setBounds(bounds); // constructor rounds frameless bounds at fractional DPI
  // Placement rides in the URL so the very first paint already has the right shape.
  widget.loadFile(path.join(__dirname, 'widget.html'), { query: { placement: settings.placement, light: bar && taskbarIsLight() ? '1' : '' } });
  const firstFix = bar ? positionBar() : null;
  widget.once('ready-to-show', async () => {
    // First run has no remembered spot: wait for UI Automation rather than show a guess that jumps.
    if (bar && !remembered) await firstFix;
    if (win !== widget || win.isDestroyed()) return;
    win.showInactive();
    if (bar) barTimer = setInterval(tickBar, 1000);
  });

  widget.on('move', pushGeo);
  widget.on('moved', () => {
    if (!bar) {
      const [x, y] = widget.getPosition();
      settings.pos = { x, y };
      saveSettings();
    }
    pushGeo();
  });
  // Block navigation if a drop ever slips past the renderer's handler.
  widget.webContents.on('will-navigate', (e) => e.preventDefault());
  // Alt+F4 destroys the window but the app lives on in the tray; showWidget rebuilds it.
  win.on('closed', () => {
    if (win !== widget) return;
    clearInterval(barTimer);
    clearInterval(locateTimer);
    widget = null;
  });

  if (bar) {
    widget.setAlwaysOnTop(true, 'screen-saver');
    locateTimer = setInterval(positionBar, 30000); // Start moves when apps are pinned/unpinned
  }
}

function rebuildWidget() {
  clearInterval(barTimer);
  clearInterval(locateTimer);
  widget?.destroy();
  createWidget();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 440,
    height: 720,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Send to Phone Settings',
    icon: ICON,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}

function loginItem() {
  return { path: process.execPath, args: app.isPackaged ? [] : [path.resolve(app.getAppPath())] };
}

function setPlacement(p) {
  if (settings.placement === p) return;
  settings.placement = p;
  saveSettings();
  rebuildWidget();
}

function contextMenu() {
  const bar = inTaskbar();
  return Menu.buildFromTemplate([
    { label: 'Send a note or link…', click: openNote },
    { label: 'Send files…', click: () => pickAndSend() },
    { label: 'Receive from phone…', click: openReceive },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'In taskbar', type: 'radio', checked: bar, click: () => setPlacement('taskbar') },
    { label: 'On desktop', type: 'radio', checked: !bar, click: () => setPlacement('desktop') },
    { type: 'separator' },
    {
      label: 'Keep on top',
      type: 'checkbox',
      checked: settings.onTop,
      visible: !bar,
      click: (i) => {
        settings.onTop = i.checked;
        widget?.setAlwaysOnTop(i.checked);
        saveSettings();
      },
    },
    {
      label: 'Reset position',
      visible: !bar,
      click: () => {
        widget?.setPosition(defaultPos().x, defaultPos().y);
        settings.pos = null;
        saveSettings();
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (i) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: i.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function popupMenu() {
  menuOpen = true;
  contextMenu().popup({ window: widget, callback: () => (menuOpen = false) });
}

function showWidget() {
  if (!widget) return app.isReady() && createWidget();
  widget.show();
  widget.moveTop();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Send to Phone');
  tray.on('click', showWidget);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu()));
}

// ---------- sending ----------
function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON, silent: true }).show();
}

async function doSend(paths) {
  if (!isConfigured()) {
    openSettings();
    throw new Error('Finish setup first.');
  }
  const onProgress = (p) => widget?.webContents.send('progress', p);
  const r = await sender.send(paths, await sendConfig(), { onProgress });
  const title = r.count === 1 ? 'Sent' : `Sent ${r.count} files`;
  return { title, detail: `via ${r.via.join(' + ')}` };
}

async function pickFiles() {
  const r = await dialog.showOpenDialog(widget, { title: 'Send to phone', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
}

async function pickAndSend() {
  const paths = await pickFiles();
  if (paths.length) widget?.webContents.send('external-send', paths);
}

ipcMain.handle('send', async (_e, paths) => {
  try {
    return { ok: true, ...(await doSend(paths)) };
  } catch (err) {
    const message = String(err.message || err);
    // The taskbar capsule is too small for an explanation, so say it in a toast.
    if (inTaskbar()) notify("Didn't send", message);
    return { ok: false, message };
  }
});
ipcMain.handle('pick', pickFiles);
// The taskbar capsule never draws the wallpaper, so skip reading and base64-ing it there.
ipcMain.handle('init', () => ({ geometry: geometry(), wallpaper: inTaskbar() ? null : readWallpaper(), configured: isConfigured() }));
ipcMain.on('menu', popupMenu);
ipcMain.on('open-settings', openSettings);

// ---------- notes & links (always via ntfy) ----------
const NOTE_W = 360;
const NOTE_H = 200;

// Pops up just above the taskbar capsule, or beside the desktop tile.
function openNote() {
  if (noteWin && !noteWin.isDestroyed()) return noteWin.focus();
  if (!widget) createWidget();
  const b = widget.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  let x = Math.round(b.x + b.width / 2 - NOTE_W / 2);
  let y = inTaskbar() ? b.y - NOTE_H - 10 : b.y + b.height + 4;
  if (y + NOTE_H > wa.y + wa.height) y = b.y - NOTE_H - 4;
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - NOTE_W - 8);
  noteWin = new BrowserWindow({
    x,
    y: Math.max(y, wa.y + 8),
    width: NOTE_W,
    height: NOTE_H,
    titleBarStyle: 'hidden', // keeps the frame so Win11 acrylic + rounded corners work
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Send a note',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  noteWin.setMenu(null);
  noteWin.loadFile(path.join(__dirname, 'note.html'));
  noteWin.once('ready-to-show', () => noteWin.show());
  noteWin.on('blur', () => noteWin && !noteWin.isDestroyed() && !noteWin.webContents.isDevToolsOpened() && noteWin.close());
}

ipcMain.handle('note:init', () => {
  const clip = clipboard.readText().trim();
  return { prefill: /^https?:\/\/\S+$/i.test(clip) ? clip : '' };
});
ipcMain.on('note:open', openNote);
ipcMain.on('note:close',() => noteWin && !noteWin.isDestroyed() && noteWin.close());
ipcMain.handle('note:send', async (_e, text) => {
  try {
    const r = await sender.sendNote(text, settings.ntfy);
    const message = r.link ? 'Link sent' : 'Note sent';
    widget?.webContents.send('note-sent', message);
    return { ok: true, message };
  } catch (err) {
    const message = String(err.message || err);
    if (inTaskbar() && !(noteWin && !noteWin.isDestroyed())) notify("Didn't send", message);
    return { ok: false, message };
  }
});

// ---------- receiving (phone -> PC, straight into Downloads) ----------
let drop = null; // Wi-Fi drop page server
let inbox = null; // ntfy inbox subscription
let dropError = '';
let arrived = [];
let arrivedTimer = null;

const downloadsDir = () => app.getPath('downloads');

// Several photos at once should be one toast, not five.
function received(f) {
  arrived.push(f);
  widget?.webContents.send('received', f.name);
  clearTimeout(arrivedTimer);
  arrivedTimer = setTimeout(() => {
    const files = arrived.splice(0);
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: files.length === 1 ? 'From your phone' : `${files.length} files from your phone`,
      body: files.length === 1 ? `${files[0].name} is in Downloads` : files.map((x) => x.name).join(', '),
      icon: ICON,
      silent: true,
    });
    n.on('click', () => (files.length === 1 ? shell.showItemInFolder(files[0].path) : shell.openPath(downloadsDir())));
    n.show();
  }, 1500);
}

// Text shared to the inbox: links open on click, anything else goes on the clipboard.
function receivedText({ title, message, click }) {
  const text = String(message || '').trim();
  const url = [click, text].find((u) => /^https?:\/\/\S+$/i.test(u || ''));
  if (!url) clipboard.writeText(text);
  widget?.webContents.send('received', url ? 'Link' : 'Note');
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || (url ? 'Link from your phone' : 'Copied from your phone'), body: text, icon: ICON, silent: true });
  if (url) n.on('click', () => shell.openExternal(url));
  n.show();
}

async function startReceiving() {
  const r = settings.receive;
  if (!drop) {
    try {
      drop = await dropserver.startDropServer({ port: r.port, token: r.token, dir: downloadsDir, pcName: os.hostname(), onReceived: received });
      dropError = '';
      if (drop.port !== r.port) {
        r.port = drop.port;
        saveSettings();
      }
    } catch (err) {
      dropError = String(err.message || err);
    }
  }
  inbox ||= startInbox({
    server: settings.ntfy.server,
    topic: r.topic,
    since: r.cursor,
    dir: downloadsDir,
    onFile: received,
    onText: receivedText,
    onCursor: (id) => {
      settings.receive.cursor = id;
      saveSettings();
    },
    onStatus: (state, err) => state === 'error' && notify("Didn't receive", String(err?.message || err)),
  });
}

async function stopReceiving() {
  inbox?.stop();
  inbox = null;
  const d = drop;
  drop = null;
  await d?.close();
}

async function receiveInfo() {
  const r = settings.receive;
  const ips = drop ? dropserver.lanAddresses() : [];
  const urls = ips.map((ip) => `http://${ip}:${drop.port}/${r.token}`);
  return {
    on: !!r.on,
    urls,
    qr: urls[0] ? await require('qrcode').toDataURL(urls[0], { margin: 1, width: 240 }) : '',
    error: r.on && !drop ? dropError || 'Wi-Fi page is not running.' : r.on && !urls.length ? 'No Wi-Fi or network connection found.' : '',
    topic: r.topic,
    server: settings.ntfy.server.replace(/\/+$/, ''),
    folder: downloadsDir(),
  };
}

function openReceive() {
  if (receiveWin && !receiveWin.isDestroyed()) return receiveWin.focus();
  receiveWin = new BrowserWindow({
    width: 440,
    height: 690,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'Receive from Phone',
    icon: ICON,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  receiveWin.setMenu(null);
  receiveWin.loadFile(path.join(__dirname, 'receive.html'));
}

ipcMain.on('receive:open', openReceive);
ipcMain.handle('receive:get', async () => {
  if (settings.receive.on === null) {
    settings.receive.on = true;
    saveSettings();
  }
  if (settings.receive.on) await startReceiving();
  return receiveInfo();
});
ipcMain.handle('receive:set', async (_e, on) => {
  settings.receive.on = !!on;
  saveSettings();
  await (on ? startReceiving() : stopReceiving());
  return receiveInfo();
});
// Anyone who saw the old link (or scanned the old QR) is locked out.
ipcMain.handle('receive:reset', async () => {
  settings.receive.token = newToken();
  saveSettings();
  await stopReceiving();
  if (settings.receive.on) await startReceiving();
  return receiveInfo();
});
ipcMain.on('receive:folder', () => shell.openPath(downloadsDir()));

ipcMain.handle('settings:get', async () => ({
  method: settings.method,
  email: { user: settings.email.user, to: settings.email.to, hasPass: !!settings.email.passEnc },
  drive: { folder: settings.drive.folder, connected: driveReady(), rcloneFound: !!findRclone() },
  ntfy: settings.ntfy,
  encryption: safeStorage.isEncryptionAvailable(),
}));
// Opens the browser for Google consent; rclone listens on 127.0.0.1:53682 for the code.
ipcMain.handle('settings:drive-connect', async () => {
  const bin = findRclone();
  if (!bin) return { ok: false, message: 'rclone not found. Install it: winget install Rclone.Rclone' };
  try {
    const exists = driveReady();
    const args = exists
      ? ['config', 'reconnect', `${settings.drive.remote}:`, '--auto-confirm']
      : ['config', 'create', settings.drive.remote, 'drive', 'scope=drive.file'];
    await sender.runRclone(bin, args);
    return { ok: driveReady(), message: driveReady() ? 'Google Drive connected.' : 'Connection did not finish.' };
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
});
// Android's ntfy app subscribes from ntfy:// deep links; iOS has no equivalent.
ipcMain.handle('settings:qr', (_e, s) => {
  const host = (s.server || 'https://ntfy.sh').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return require('qrcode').toDataURL(`ntfy://${host}/${s.topic}`, { margin: 1, width: 220 });
});
ipcMain.handle('settings:save', async (_e, s) => {
  settings.method = ['auto', 'email', 'drive', 'ntfy'].includes(s.method) ? s.method : 'auto';
  settings.email.user = (s.email.user || '').trim();
  settings.email.to = (s.email.to || '').trim();
  if (s.email.pass) settings.email.passEnc = await encryptPass(s.email.pass);
  settings.drive.folder = (s.drive.folder || 'From PC').trim().replace(/[\\:]/g, '');
  const server = (s.ntfy.server || 'https://ntfy.sh').trim();
  const serverChanged = server !== settings.ntfy.server;
  settings.ntfy.server = server;
  settings.ntfy.topic = (s.ntfy.topic || '').trim();
  saveSettings();
  if (serverChanged && inbox) {
    // The inbox lives on the same ntfy server; its cursor means nothing on a new one.
    inbox.stop();
    inbox = null;
    settings.receive.cursor = '';
    startReceiving();
  }
  widget?.webContents.send('configured', isConfigured());
  return true;
});
async function testNtfy(n) {
  const base = (n.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const res = await fetch(`${base}/${encodeURIComponent(n.topic)}`, {
    method: 'POST',
    headers: { Title: 'Send to Phone', Tags: 'white_check_mark' },
    body: 'Test notification. Your PC widget is connected.',
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}
ipcMain.handle('settings:test', async (_e, s) => {
  const done = [];
  try {
    if (s.method === 'auto' || s.method === 'email') {
      await sender.verifyEmail({ user: s.email.user, pass: s.email.pass || (await decryptPass()) });
      done.push('Gmail login works');
    }
    if (s.method === 'auto' || s.method === 'drive') {
      if (driveReady()) {
        await sender.verifyDrive({ rclone: findRclone(), remote: settings.drive.remote });
        done.push('Google Drive works');
      } else if (s.method === 'drive') {
        throw new Error('Google Drive not connected yet.');
      } else {
        done.push('Drive not connected (only needed for files over 18 MB)');
      }
    }
    if (s.method === 'ntfy') {
      await testNtfy(s.ntfy);
      done.push('ntfy test pushed, check your phone');
    }
    return { ok: true, message: done.join('. ') + '.' };
  } catch (err) {
    return { ok: false, message: [...done, String(err.message || err)].join('. ') };
  }
});
ipcMain.on('open-url', (_e, url) => /^https:\/\//.test(url) && shell.openExternal(url));

// ---------- lifecycle ----------
app.on('second-instance', showWidget);
app.whenReady().then(() => {
  // A desktop widget should survive reboots; toggle lives in the right-click menu.
  if (firstRun) app.setLoginItemSettings({ ...loginItem(), openAtLogin: true });
  createWidget();
  createTray();
  if (settings.receive.on) startReceiving();
  screen.on('display-metrics-changed', () => (inTaskbar() ? positionBar() : pushGeo()));
  watchWallpaper(() => !inTaskbar() && widget?.webContents.send('wallpaper', readWallpaper()));
  nativeTheme.on('updated', refreshTaskbarLight);
  if (!isConfigured()) widget.once('ready-to-show', openSettings);
});
// Widget lives in the tray; closing Settings must not quit.
app.on('window-all-closed', () => {});
