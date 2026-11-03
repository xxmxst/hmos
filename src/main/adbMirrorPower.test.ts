import { describe, expect, it } from "vitest";
import { AdbMirror } from "./adbMirror";
import type { MirrorStatus } from "../shared/types";

class ControlSocket {
  destroyed = false;
  writableLength = 0;
  deferred = false;
  failure: Error | undefined;
  pending: (() => void) | null = null;
  events: string[] = [];
  write(data: Buffer, callback: (error?: Error) => void): void {
    this.events.push(data.toString("hex"));
    if (this.deferred) { this.deferred = false; this.pending = () => callback(this.failure); } else callback(this.failure);
  }
  destroy(): void { this.destroyed = true; this.events.push("destroy"); }
}

function fixture() {
  const mirror = new AdbMirror({hdc:null,java:null,bridgeJar:"bridge.jar",sdkJar:"sdk.jar"});
  const socket = new ControlSocket();
  const target = mirror as unknown as { controlSocket: ControlSocket; currentStatus: MirrorStatus };
  target.controlSocket = socket;
  target.currentStatus = {state:"streaming",message:"Android 投屏中",screen:{width:1080,height:2400,rotation:0}};
  return {mirror,socket};
}

describe("Android display power lifecycle", () => {
  it("keeps controls and streaming active while the physical display is off", async () => {
    const {mirror,socket} = fixture();
    await mirror.control({kind:"screen-power",on:false});
    expect(mirror.status).toMatchObject({state:"streaming",screenPowerOff:true});
    await mirror.control({kind:"key",key:"VolumeUp"});
    expect(mirror.status.screenPowerOff).toBe(true);
    await mirror.control({kind:"screen-power",on:true});
    expect(socket.events[0]).toBe("0a00");
    expect(socket.events.at(-1)).toBe("0a01");
    expect(mirror.status).toMatchObject({state:"streaming",screenPowerOff:false});
  });

  it("requests restoration before destroying the control channel on stop", async () => {
    const {mirror,socket} = fixture();
    await mirror.control({kind:"screen-power",on:false});
    await mirror.stop();
    expect(socket.events).toEqual(["0a00","0a01","destroy"]);
    expect(mirror.status.state).toBe("idle");
    expect(mirror.status.screenPowerOff).not.toBe(true);
  });

  it("does not report display-off when writing the command fails", async () => {
    const {mirror,socket} = fixture();
    socket.failure = new Error("write failed");
    await expect(mirror.control({kind:"screen-power",on:false})).rejects.toThrow("控制操作失败");
    expect(mirror.status.screenPowerOff).not.toBe(true);
  });

  it("ignores an old control completion after the session has stopped", async () => {
    const {mirror,socket} = fixture();
    socket.deferred = true;
    const control = mirror.control({kind:"screen-power",on:false});
    await mirror.stop();
    expect(socket.events).toEqual(["0a00","0a01","destroy"]);
    socket.pending?.();
    await control;
    expect(mirror.status.state).toBe("idle");
    expect(mirror.status.screenPowerOff).not.toBe(true);
  });

  it("still finishes cleanup if the device disconnects while display-off is requested", async () => {
    const {mirror,socket} = fixture();
    await mirror.control({kind:"screen-power",on:false});
    socket.destroyed = true;
    await expect(mirror.stop()).resolves.toBeUndefined();
    expect(mirror.status.state).toBe("idle");
  });
});
