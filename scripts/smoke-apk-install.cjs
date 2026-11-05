const { join, resolve } = require("node:path");
const { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } = require("node:fs");
const assert = require("node:assert/strict");

// 默认使用隔离设备；显式设置 HMR_TEST_APK 后才向唯一的 Android USB 实机安装。
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require("electron"), [__filename], {
    cwd: process.cwd(), env, windowsHide: true, stdio: "inherit"
  });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { promisify } = require("node:util");
  const processes = require("node:child_process");
  const originalExec = processes.execFile;
  const realExec = promisify(originalExec);
  const live = !!process.env.HMR_TEST_APK;
  const output = resolve(process.cwd(), ".tmp", `apk-install-${Date.now()}`);
  const userData = join(output, "user-data"), videos = join(output, "videos");
  mkdirSync(userData, { recursive: true });
  mkdirSync(videos, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("videos", videos);
  writeFileSync(join(userData, "window-state.json"), JSON.stringify({ mode: "full" }));
  const apk = live ? resolve(process.env.HMR_TEST_APK) : join(output, "安装 包 (release) & test.APK");
  if (!live) writeFileSync(apk, "isolated fixture, not a real APK");
  assert(existsSync(apk), "Test APK must exist");
  const fixtureDevices = [
    { backend: "adb", serial: "one", transport: "USB", state: "ready", rawState: "device", label: "Android one" },
    { backend: "adb", serial: "two", transport: "USB", state: "ready", rawState: "device", label: "Android two" },
    { backend: "hdc", serial: "harmony", transport: "USB", state: "ready", rawState: "Ready", label: "Harmony" }
  ];
  let installs = 0, installedSerial = null, completeInstall;
  const wrapper = function (...args) { return originalExec(...args); };
  wrapper[promisify.custom] = async (file, args, options) => {
    if (args[0] === "-s" && args[2] === "install") {
      installs++;
      installedSerial = args[1];
      assert.equal(args[3], "-r");
      assert.equal(args[4], "-t");
      assert.equal(args[5], apk, "Real disk File path must survive contextBridge");
      if (!live) return new Promise(done => { completeInstall = () => done({ stdout: "Success\n", stderr: "" }); });
    }
    if (!live && args[0] === "devices") return { stdout: "one device model:Phone\ntwo device model:Phone\n", stderr: "" };
    return realExec(file, args, options);
  };
  processes.execFile = wrapper;
  const register = ipcMain.handle.bind(ipcMain);
  if (!live) ipcMain.handle = (channel, handler) => register(channel,
    channel === "devices:list" ? async () => fixtureDevices : handler);
  app.on("browser-window-created", (_event, window) => {
    window.show = () => {};
    window.webContents.setBackgroundThrottling(false);
  });
  const pause = ms => new Promise(done => setTimeout(done, ms));
  const deadline = setTimeout(() => { console.error("APK install smoke timeout"); app.exit(1); }, live ? 230000 : 40000);
  async function until(check, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await pause(100); }
    throw new Error(`Timed out: ${label}`);
  }
  app.whenReady().then(async () => {
    require(join(process.cwd(), "dist/main/main.cjs"));
    // 让测试在关窗后检查保存结果，再显式退出。
    app.removeAllListeners("window-all-closed");
    app.on("window-all-closed", () => {});
    ipcMain.handle = register;
    let window;
    await until(() => window = BrowserWindow.getAllWindows()[0], "window");
    const run = code => window.webContents.executeJavaScript(code, true);
    await until(() => run("!!window.hmRemote && document.querySelector('#device-select').options.length > 0"), "device list");
    if (live) {
      const devices = await run("window.hmRemote.listDevices()");
      const ready = devices.filter(d => d.state === "ready");
      assert.equal(ready.length, 1, "Live install requires exactly one ready device");
      assert.equal(ready[0].backend, "adb");
      assert.equal(ready[0].transport, "USB");
      await run(`document.querySelector('#device-select').value=${JSON.stringify("adb:" + ready[0].serial)}; document.querySelector('#device-select').dispatchEvent(new Event('change')); document.querySelector('#connect-button').click()`);
      await until(() => run("document.querySelector('#status-title').textContent==='已连接'"), "live streaming");
      await run("document.querySelector('#record-button').click()");
      await until(() => run("document.querySelector('#record-button').getAttribute('aria-pressed')==='true'"), "recording before install");
      console.log("Live video and recording started; installing the provided APK without launching it");
    }
    const synthetic = await run("window.hmRemote.installApk(document.querySelector('#device-select').value, new File(['test'],'synthetic.apk')).then(()=>'',e=>e.message)");
    assert(synthetic.includes("磁盘上的 APK"), synthetic);
    assert.equal(installs, 0);
    await run("window.__apkInput=document.createElement('input'); __apkInput.type='file'; __apkInput.id='apk-smoke-file'; __apkInput.hidden=true; document.body.append(__apkInput)");
    window.webContents.debugger.attach("1.3");
    const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#apk-smoke-file" });
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [apk] });
    window.webContents.debugger.detach();
    const drop = () => run("(() => {const data=new DataTransfer();data.items.add(__apkInput.files[0]);window.dispatchEvent(new DragEvent('dragenter',{dataTransfer:data,cancelable:true}));return !window.dispatchEvent(new DragEvent('drop',{dataTransfer:data,cancelable:true}));})()");
    if (!live) {
      await run("document.querySelector('#device-select').value='hdc:harmony'");
      assert(await drop());
      assert.equal(installs, 0);
      assert((await run("document.querySelector('#toast').textContent")).includes("Android / ADB"));
      await run("document.querySelector('#device-select').value='adb:two'");
    }
    const selected = await run("document.querySelector('#device-select').value");
    assert(await drop(), "Drop should prevent navigation");
    await until(() => installs === 1, "ADB install called");
    assert.equal(installedSerial, selected.slice(4));
    await until(() => run("!document.querySelector('#apk-install-status').hidden"), "persistent install indicator");
    assert.equal(await run("document.querySelector('#device-select').disabled && document.querySelector('#connect-button').disabled && document.querySelector('#configure-android').disabled"), true);
    await drop();
    assert.equal(installs, 1, "Repeated drop should not install twice");
    const second = await run("window.hmRemote.installApk(document.querySelector('#device-select').value,__apkInput.files[0]).then(()=>'',e=>e.message)");
    assert(second.includes("正在安装 APK"), second);
    const switchError = await run("window.hmRemote.start({backend:'adb',serial:'other',profileId:'balanced'}).then(()=>'',e=>e.message)");
    assert(switchError.includes("安装完成"), switchError);
    await run("window.hmRemote.setWindowMode('compact')");
    await until(() => run("document.querySelector('#app').dataset.windowMode==='compact'"), "compact while installing");
    assert.equal(await run("document.querySelector('#device-select').value"), selected);
    assert.equal(await run("document.querySelector('#compact-connect-button').disabled"), true);
    assert.equal(await run("getComputedStyle(document.querySelector('#apk-install-status')).pointerEvents"), "none");
    if (live) {
      assert.equal(await run("document.querySelector('#record-button').getAttribute('aria-pressed')"), "true");
      assert.equal(await run("document.querySelector('#status-title').textContent"), "已连接");
      await until(() => run("document.querySelector('#apk-install-status').hidden"), "live installation result", 190000);
      const message = await run("document.querySelector('#toast').textContent");
      writeFileSync(join(output, "result.json"), JSON.stringify({ message, installs, live: true }, null, 2));
      console.log("Live installation result:", message);
      assert(message.includes("APK 安装成功"), message);
      assert.equal(installs, 1);
      assert.equal(await run("document.querySelector('#status-title').textContent"), "已连接");
      window.close();
      await until(() => window.isDestroyed(), "close saves recording");
      const folder = join(videos, "鸿蒙投屏助手", "录屏");
      const saved = readdirSync(folder).filter(name => name.endsWith(".webm") && statSync(join(folder, name)).size > 1000);
      assert.equal(saved.length, 1, "Installation and mode switching must preserve recording");
      console.log("Provided APK installed; video, mode switching and recording close-save passed");
    } else {
      await run("window.hmRemote.setWindowMode('full')");
      await until(() => run("document.querySelector('#app').dataset.windowMode==='full'"), "full while installing");
      window.close();
      await pause(100);
      assert.equal(window.isDestroyed(), false, "Close must wait for installation");
      completeInstall();
      await until(() => window.isDestroyed(), "close after installation");
      console.log("Disk File -> preload -> IPC -> ADB binding, duplicate rejection, HDC rejection, mode switching and close waiting passed");
    }
    clearTimeout(deadline);
    app.quit();
  }).catch(error => { clearTimeout(deadline); console.error(error); app.exit(1); });
}
