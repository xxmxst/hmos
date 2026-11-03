const { join, resolve } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const assert = require("node:assert/strict");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const output = resolve(process.cwd(), ".tmp", `window-smoke-${Date.now()}`);
  mkdirSync(join(output, "user-data"), { recursive: true });
  writeFileSync(join(output, "user-data", "window-state.json"), "invalid-json", "utf8");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  (async () => {
    for (const phase of ["first", "restore"]) {
      await new Promise((done, fail) => {
        const child = spawn(require("electron"), [__filename, output, phase], {
          cwd: process.cwd(), env, windowsHide: true, stdio: "inherit"
        });
        child.on("error", fail);
        child.on("exit", (code) => code === 0 ? done() : fail(new Error(`${phase}: exit ${code}`)));
      });
    }
    console.log("Window mode, geometry, menus and restart smoke passed:", output);
  })().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, screen } = require("electron");
  const output = process.argv[2];
  const phase = process.argv[3];
  app.setPath("userData", join(output, "user-data"));
  app.on("browser-window-created", (_event, window) => {
    window.show = () => {};
    window.webContents.setBackgroundThrottling(false);
  });
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const deadline = setTimeout(() => { console.error("Window smoke timeout"); app.exit(1); }, 50_000);
  async function until(check, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await check();
      if (result) return result;
      await pause(80);
    }
    throw new Error(`Timed out: ${label}`);
  }
  app.whenReady().then(async () => {
    const register = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, handler) => register(channel, channel === "devices:list" ? async () => [] : handler);
    require(join(process.cwd(), "dist/main/main.cjs"));
    ipcMain.handle = register;
    const window = await until(() => BrowserWindow.getAllWindows()[0], "window");
    const id = window.id;
    const run = (script) => window.webContents.executeJavaScript(script, true);
    await until(() => run("!!window.hmRemote && document.readyState === 'complete' && !!document.querySelector('#window-mode-toggle')"), "renderer");
    const mode = () => run("document.querySelector('#app').dataset.windowMode");
    const setMode = async (value) => {
      await run(`window.hmRemote.setWindowMode(${JSON.stringify(value)})`);
      await until(async () => (await mode()) === value, `mode ${value}`);
      await pause(160);
      assert.equal(window.id, id, "mode changed the window identity");
    };
    const assertGeometry = async (ratio) => {
      await until(() => {
        const bounds = window.getContentBounds();
        return Math.abs(bounds.width - 48 - bounds.height * ratio) <= 2;
      }, "window video aspect");
      await until(async () => {
        const content = window.getContentBounds();
        return run(`innerWidth === ${content.width} && innerHeight === ${content.height}`);
      }, "renderer resize settled");
      const layout = await run(`(() => {
        const shell = document.querySelector('#screen-shell').getBoundingClientRect();
        const rail = document.querySelector('.control-rail').getBoundingClientRect();
        return { width:innerWidth, height:innerHeight, x:shell.x, y:shell.y,
          pictureWidth:shell.width, pictureHeight:shell.height, rail:rail.width,
          expandDisabled:document.querySelector('#window-mode-toggle').disabled,
          customTitleAbsent:document.querySelector('.window-titlebar') === null,
          quickActions:document.querySelectorAll('.rail-scroll [data-phone-control]').length };
      })()`);
      assert.equal(layout.rail, 48);
      assert.equal(layout.x, 48);
      assert.equal(layout.y, 0);
      assert.equal(layout.pictureWidth + 48, layout.width);
      assert.equal(layout.pictureHeight, layout.height);
      assert.equal(layout.expandDisabled, false);
      assert.equal(layout.customTitleAbsent, true);
      assert.ok(window.getBounds().height > window.getContentBounds().height, "native title bar missing");
      assert.equal(layout.quickActions, 12);
    };
    if (phase === "restore") {
      await until(async () => (await mode()) === "compact", "remember compact mode");
      const expected = JSON.parse(readFileSync(join(output, "expected.json"), "utf8"));
      assert.deepEqual(window.getBounds(), expected.compact);
      assert.equal(await run("!!document.querySelector('#expand-connect').getBoundingClientRect().height"), true);
      await run("document.querySelector('#expand-connect').click()");
      await until(async () => (await mode()) === "full", "expand connection");
      await until(() => window.isMaximized(), "remember full maximization");
      window.unmaximize();
      await until(() => !window.isMaximized(), "unmaximize restored full");
      assert.deepEqual(window.getBounds(), expected.full);
      console.log("Restored mode, compact bounds and full/maximized bounds");
    } else {
      assert.equal(await mode(), "full");
      const work = screen.getPrimaryDisplay().workArea;
      window.setBounds({ x: work.x + 40, y: work.y + 40, width: Math.min(1100, work.width - 80), height: Math.min(780, work.height - 80) });
      await pause(300);
      const full = window.getBounds();
      await run("window.hmRemote.reportMirrorSize({width:900,height:1600})");
      await setMode("compact");
      await assertGeometry(9 / 16);
      assert.equal(await run("!!document.querySelector('#screenshot-button').closest('.rail-scroll')"), true);
      assert.equal(await run("!!document.querySelector('[data-key=Power]').closest('.rail-scroll')"), true);
      assert.equal(await run("document.querySelector('#more-button') === null && document.querySelector('#rail-more-panel') === null"), true);
      const before = window.getBounds();
      const resizeEvent = { preventDefault() { this.prevented = true; } };
      window.emit("will-resize", resizeEvent, { ...before, width: before.width + 60 }, { edge: "right" });
      assert.equal(resizeEvent.prevented, true);
      await assertGeometry(9 / 16);
      window.setSize(850, 650);
      await assertGeometry(9 / 16);
      await run("window.hmRemote.reportMirrorSize({width:1600,height:900})");
      await assertGeometry(16 / 9);
      window.setContentSize(368, 180);
      await assertGeometry(16 / 9);
      const smallRail = await run(`(() => {
        const rail = document.querySelector('.rail-scroll');
        rail.scrollTop = rail.scrollHeight;
        const paste = document.querySelector('#ocr-button').getBoundingClientRect();
        const footer = document.querySelector('.rail-footer').getBoundingClientRect();
        return {scrolls:rail.scrollHeight > rail.clientHeight,pasteBottom:paste.bottom,footerTop:footer.top,footerBottom:footer.bottom,height:innerHeight};
      })()`);
      assert.equal(smallRail.scrolls, true, `small rail must scroll: ${JSON.stringify(smallRail)}`);
      assert.ok(smallRail.pasteBottom <= smallRail.footerTop, "last quick action is unreachable");
      assert.ok(smallRail.footerBottom <= smallRail.height, "window actions overflow");
      const snapshot = await window.webContents.capturePage();
      writeFileSync(join(output, "compact-empty.png"), snapshot.toPNG());
      await setMode("full");
      assert.deepEqual(window.getBounds(), full);
      assert.equal(await run("document.querySelector('#screenshot-button').closest('.rail-scroll') !== null"), true);
      const header = await run("({ width:innerWidth, right:document.querySelector('#connect-button').getBoundingClientRect().right })");
      assert.ok(header.right <= header.width, "full header overflow");
      window.maximize();
      await until(() => window.isMaximized(), "maximize full");
      await setMode("compact");
      assert.equal(window.isMaximized(), false);
      await assertGeometry(16 / 9);
      await setMode("full");
      await until(() => window.isMaximized(), "restore full maximization");
      await setMode("compact");
      await assertGeometry(16 / 9);
      await pause(300);
      writeFileSync(join(output, "expected.json"), JSON.stringify({ full, compact: window.getBounds() }));
      console.log("No-device menus, frame-free layout, native resize, rotation and full restoration passed");
    }
    clearTimeout(deadline);
    window.close();
    app.quit();
  }).catch((error) => { clearTimeout(deadline); console.error(error); app.exit(1); });
}
