# Send to Phone

Translucent drop target that sends files to your phone. No Bluetooth, no Phone Link. Drop files on it, or click it to pick files.

**Requires Windows 11.** The taskbar capsule depends on the Win11 taskbar layout.

## Install

1. Download `Send-to-Phone-Setup-x.y.z.exe` from [Releases](https://github.com/whynobro/CompToPhoneWidget/releases/latest) and run it. It installs for your user only (no admin) and starts the widget.
2. The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Settings opens on first run. Pick a delivery method and fill it in (see below). Your password and tokens stay on your PC in `%APPDATA%\Send to Phone`; nothing is shared with anyone else's install.

Uninstall from Settings → Apps.

Two placements (right-click to switch):
- **In taskbar** (default): small capsule centered between the Widgets/weather button and Start. Win11 has no taskbar add-in API, so it is a topmost window located via UI Automation ([src/taskbar.js](src/taskbar.js)), re-raised every second, hidden while a fullscreen app is active, and re-positioned every 30 s (Start moves when apps are pinned). The last fix is saved (`barBounds`), so later launches open in place instead of waiting on UI Automation. Errors show as a Windows toast.
- **On desktop**: 136 px frosted-glass tile, drag the bar at its top to move.

## Delivery methods

Settings picks one mode. Each file lands in exactly one place.

- **Auto** (default): files up to 18 MB go to Gmail as attachments; bigger files upload to Google Drive (`From PC` folder) and are linked in the same email. One inbox to check, no duplicates.
- **Gmail**, **Drive**, or **ntfy**: everything to that single channel.

| Channel | Phone needs | Limit | Notes |
|---|---|---|---|
| **Gmail** | Gmail app (already have it) | 18 MB per email (larger batches split) | Needs a Gmail [app password](https://myaccount.google.com/apppasswords) (2-Step Verification on). Files stay in Gmail. |
| **Google Drive** | Drive app | Any size | Uploaded with [rclone](https://rclone.org) (`winget install Rclone.Rclone`), remote `stp_gdrive`, scope `drive.file` (sees only its own uploads). Connect/Reconnect in Settings opens a Google consent page. Upload % shows on the widget. |
| **Push (ntfy)** | [ntfy](https://ntfy.sh) app, subscribed to your topic | 15 MB per file | Instant notification, no account. ntfy.sh keeps files ~3 hours. Topic name acts as the password. Android: scan the QR in Settings. iPhone: Copy topic, paste in ntfy's + dialog. Nothing arrives on the phone until it is subscribed. |

Set up via right-click → **Settings…** (opens automatically on first run). The app password is encrypted with Windows DPAPI (`safeStorage`).

## Use

- **Drop** files on the tile, or **click** to open a file picker (multi-select OK).
- **Notes and links** always go through ntfy (instant; tapping a link notification opens it):
  - drag a link or selected text from any app onto the widget, or
  - right-click → **Send a note or link…** (pre-fills a link from the clipboard; Ctrl+Enter sends, Esc closes).
- **Right-click**: Send a note or link, Send files, Settings, In taskbar / On desktop, Keep on top and Reset position (desktop only), Start with Windows (on by default), Quit.
- Tray icon: click to bring the widget forward.

## How the glass works

Windows 11 acrylic only works on framed windows with 8 px corners, so the tile instead reads your wallpaper (`TranscodedWallpaper` + `WallpaperStyle` from the registry), aligns it to the tile's screen position, and blurs it in CSS. Text flips dark on bright wallpapers. Wallpaper changes are picked up within 20 s.

## Dev

```
npm install
npm start          # launches detached (clears VS Code's ELECTRON_RUN_AS_NODE)
npm test           # sender unit tests, no network
npm run icon       # regenerate assets/icon.png + icon.ico
npm run dist       # build dist/Send-to-Phone-Setup-<version>.exe (NSIS, per-user)
powershell -File scripts/shortcut.ps1   # Start Menu shortcut
```

If `npm start` fails with a missing `electron.exe`, npm skipped Electron's install script (allow-scripts): run `node node_modules/electron/install.js`.

Release: bump `version` in package.json, `npm run dist`, then `gh release create v<version> dist/Send-to-Phone-Setup-<version>.exe`.

Code: [src/main.js](src/main.js) (windows, tray, IPC, settings), [src/sender.js](src/sender.js) (Gmail/ntfy), [src/wallpaper.js](src/wallpaper.js), [src/widget.html](src/widget.html), [src/settings.html](src/settings.html).
