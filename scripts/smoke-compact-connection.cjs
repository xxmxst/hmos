const { join, resolve } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");
const assert = require("node:assert/strict");

if (!process.versions.electron) {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require("electron"), [__filename], {
    cwd:process.cwd(),env,windowsHide:true,stdio:"inherit"
  });
  child.on("error",error=>{console.error(error);process.exitCode=1;});
  child.on("exit",code=>{process.exitCode=code??1;});
} else {
  const {app,BrowserWindow,ipcMain} = require("electron");
  const output = resolve(process.cwd(),".tmp",`compact-connection-${Date.now()}`);
  const userData = join(output,"user-data");
  mkdirSync(userData,{recursive:true});
  writeFileSync(join(userData,"window-state.json"),JSON.stringify({mode:"compact"}));
  app.setPath("userData",userData);
  let devices=[],scans=0,failStart=false,stops=0;
  const starts=[];
  const phone=(serial,state="ready",backend="adb")=>({serial,state,backend,transport:"USB",rawState:state,label:serial});
  const register=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>{
    if(channel==="devices:list") return register(channel,async()=>{scans++;return devices;});
    if(channel==="mirror:start") return register(channel,async(event,options)=>{
      starts.push(options);
      if(failStart) throw new Error("连接测试失败");
      event.sender.send("mirror:status",{state:"waiting-video",message:"Fixture connected"});
    });
    if(channel==="mirror:stop") return register(channel,async(event)=>{
      stops++;
      event.sender.send("mirror:status",{state:"idle",message:"Fixture stopped"});
    });
    return register(channel,handler);
  };
  app.on("browser-window-created",(_event,window)=>{window.show=()=>{};window.webContents.setBackgroundThrottling(false);});
  const pause=ms=>new Promise(done=>setTimeout(done,ms));
  const deadline=setTimeout(()=>{console.error("Compact connection smoke timeout");app.exit(1);},65000);
  async function until(check,label,timeout=10000){
    const end=Date.now()+timeout;
    while(Date.now()<end){if(await check())return;await pause(100);}
    throw new Error(`Timed out: ${label}`);
  }
  app.whenReady().then(async()=>{
    require(join(process.cwd(),"dist/main/main.cjs"));
    ipcMain.handle=register;
    let window;
    await until(()=>window=BrowserWindow.getAllWindows()[0],"window");
    const run=code=>window.webContents.executeJavaScript(code,true);
    await until(()=>run("!!window.hmRemote && document.querySelector('#app').dataset.windowMode==='compact' && document.querySelector('#device-select').parentElement.id==='compact-connection'"),"compact connection controls");
    await until(()=>scans>=1,"first scan");
    assert.equal(starts.length,0);
    devices=[phone("one","unauthorized")];
    await until(()=>run("Array.from(document.querySelector('#device-select').options).some(o=>o.value==='adb:one'&&o.disabled)"),"unauthorized phone detected");
    assert.equal(starts.length,0);
    devices=[phone("one")];
    await until(()=>starts.length===1,"authorized phone automatically connected");
    await until(()=>run("document.querySelector('#compact-connect-button').querySelector('small').textContent==='断开' && !document.querySelector('#compact-connect-button').disabled"),"compact stop control");
    assert.equal(starts[0].serial,"one");
    const stop=async()=>{
      await until(()=>run("!document.querySelector('#compact-connect-button').disabled && document.querySelector('#compact-connect-button').querySelector('small').textContent==='断开'"),"stop action available");
      const count=stops;
      await run("document.querySelector('#compact-connect-button').click()");
      await until(()=>stops>count,"stop requested");
      await until(()=>run("!document.querySelector('#compact-connect-button').disabled && document.querySelector('#compact-connect-button').querySelector('small').textContent==='连接'"),"stop completed");
    };
    await stop();
    await pause(2400);
    assert.equal(starts.length,1,"manual stop auto-reconnected");
    await run("document.querySelector('#compact-connect-button').click()");
    await until(()=>starts.length===2,"compact manual reconnect");
    await stop();
    devices=[];
    await until(()=>run("document.querySelector('#device-select').value===''"),"detach detected");
    devices=[phone("one")];
    await until(()=>starts.length===3,"reattach auto-connected");
    await stop();
    devices=[phone("one"),phone("two","ready","hdc")];
    await until(()=>run("document.querySelector('#device-select').options.length===2"),"multiple devices shown");
    await pause(2200);
    assert.equal(starts.length,3,"auto-selected among multiple phones");
    assert.equal(await run("document.querySelector('#connect-button').parentElement.id"),"compact-connection");
    await run("document.querySelector('#device-select').value='hdc:two'; document.querySelector('#device-select').dispatchEvent(new Event('change')); document.querySelector('#connect-button').click()");
    await until(()=>starts.length===4,"compact selected Harmony device");
    assert.equal(starts[3].backend,"hdc");
    assert.equal(starts[3].serial,"two");
    await stop();
    devices=[];
    await until(()=>run("document.querySelector('#device-select').value===''"),"detach before failure");
    failStart=true;
    devices=[phone("one")];
    await until(()=>starts.length===5,"connection failure attempted once");
    await until(()=>run("document.querySelector('#empty-title').textContent==='连接失败'"),"failure shown");
    await pause(2400);
    assert.equal(starts.length,5,"connection failure repeatedly retried");
    assert.equal(await run("document.querySelector('#empty-title').textContent"),"连接失败");
    failStart=false;
    await run("document.querySelector('#connect-button').click()");
    await until(()=>starts.length===6,"manual retry after failure");
    await run("window.hmRemote.setWindowMode('full')");
    await until(()=>run("document.querySelector('#device-select').parentElement.classList.contains('connection')"),"full controls restored");
    await run("document.querySelector('#connect-button').click()");
    await until(()=>stops===5,"full stop");
    await pause(2200);
    assert.equal(starts.length,6,"full mode automatically started mirroring");
    clearTimeout(deadline);
    console.log("Compact startup, authorization, hotplug, stop/reconnect, multi-device choice and failure retry passed (isolated devices)");
    window.close();
    app.quit();
  }).catch(error=>{clearTimeout(deadline);console.error(error);app.exit(1);});
}
