// Launches the widget detached. Clears ELECTRON_RUN_AS_NODE, which VS Code terminals set
// and which would make Electron run as plain Node.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // resolves to the electron.exe path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.slice(2);
spawn(electron, args.length ? args : [path.join(__dirname, '..')], { env, detached: true, stdio: 'ignore' }).unref();
