const { join, resolve } = require("node:path");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");

// 此脚本显式运行时才连接实机，测试产物仅保存到项目 .tmp 目录。
if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const electron = require("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename], { cwd: process.cwd(), env, windowsHide: true, stdio: "inherit" });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, clipboard, dialog, ipcMain } = require("electron");
  // Intercept input only during the keyboard regression; never type test text on the phone.
  let interceptControl = false;
  const inputCommands = [];
  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => registerHandler(channel, channel === "mirror:control"
    ? (event, command) => {
      if (interceptControl) { inputCommands.push(command); return; }
      return handler(event, command);
    } : handler);
  const output = resolve(process.cwd(), ".tmp", `android-smoke-${Date.now()}`);
  mkdirSync(output, { recursive: true });
  const userData = join(output, "user-data");
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, "window-state.json"), JSON.stringify({ mode: "compact" }));
  app.setPath("userData", userData);
  const picturePath = join(output, "screenshot.png");
  const videos = join(output, "videos");
  mkdirSync(videos, { recursive: true });
  app.setPath("videos", videos);
  const recordingsFolder = join(videos, "鸿蒙投屏助手", "录屏");
  const recordedFiles = () => existsSync(recordingsFolder) ? readdirSync(recordingsFolder).filter(name => name.endsWith(".webm")) : [];
  const selections = [picturePath];
  let saveDialogCount = 0;
  dialog.showSaveDialog = async () => {
    saveDialogCount++;
    return { canceled: false, filePath: selections.shift() };
  };
  app.on("browser-window-created", (_event, window) => {
    window.show = () => {};
    window.webContents.setBackgroundThrottling(false);
  });
  const deadline = setTimeout(() => { console.error("Android smoke test timed out"); app.exit(1); }, 90_000);
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  async function until(check, label, timeout = 20_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await check();
      if (result) return result;
      await pause(200);
    }
    throw new Error(`Timed out: ${label}`);
  }
  app.whenReady().then(async () => {
    require(join(process.cwd(), "dist/main/main.cjs"));
    ipcMain.handle = registerHandler;
    const window = await until(() => BrowserWindow.getAllWindows()[0], "window");
    const run = (script) => window.webContents.executeJavaScript(script, true);
    await until(async () => run("!!window.hmRemote && document.readyState === 'complete'"), "renderer");
    await until(async () => run("Array.from(document.querySelector('#device-select').options).some(o => o.value.startsWith('adb:') && !o.disabled)"), "ready Android device");
    if (await run("Array.from(document.querySelector('#device-select').options).filter(o => o.value && !o.disabled).length !== 1")) throw new Error("Auto-connect live test requires exactly one ready USB device");
    await until(async () => run("document.querySelector('#status-title').textContent === '已连接'"), "decoded video");
    const video = await run("(() => { const v = Array.from(document.querySelectorAll('video')).find(v => !v.hidden && v.videoWidth > 0); return v && {width:v.videoWidth,height:v.videoHeight}; })()");
    if (!video) throw new Error("No decoded video target");
    console.log("Saved compact mode automatically connected Android video without clicking Start:", JSON.stringify(video));
    await run("window.hmRemote.setWindowMode('full')");
    await until(async () => run("document.querySelector('#app').dataset.windowMode === 'full'"), "full mode controls restored");

    window.setSize(820, 620);
    await pause(300);
    const layout = await run("({ width: innerWidth, configureRight: document.querySelector('#configure-android').getBoundingClientRect().right, connectRight: document.querySelector('#connect-button').getBoundingClientRect().right })");
    if (layout.connectRight > layout.width || layout.configureRight > layout.width) throw new Error("Header overflows at minimum window size");
    window.setSize(1180, 820);

    const originalVideo = await run("(() => { window.__compactVideo = Array.from(document.querySelectorAll('video')).find(v => !v.hidden && v.videoWidth > 0); return {time:__compactVideo.currentTime,width:__compactVideo.videoWidth,height:__compactVideo.videoHeight}; })()");
    const setMode = async (mode) => {
      await run(`window.hmRemote.setWindowMode(${JSON.stringify(mode)})`);
      await until(async () => run(`document.querySelector('#app').dataset.windowMode === ${JSON.stringify(mode)}`), `window mode ${mode}`);
      await pause(180);
    };
    await setMode("compact");
    await until(async () => run("(() => { const shell=document.querySelector('#screen-shell').getBoundingClientRect(); const video=__compactVideo.getBoundingClientRect(); return Math.abs(shell.width-video.width)<=2 && Math.abs(shell.height-video.height)<=2; })()"), "compact picture resize settled");
    const compactLayout = await run("(() => { const r=document.querySelector('#screen-shell').getBoundingClientRect(); const v=__compactVideo.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,videoWidth:v.width,videoHeight:v.height,playing:!__compactVideo.paused,connected:document.querySelector('#status-title').textContent === '已连接'}; })()");
    if (compactLayout.x !== 48 || compactLayout.y !== 0 || compactLayout.width + 48 !== compactLayout.viewportWidth || compactLayout.height !== compactLayout.viewportHeight
      || Math.abs(compactLayout.width - compactLayout.videoWidth) > 2 || Math.abs(compactLayout.height - compactLayout.videoHeight) > 2 || !compactLayout.playing || !compactLayout.connected) {
      throw new Error(`Compact live layout failed: ${JSON.stringify(compactLayout)}`);
    }
    writeFileSync(join(output, "compact-live.png"), (await window.webContents.capturePage()).toPNG());
    if (await run("document.querySelector('[data-key=Power]').disabled || !document.querySelector('[data-key=Power]').closest('.rail-scroll') || document.querySelector('#more-button') !== null")) throw new Error("Compact power control is not directly accessible");
    await setMode("full");
    await setMode("compact");
    await until(async () => run(`__compactVideo === Array.from(document.querySelectorAll('video')).find(v => !v.hidden && v.videoWidth > 0) && __compactVideo.currentTime > ${originalVideo.time}`), "continuous original video after mode switches");
    console.log("Compact live picture fills window; mode changes preserve the video element and playback");

    interceptControl = true;
    await run(`window.__focusKeyboard = () => {
      const v=__compactVideo, rect=v.getBoundingClientRect();
      const capture=v.setPointerCapture;
      v.setPointerCapture=()=>{};
      try {
        const point={clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,button:0,pointerId:1,bubbles:true,cancelable:true};
        v.dispatchEvent(new PointerEvent('pointerdown',point));
        v.dispatchEvent(new PointerEvent('pointerup',point));
      } finally { v.setPointerCapture=capture; }
      return document.activeElement===document.querySelector('#keyboard-input');
    };
    window.__typeIme = () => {
      const input=document.querySelector('#keyboard-input');
      input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      input.dispatchEvent(new CompositionEvent('compositionend',{data:'中文🙂',bubbles:true}));
      input.dispatchEvent(new InputEvent('input',{data:'中文🙂',inputType:'insertText',bubbles:true}));
    };
    if (!__focusKeyboard()) throw new Error('Keyboard focus failed in compact mode');
    const input=document.querySelector('#keyboard-input');
    input.dispatchEvent(new InputEvent('input',{data:'Abc123',inputType:'insertText',bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));
    __typeIme();`);
    const textCommands = () => inputCommands.filter((command) => command.kind === "text" || command.kind === "keyboard");
    await until(() => textCommands().length === 3, "compact ASCII, edit key and committed IME text");
    if (textCommands()[0].text !== "Abc123" || textCommands()[1].key !== "Backspace" || textCommands()[2].text !== "中文🙂") throw new Error("Compact keyboard command mismatch");
    await setMode("full");
    await run("document.querySelector('#keyboard-input').dispatchEvent(new InputEvent('input',{data:'stale',inputType:'insertText',bubbles:true}))");
    await pause(120);
    if (textCommands().length !== 3) throw new Error("Mode change forwarded stale input");
    await run("if (!__focusKeyboard()) throw new Error('Full keyboard focus failed'); __typeIme()");
    await until(() => textCommands().length === 4, "IME input after expanding");
    await setMode("compact");
    await run("if (!__focusKeyboard()) throw new Error('Compact keyboard focus failed'); __typeIme()");
    await until(() => textCommands().length === 5, "IME input after compacting");
    const controlsBeforeBlur = inputCommands.length;
    await run("document.querySelector('#window-mode-toggle').focus(); document.querySelector('#keyboard-input').dispatchEvent(new InputEvent('input',{data:'ui-stale',inputType:'insertText',bubbles:true}))");
    await pause(120);
    if (inputCommands.length !== controlsBeforeBlur) throw new Error("Sidebar focus leaked phone input");
    interceptControl = false;
    console.log("Compact/full keyboard focus, ASCII/edit/Chinese/emoji and sidebar focus isolation passed (input intercepted; no phone text written)");

    await run("document.querySelector('#copy-screenshot-button').click()");
    await until(async () => run("document.querySelector('#toast').textContent.startsWith('截图已复制') && !document.querySelector('#copy-screenshot-button').disabled"), "screenshot copied to clipboard");
    const copied = clipboard.readImage();
    if (copied.isEmpty()) throw new Error("Clipboard image is empty");
    if (saveDialogCount !== 0 || existsSync(picturePath)) throw new Error("Copy screenshot unexpectedly opened a save dialog or wrote a file");
    console.log("Screenshot copied without a file:", JSON.stringify(copied.getSize()));

    await run("document.querySelector('#screenshot-button').click()");
    await until(() => existsSync(picturePath), "screenshot saved");
    const picture = readFileSync(picturePath);
    if (picture.subarray(1, 4).toString() !== "PNG") throw new Error("Invalid PNG screenshot");
    console.log("PNG screenshot saved:", JSON.stringify({ width: picture.readUInt32BE(16), height: picture.readUInt32BE(20), bytes: picture.length }));
    const ocr = await run("(async () => { const s = await window.hmRemote.captureOcrSnapshot(document.querySelector('#device-select').value); await window.hmRemote.cancelOcr(s.id); return {source:s.source,mimeType:s.mimeType,width:s.width,height:s.height}; })()");
    if (ocr.source !== "device") throw new Error("Android OCR did not use the device screenshot");
    await run("document.querySelector('#ocr-button').click()");
    await until(async () => run("!document.querySelector('#ocr-overlay').hidden && document.querySelector('#ocr-surface').dataset.width > 0"), "compact OCR surface");
    const ocrLayout = await run("(() => { const toolbar = document.querySelector('.ocr-toolbar').getBoundingClientRect(); const picture = document.querySelector('#ocr-surface').getBoundingClientRect(); const shell = document.querySelector('#screen-shell').getBoundingClientRect(); return {toolbarLeft:toolbar.left,toolbarRight:toolbar.right,toolbarTop:toolbar.top,pictureBottom:picture.bottom,shellLeft:shell.left,shellRight:shell.right}; })()");
    if (ocrLayout.toolbarLeft < ocrLayout.shellLeft || ocrLayout.toolbarRight > ocrLayout.shellRight || ocrLayout.pictureBottom > ocrLayout.toolbarTop) throw new Error(`Compact OCR toolbar overlaps: ${JSON.stringify(ocrLayout)}`);
    await setMode("full");
    if (await run("document.querySelector('#ocr-overlay').hidden")) throw new Error("Mode switch exited OCR");
    await until(async () => run("document.querySelector('#ocr-progress').hidden"), "OCR recognition complete", 30000);
    await run("document.querySelector('#ocr-exit').click()");
    await until(async () => run("document.querySelector('#ocr-overlay').hidden"), "exit OCR");
    await setMode("compact");
    console.log("Android OCR snapshot:", JSON.stringify(ocr));

    await run("document.querySelector('#record-button').click()");
    await until(async () => run("document.querySelector('#record-button').getAttribute('aria-pressed') === 'true'"), "recording started");
    const activeRecordUi = await run("({count:document.querySelectorAll('.control-rail #record-button').length,label:document.querySelector('#record-button small').textContent,icon:document.querySelector('#record-button span').textContent,connection:document.querySelector('#compact-connect-button small').textContent})");
    if (activeRecordUi.count !== 1 || activeRecordUi.label !== '停录' || activeRecordUi.icon !== '■' || activeRecordUi.connection !== '断开') throw new Error(`Recording and connection buttons are ambiguous: ${JSON.stringify(activeRecordUi)}`);
    await run("document.querySelector('#screen-power-button').click()");
    await until(async () => run("document.querySelector('#screen-power-button').getAttribute('aria-pressed') === 'true' && !document.querySelector('#screen-power-button').disabled"), "display off while recording");
    await setMode("full");
    if (!await run("document.querySelector('#record-button').getAttribute('aria-pressed') === 'true'")) throw new Error("Full mode interrupted recording");
    await setMode("compact");
    if (!await run("document.querySelector('#record-button').getAttribute('aria-pressed') === 'true'")) throw new Error("Compact mode interrupted recording");
    await pause(2400);
    await run("document.querySelector('#screen-power-button').click()");
    await until(async () => run("document.querySelector('#screen-power-button').getAttribute('aria-pressed') === 'false' && !document.querySelector('#screen-power-button').disabled"), "display on while recording");
    if (!await run("document.querySelector('#record-button').getAttribute('aria-pressed') === 'true'")) throw new Error("Display power switching interrupted recording");
    await run("document.querySelector('#record-button').click()");
    await until(async () => run("!document.querySelector('#record-button').disabled && document.querySelector('#record-button').getAttribute('aria-pressed') === 'false'"), "recording flushed");
    if (await run("document.querySelector('#record-button small').textContent !== '录屏' || document.querySelector('#record-button span').textContent !== '●' || document.querySelector('#status-title').textContent !== '已连接'")) throw new Error("Stopping recording did not restore the same button or interrupted mirroring");
    if (saveDialogCount !== 1) throw new Error("Recording unexpectedly opened a save dialog");
    const firstFiles = recordedFiles();
    if (firstFiles.length !== 1) throw new Error("Automatic recording file missing or duplicated");
    const recordPath = join(recordingsFolder, firstFiles[0]);
    const recording = readFileSync(recordPath);
    const preservedRecording = Buffer.from(recording);
    console.log("Recording saved automatically under the system Videos directory");
    if (recording.subarray(0, 4).toString("hex") !== "1a45dfa3") throw new Error("Invalid WebM recording");
    const playback = await run(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(recording.toString("base64"))}), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], {type:'video/webm'}));
      const video = document.createElement('video'); video.muted = true;
      try { return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Playback timeout')), 5000);
        video.onloadeddata = () => { clearTimeout(timer); resolve({width:video.videoWidth,height:video.videoHeight}); };
        video.onerror = () => { clearTimeout(timer); reject(new Error('Playback failed')); };
        video.src = url; video.load();
      }); } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    })()`);
    if (!playback.width || !playback.height) throw new Error("Recording has no video");
    console.log("WebM recording plays:", JSON.stringify({ ...playback, bytes: recording.length }));

    await run("document.querySelector('#record-button').click()");
    await until(async () => run("document.querySelector('#record-button').getAttribute('aria-pressed') === 'true'"), "second recording");
    await pause(1500);
    await run("window.hmRemote.windowAction('close')");
    await until(() => window.isDestroyed(), "flush recording on window close");
    if (saveDialogCount !== 1) throw new Error("Second recording opened a save dialog");
    const nextFiles = recordedFiles().filter(name => name !== firstFiles[0]);
    if (nextFiles.length !== 1 || !readFileSync(recordPath).equals(preservedRecording)) throw new Error("Successive recordings overwrote an existing file");
    const closeRecordPath = join(recordingsFolder, nextFiles[0]);
    if (!existsSync(closeRecordPath) || readFileSync(closeRecordPath).subarray(0, 4).toString("hex") !== "1a45dfa3") {
      throw new Error("Recording was not flushed on close");
    }
    clearTimeout(deadline);
    console.log("Android UI, screenshot, OCR capture, recording and close-save smoke passed");
    console.log("Artifacts:", output);
    app.quit();
  }).catch(async (error) => {
    clearTimeout(deadline);
    console.error(error);
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        const diagnostics = await window.webContents.executeJavaScript("({status:document.querySelector('#status-title')?.textContent,message:document.querySelector('#status-message')?.textContent,video:document.querySelector('#metric-video-packets')?.textContent,toast:document.querySelector('#toast')?.textContent})");
        console.error('UI diagnostics:', JSON.stringify(diagnostics));
        await window.webContents.executeJavaScript('window.hmRemote?.stop()');
      } catch {}
    }
    app.exit(1);
  });
}
