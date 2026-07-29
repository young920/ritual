/**
 * Electron 主进程 — Ritual.app
 *
 * 职责(很轻):
 *   1. 启动 Python 子进程(`python -m web.app`),监听 127.0.0.1:8000
 *   2. 创建 BrowserWindow 加载 http://127.0.0.1:8000/plan
 *   3. 处理:子进程死了就重启 / 端口被占就提示 / macOS dock 点击重开窗口
 *   4. 退出时清理子进程
 *
 * 关键:Express / FastAPI 都不在 Electron 进程内跑,
 *      所有 HTTP 都是 Python 子进程提供,Electron 只负责壳。
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

const PY_PORT = 8000;
const PY_HOST = '127.0.0.1';
const PY_URL = `http://${PY_HOST}:${PY_PORT}`;

// 开发 vs 打包模式:开发时跑项目根的 .venv-ritual/bin/python,
// 打包后用 Resources/ritual_runtime/python(由 electron-builder.yml extraResources 拷贝)。
function resolvePython() {
  const isDev = !app.isPackaged;
  if (isDev) {
    // 开发:用 .venv-ritual(已经在用,virtualenv 形态)
    const venvPy = path.join(__dirname, '..', '.venv-ritual', 'bin', 'python');
    return venvPy;
  }
  // 打包:Resources/ritual_runtime/bin/python(.venv 已拷到 Resources/)
  const bundled = path.join(process.resourcesPath, 'ritual_runtime', 'bin', 'python');
  return bundled;
}

function resolveProjectRoot() {
  // 开发:server/ 的父目录 = 项目根
  // 打包:process.resourcesPath/ritual_runtime(代码就放在那里)
  if (!app.isPackaged) {
    return path.join(__dirname, '..');
  }
  return path.join(process.resourcesPath, 'ritual_runtime');
}

let pyProc = null;
let mainWindow = null;

function logBoth(line) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${line}`);
}

function spawnPython() {
  const py = resolvePython();
  const cwd = resolveProjectRoot();
  logBoth(`spawn python: ${py}`);
  logBoth(`cwd: ${cwd}`);

  pyProc = spawn(py, ['-m', 'web.app'], {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1', RITUAL_BUNDLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pyProc.stdout.on('data', (b) => logBoth(`[py stdout] ${b.toString().trimEnd()}`));
  pyProc.stderr.on('data', (b) => logBoth(`[py stderr] ${b.toString().trimEnd()}`));
  pyProc.on('exit', (code, signal) => {
    logBoth(`python exited code=${code} signal=${signal}`);
    pyProc = null;
    // 非正常退出 → 提示用户(避免静默挂掉)
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0) {
      dialog.showErrorBox('Ritual 后端异常', `Python 子进程退出 code=${code},请查看 ~/.ritual/ritual.err`);
    }
  });
}

function waitForPort(host, port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.createConnection({ host, port }, () => {
        sock.end();
        resolve();
      });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`timeout waiting for ${host}:${port}`));
        } else {
          setTimeout(tryOnce, 250);
        }
      });
    };
    tryOnce();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Ritual',
    backgroundColor: '#1a1614',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 禁用缓存,避免开发时改前端看不到
      cache: false,
    },
  });

  // 不允许打开外部链接(都用系统浏览器)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 加载前端入口
  mainWindow.loadURL(`${PY_URL}/plan`);
  mainWindow.focus();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  // 1) 检查端口:被占就提示并退出
  const occupied = await new Promise((resolve) => {
    const sock = net.createConnection({ host: PY_HOST, port: PY_PORT }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
  });
  if (occupied) {
    dialog.showErrorBox(
      'Ritual 启动失败',
      `端口 ${PY_PORT} 已被占用。请关掉占用端口的应用(可能是上次的 Ritual 没退干净)后重试。`,
    );
    app.quit();
    return;
  }

  // 2) 启 Python
  spawnPython();

  // 3) 等后端就绪
  try {
    await waitForPort(PY_HOST, PY_PORT, 20000);
    logBoth(`python ready on ${PY_URL}`);
  } catch (e) {
    logBoth(`python not ready: ${e.message}`);
    dialog.showErrorBox(
      'Ritual 后端启动超时',
      'Python 子进程 20 秒内没监听端口,请查看 ~/.ritual/ritual.err',
    );
    app.quit();
    return;
  }

  // 4) 开窗口
  await createWindow();
}

// ── macOS 行为 ───────────────────────────────────────
app.on('window-all-closed', () => {
  // macOS 习惯:所有窗口关了也不退出,除非用户 Cmd+Q
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

app.on('before-quit', () => {
  if (pyProc) {
    logBoth('killing python child');
    pyProc.kill('SIGTERM');
  }
});

app.whenReady().then(bootstrap).catch((e) => {
  logBoth(`bootstrap failed: ${e.stack || e}`);
  dialog.showErrorBox('Ritual 启动失败', String(e));
  app.quit();
});