// Win11 removed taskbar deskbands, so "in the taskbar" = a topmost window parked over
// the empty strip between the Widgets (weather) button and Start.
const { execFile } = require('child_process');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hwnd, _Out_ uint8_t *buf, int max)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)');

const HWND_TOPMOST = -1;
const SWP_NOSIZE_NOMOVE_NOACTIVATE = 0x0001 | 0x0002 | 0x0010;
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

// UI Automation exposes the XAML taskbar's buttons; rects come back in physical pixels.
const UIA_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $S=[System.Windows.Automation.TreeScope]
$tray=$A::RootElement.FindFirst($S::Children,(New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty,'Shell_TrayWnd')))
$o=@{}
if($tray){ $o.tray=$tray.Current.BoundingRectangle
  foreach($id in 'StartButton','WidgetsButton'){ $e=$tray.FindFirst($S::Descendants,(New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty,$id))); if($e){ $o[$id]=$e.Current.BoundingRectangle } } }
$o | ConvertTo-Json -Compress`;

function locate() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', UIA_SCRIPT], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        const r = (x) => x && { x: x.X, y: x.Y, width: x.Width, height: x.Height };
        resolve(j.tray ? { tray: r(j.tray), start: r(j.StartButton), widgets: r(j.WidgetsButton) } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

const hwndOf = (win) => win.getNativeWindowHandle().readBigInt64LE(0);

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return buf.toString('utf16le', 0, n * 2);
}

// True when the active app covers the whole monitor (video, game), so the taskbar is hidden.
function foregroundIsFullscreen(physDisplay) {
  const fg = GetForegroundWindow();
  if (!fg || DESKTOP_CLASSES.has(className(fg))) return false;
  const r = {};
  if (!GetWindowRect(fg, r)) return false;
  return r.left <= physDisplay.x && r.top <= physDisplay.y &&
    r.right >= physDisplay.x + physDisplay.width && r.bottom >= physDisplay.y + physDisplay.height;
}

// Clicking the taskbar raises it within the topmost band; push ourselves back above it.
function raise(win) {
  SetWindowPos(hwndOf(win), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE);
}

module.exports = { locate, foregroundIsFullscreen, raise };
