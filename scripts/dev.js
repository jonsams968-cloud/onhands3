// Launcher script that removes ELECTRON_RUN_AS_NODE before starting electron-vite.
// This env var is set by Electron apps (like CherryStudio) and causes child
// Electron processes to run as plain Node.js, breaking require('electron').
// cross-env and `set VAR=` don't reliably delete it — only `delete` works.
delete process.env.ELECTRON_RUN_AS_NODE

// Set terminal code page to UTF-8 so Chinese characters display correctly
try {
  require('child_process').execSync('chcp 65001', { stdio: 'ignore' })
} catch {}

const { spawn } = require('child_process')
const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,  // Pass cleaned environment
})

child.on('exit', (code) => process.exit(code ?? 0))
