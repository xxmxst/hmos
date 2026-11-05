const {join,resolve}=require("node:path");
const {mkdirSync,writeFileSync,readdirSync,readFileSync,statSync}=require("node:fs");
const assert=require("node:assert/strict");

// 显式运行此脚本会连接唯一已授权的 Android USB 手机，并仅破坏本应用的视频链路。
if(!process.versions.electron){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=require("node:child_process").spawn(require("electron"),[__filename],{cwd:process.cwd(),env,windowsHide:true,stdio:"inherit"});
  child.on("error",error=>{console.error(error.message);process.exitCode=1;});
  child.on("exit",code=>{process.exitCode=code??1;});
}else{
  const {app,BrowserWindow,ipcMain}=require("electron");
  const {EventEmitter}=require("node:events");
  const processes=require("node:child_process");
  const execFile=require("node:util").promisify(processes.execFile);
  const originalEmit=EventEmitter.prototype.emit,originalSpawn=processes.spawn;
  const output=resolve(process.cwd(),".tmp",`video-recovery-${Date.now()}`);
  const userData=join(output,"user-data"),videos=join(output,"videos");
  mkdirSync(userData,{recursive:true});mkdirSync(videos,{recursive:true});
  writeFileSync(join(userData,"window-state.json"),JSON.stringify({mode:"full"}));
  app.setPath("userData",userData);app.setPath("videos",videos);
  let mirror,window,dropVideo=false,freezePlayback=false,foreground=false,interceptInput=false,finished=false;
  const starts=[],preparations=[],statuses=[],input=[];
  processes.spawn=function(file,args,options){
    if(args?.includes("com.genymobile.scrcpy.Server"))starts.push({serial:args[1],profile:args.filter(x=>/^max_fps=|^video_bit_rate=|^max_size=/.test(x))});
    return originalSpawn.call(this,file,args,options);
  };
  EventEmitter.prototype.emit=function(event,...args){
    if(this.constructor.name==="AdbMirror"){
      if(!mirror){
        mirror=this;
        const prepare=mirror.recovery.host.prepare;
        mirror.recovery.host.prepare=async request=>{
          preparations.push(request);dropVideo=false;freezePlayback=false;
          return prepare(request);
        };
        mirror.recovery.host.visible=()=>foreground;
      }
      if(event==="status")statuses.push(args[0].state);
      if(event==="video"&&dropVideo)return true;
    }
    return originalEmit.call(this,event,...args);
  };
  const on=ipcMain.on.bind(ipcMain),handle=ipcMain.handle.bind(ipcMain);
  ipcMain.on=(channel,listener)=>on(channel,(event,value,...rest)=>{
    if(channel==="video:diagnostics"&&freezePlayback)value={...value,presentedFrames:1,monitorPlayback:true};
    return listener(event,value,...rest);
  });
  ipcMain.handle=(channel,listener)=>handle(channel,(event,...args)=>{
    if(channel==="mirror:control"&&interceptInput){input.push(args[0]);return;}
    return listener(event,...args);
  });
  app.on("browser-window-created",(_event,target)=>{target.show=()=>{};target.webContents.setBackgroundThrottling(false);});
  app.on("before-quit",event=>{if(!finished)event.preventDefault();});
  const pause=ms=>new Promise(done=>setTimeout(done,ms));
  const deadline=setTimeout(()=>{console.error("Video recovery smoke timeout");finished=true;app.exit(1);},125000);
  async function until(check,label,timeout=22000){
    const end=Date.now()+timeout;
    while(Date.now()<end){if(await check())return;await pause(100);}
    throw new Error(`Timed out: ${label}; status=${mirror?.status.state}; message=${mirror?.status.message}`);
  }
  const run=code=>window.webContents.executeJavaScript(code,true);
  const connected=()=>run("document.querySelector('#status-title').textContent==='已连接'");
  const recording=()=>run("document.querySelector('#record-button').getAttribute('aria-pressed')==='true'");
  const serial=()=>starts[0].serial;
  const physicalPower=async()=>{
    const result=await execFile(join(process.cwd(),"vendor/scrcpy/adb.exe"),["-s",serial(),"shell","dumpsys","SurfaceFlinger"],{windowsHide:true,timeout:6000,maxBuffer:12*1024*1024,encoding:"utf8"});
    let physical=false;const modes=[];
    for(const line of result.stdout.split(/\r?\n/)){
      if(/^Display \d+$/.test(line)){physical=true;continue;}
      if(/^Virtual Display /.test(line)){physical=false;continue;}
      const match=/^\s+powerMode=(\w+)/.exec(line);
      if(physical&&match){modes.push(match[1]);physical=false;}
    }
    assert(modes.length>0,"Physical screen state must be available");return modes;
  };
  app.whenReady().then(async()=>{
    require(join(process.cwd(),"dist/main/main.cjs"));
    ipcMain.on=on;ipcMain.handle=handle;
    app.removeAllListeners("window-all-closed");app.on("window-all-closed",()=>{});
    await until(()=>window=BrowserWindow.getAllWindows()[0],"window");
    await until(()=>run("!!window.hmRemote && document.querySelector('#device-select').options.length>0"),"devices");
    const ready=(await run("window.hmRemote.listDevices()")).filter(d=>d.state==="ready");
    assert.equal(ready.length,1,"Live recovery test needs exactly one ready USB device");
    assert.equal(ready[0].backend,"adb");
    await run("document.querySelector('#connect-button').click()");
    await until(connected,"initial stream");
    assert.equal(starts.length,1);
    await run("document.querySelector('#record-button').click()");
    await until(recording,"recording");

    if(process.env.HMR_RECOVERY_TERMINAL_TEST==="1"){
      const restart=mirror.recovery.host.restart;
      let failed=0;
      mirror.recovery.host.restart=async()=>{failed++;throw new Error("Fixture: video service unavailable");};
      await pause(1200);
      mirror.recovery.request("transport");
      await until(()=>mirror.status.state==="error","terminal failure after three retries",22000);
      await until(()=>run("document.querySelector('#record-button').getAttribute('aria-pressed')==='false' && document.querySelector('#record-button small').textContent==='录屏'"),"terminal recording saved");
      assert.equal(failed,3);
      const folder=join(videos,"鸿蒙投屏助手","录屏");
      assert.equal(readdirSync(folder).filter(name=>name.endsWith(".webm")&&statSync(join(folder,name)).size>1000).length,1);
      await until(()=>mirror.currentSerial===null,"terminal cleanup");
      console.log("Three failed recovery attempts stop retrying and automatically save the recording");
      mirror.recovery.host.restart=restart;
      await run("document.querySelector('#connect-button').click()");
      await until(connected,"manual retry after terminal failure");
      await run("document.querySelector('#record-button').click()");
      await until(recording,"second recording");
      await pause(1200);
      const count=starts.length;
      mirror.child.kill();
      await until(()=>mirror.status.state==="reconnecting","recovery before close");
      window.close();
      await until(()=>window.isDestroyed(),"close saves recording during recovery");
      await pause(1500);
      assert.equal(starts.length,count,"Window close must cancel the pending restart");
      assert.equal(readdirSync(folder).filter(name=>name.endsWith(".webm")&&statSync(join(folder,name)).size>1000).length,2);
      console.log("Closing during pending recovery cancels reconnection and saves the second recording");
      clearTimeout(deadline);finished=true;app.quit();return;
    }

    // 手机端持续出包，丢弃主进程到渲染端的包；准备恢复时解除故障。
    let before=preparations.length;
    foreground=true;dropVideo=true;
    await until(()=>preparations.length>before,"MessagePort recovery");
    assert.equal(preparations.at(-1).kind,"port");
    await until(connected,"stream after port repair");foreground=false;
    assert.equal(starts.length,1,"Port repair must not restart scrcpy");
    assert(await recording());
    console.log("MessagePort interruption recovered without restarting the device service");

    before=preparations.length;
    foreground=true;freezePlayback=true;
    await until(()=>preparations.length>before,"decoder recovery");
    assert.equal(preparations.at(-1).kind,"decoder");
    await until(connected,"stream after decoder repair");foreground=false;
    assert.equal(starts.length,1,"Decoder repair must not restart scrcpy");
    assert(await recording());
    console.log("Playback stall recovered by rebuilding the decoder and requesting fresh video");

    await run("window.hmRemote.setWindowMode('compact')");
    await run("document.querySelector('#screen-power-button').click()");
    await until(()=>run("document.querySelector('#screen-power-button').getAttribute('aria-pressed')==='true'"),"physical screen off");
    await until(async()=> (await physicalPower()).every(mode=>mode==="Off"),"physical panels off");
    const cutAt=Date.now();
    mirror.videoSocket.pause();
    await until(()=>starts.length===2,"silent source automatically restarted",30000);
    await until(connected,"stream after source restart");
    assert(Date.now()-cutAt>=10000,"Silent input must be probed before reconnecting");
    assert.equal(mirror.status.screenPowerOff,true);
    await until(async()=> (await physicalPower()).every(mode=>mode==="Off"),"off mode restored after reconnect");
    assert(await recording());
    console.log("Silent source recovered automatically; physical display-off intent and recording preserved");

    mirror.child.kill();
    await until(()=>starts.length===3,"server exit automatically restarted");
    await until(connected,"stream after server exit");
    assert(await recording());
    assert(starts.every(start=>start.serial===starts[0].serial));
    assert(starts.every(start=>JSON.stringify(start.profile)===JSON.stringify(starts[0].profile)));
    console.log("scrcpy process exit reconnected the original device with its original quality profile");

    interceptInput=true;
    await run(`(()=>{const input=document.querySelector('#keyboard-input');const video=Array.from(document.querySelectorAll('video')).find(v=>!v.hidden&&v.videoWidth);const box=video.getBoundingClientRect();video.setPointerCapture=()=>{};video.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:77,clientX:box.x+20,clientY:box.y+20,bubbles:true}));video.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:77,clientX:box.x+20,clientY:box.y+20,bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionend',{data:'恢复中文',bubbles:true}));})()`);
    await until(()=>input.some(command=>command.kind==="text"&&command.text==="恢复中文"),"IME forwarding after recovery");
    interceptInput=false;
    const copied=await run("window.hmRemote.copyScreenshot(document.querySelector('#device-select').value).then(()=>true)");
    assert(copied);
    assert(!statuses.includes("error"),"Recovery emitted terminal failure");
    const connectionStart=statuses.indexOf("streaming");
    assert(!statuses.slice(connectionStart).some(state=>state==="idle"||state==="stopping"),"Internal restart leaked a stop state");

    // 用户断开应取消排队的重连，并结束同一份录屏。
    const count=starts.length;
    mirror.child.kill();
    await until(()=>mirror.status.state==="reconnecting","pending restart before manual stop");
    await run("document.querySelector('#compact-connect-button').click()");
    await until(()=>mirror.status.state==="idle","manual disconnect");
    await pause(4500);
    assert.equal(starts.length,count,"Manual stop reconnected unexpectedly");
    const folder=join(videos,"鸿蒙投屏助手","录屏");
    const files=readdirSync(folder).filter(name=>name.endsWith(".webm")&&statSync(join(folder,name)).size>1000);
    assert.equal(files.length,1,"Recovery must preserve a single recording file");
    const recordingBytes=readFileSync(join(folder,files[0]));
    assert.equal(recordingBytes.subarray(0,4).toString("hex"),"1a45dfa3");
    assert((await physicalPower()).some(mode=>mode==="On"),"Manual stop should restore the physical screen");
    writeFileSync(join(output,"result.json"),JSON.stringify({success:true,serviceStarts:starts.length,recoveryKinds:preparations.map(r=>r.kind),recordingBytes:recordingBytes.length},null,2));
    console.log("Touch/IME forwarding, screenshots, one recording file and manual-stop cancellation passed");
    clearTimeout(deadline);window.close();finished=true;app.quit();
  }).catch(async error=>{
    clearTimeout(deadline);foreground=false;dropVideo=false;freezePlayback=false;
    console.error(error);
    await mirror?.stop().catch(()=>{});
    finished=true;app.exit(1);
  });
}
