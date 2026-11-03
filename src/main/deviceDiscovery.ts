import type { DeviceInfo } from "../shared/types";

interface DeviceClient { listDevices(): Promise<DeviceInfo[]>; }

export async function discoverDevices(hdc: DeviceClient | null, adb: DeviceClient | null): Promise<DeviceInfo[]> {
  const clients = [
    ...(hdc ? [{ backend: "hdc" as const, client: hdc }] : []),
    ...(adb ? [{ backend: "adb" as const, client: adb }] : [])
  ];
  const results = await Promise.allSettled(clients.map(({ client }) => client.listDevices()));
  if (results.length > 0 && results.every((result) => result.status === "rejected")) {
    throw new Error("无法读取设备，请检查 HDC / ADB 工具和 USB 连接后重试");
  }
  return results.flatMap((result, index) => result.status === "fulfilled"
    ? result.value.filter((device) => device.transport.toUpperCase() === "USB").map((device) => ({
      ...device, backend: clients[index]!.backend,
      label: clients[index]!.backend === "hdc" ? `鸿蒙 · ${device.label}` : device.label
    })) : []);
}
