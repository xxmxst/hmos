const {join,resolve}=require("node:path");
const {mkdirSync,writeFileSync}=require("node:fs");
const assert=require("node:assert/strict");

if(!process.versions.electron){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=require("node:child_process").spawn(require("electron"),[__filename],{cwd:process.cwd(),env,windowsHide:true,stdio:"inherit"});
  child.on("error",error=>{console.error(error);process.exitCode=1;});
  child.on("exit",code=>{process.exitCode=code??1;});
}else{
  const {app,BrowserWindow}=require("electron");
  const {promisify}=require("node:util");
  const execFile=promisify(require("node:child_process").execFile);
  const output=resolve(process.cwd(),".tmp",`screen-power-${Date.now()}`);
  const userData=join(output,"user-data");mkdirSync(userData,{recursive:true});
  writeFileSync(join(userData,"window-state.json"),JSON.stringify({mode:"compact"}));
  app.setPath("userData",userData);
  let allowQuit=false,window,serial;
  app.on("before-quit",event=>{if(!allowQuit)event.preventDefault();});
  app.on("browser-window-created",(_event,target)=>{target.show=()=>{};target.webContents.setBackgroundThrottling(false);});
  const pause=ms=>new Promise(done=>setTimeout(done,ms));
  const deadline=setTimeout(()=>{console.error("Screen power smoke timeout");allowQuit=true;app.exit(1);},70000);
  async function until(check,label,timeout=15000){
    const end=Date.now()+timeout;
    while(Date.now()<end){const value=await check();if(value)return value;await pause(200);}
    throw new Error(`Timed out: ${label}`);
  }
  const adb=async(args)=>{
    const result=await execFile(join(process.cwd(),"vendor","scrcpy","adb.exe"),["-s",serial,...args],{
      windowsHide:true,timeout:5000,maxBuffer:12*1024*1024,encoding:"utf8"
    });
    return result.stdout;
  };
  const physicalPower=async()=>{
    const dump=await adb(["shell","dumpsys","SurfaceFlinger"]);
    let physical=false;
    const modes=[];
    for(const line of dump.split(/\r?\n/)){
      if(/^Display \d+$/.test(line)){physical=true;continue;}
      if(/^Virtual Display /.test(line)){physical=false;continue;}
      const mode=/^\s+powerMode=(\w+)/.exec(line);
      if(physical&&mode){modes.push(mode[1]);physical=false;}
    }
    if(!modes.length)throw new Error("Physical display power state not available");
    return modes;
  };
  const run=code=>window.webContents.executeJavaScript(code,true);
  app.whenReady().then(async()=>{
    require(join(process.cwd(),"dist/main/main.cjs"));
    window=await until(()=>BrowserWindow.getAllWindows()[0],"window");
    await until(()=>run("document.querySelector('#status-title')?.textContent === '已连接'"),"auto-connected Android picture",25000);
    const key=await run("document.querySelector('#device-select').value");
    if(!key.startsWith("adb:"))throw new Error("Screen power test requires an Android device");
    serial=key.slice(4);
    const initialPower=await physicalPower();
    assert.ok(initialPower.includes("On"),"phone display must initially be on");
    await run(`window.__powerVideo=Array.from(document.querySelectorAll('video')).find(v=>!v.hidden&&v.videoWidth>0);
      window.__powerPixels=()=>{
        const video=__powerVideo,canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
        const context=canvas.getContext('2d');context.drawImage(video,0,0,64,64);
        const pixels=context.getImageData(0,0,64,64).data;let visible=0;
        for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>20)visible++;
        return {time:video.currentTime,visible:visible/4096,connected:document.querySelector('#status-title').textContent==='已连接',keyboardEnabled:!document.querySelector('#keyboard-input').disabled};
      }; void 0;`);
    const before=await run("__powerPixels()");
    assert.ok(before.visible>0.02,"visible phone content required for this test");
    const turnOff=async()=>{
      await run("document.querySelector('#screen-power-button').click()");
      await until(()=>run("document.querySelector('#screen-power-button').getAttribute('aria-pressed')==='true' && !document.querySelector('#screen-power-button').disabled"),"off mode in UI");
      await until(async()=>{const modes=await physicalPower();return modes.every(mode=>mode==="Off");},"physical panels powered off",8000);
    };
    await turnOff();
    // A static Android page need not produce more encoded frames. Animate the system shade using touch control.
    const swipe=()=>run(`(async()=>{
      const video=__powerVideo,x=Math.round(video.videoWidth/2),height=video.videoHeight;
      let y=2;
      await window.hmRemote.control({kind:'touch',phase:'down',x,y});
      try {
        for(let step=1;step<=6;step++){
          y=Math.round(height*0.08*step);
          await window.hmRemote.control({kind:'touch',phase:'move',x,y});
          await new Promise(done=>setTimeout(done,80));
        }
      } finally { await window.hmRemote.control({kind:'touch',phase:'up',x,y}); }
    })()`);
    await swipe();
    await until(async()=>{const current=await run("__powerPixels()");return current.time>before.time+0.5;},"new video frames after touch while display is off",8000);
    const off=await run("__powerPixels()");
    assert.ok(off.connected&&off.keyboardEnabled,"mirroring or input disabled while phone display was off");
    assert.ok(off.time>before.time+0.5,"video playback stopped with physical display");
    assert.ok(off.visible>0.02,"mirrored image became black");
    await run("window.hmRemote.control({kind:'keyboard',key:'ArrowLeft',ctrl:false,alt:false,shift:false})");
    await run("window.hmRemote.control({kind:'keyboard',key:'ArrowRight',ctrl:false,alt:false,shift:false})");
    assert.ok((await physicalPower()).every(mode=>mode==="Off"),"touch or keyboard unexpectedly lit the phone panel");
    await adb(["shell","cmd","statusbar","collapse"]);
    await pause(9500);
    const idle=await run("__powerPixels()");
    assert.ok(idle.connected&&idle.keyboardEnabled,"idle display-off session disconnected");
    await swipe();
    await until(async()=>{const current=await run("__powerPixels()");return current.time>idle.time+0.5;},"control remains live after idle display-off",8000);
    assert.ok((await physicalPower()).every(mode=>mode==="Off"),"idle display-off mode was lost");
    await adb(["shell","cmd","statusbar","collapse"]);
    console.log("Physical panels are Off; desktop video updates after touch and idle; keyboard control remains available");
    await run("window.hmRemote.setWindowMode('full')");
    await until(()=>run("document.querySelector('#app').dataset.windowMode==='full'"),"full mode");
    assert.equal(await run("document.querySelector('#screen-power-button small').textContent"),"亮屏");
    await run("document.querySelector('#screen-power-button').click()");
    await until(async()=>{const modes=await physicalPower();return modes.includes("On");},"physical display restored",8000);
    await until(()=>run("document.querySelector('#screen-power-button').getAttribute('aria-pressed')==='false' && !document.querySelector('#screen-power-button').disabled"),"on mode in UI");
    assert.equal(await run("__powerVideo === Array.from(document.querySelectorAll('video')).find(v=>!v.hidden&&v.videoWidth>0)"),true);
    await turnOff();
    window.close();
    await until(()=>window.isDestroyed(),"window closed");
    await until(async()=>{const modes=await physicalPower();return modes.includes("On");},"restore display on close",8000);
    clearTimeout(deadline);
    console.log("Screen-off/on toggling, mode switching and physical display restoration on close passed");
    allowQuit=true;app.quit();
  }).catch(async(error)=>{
    clearTimeout(deadline);console.error(error);
    if(window&&!window.isDestroyed()){
      await run("window.hmRemote.control({kind:'screen-power',on:true})").catch(()=>{});
      await run("window.hmRemote.stop()").catch(()=>{});
    }
    if(serial){
      await adb(["shell","cmd","statusbar","collapse"]).catch(()=>{});
      await adb(["shell","cmd","display","power-on","0"]).catch(()=>{});
    }
    allowQuit=true;app.exit(1);
  });
}
