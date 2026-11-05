# 鸿蒙投屏助手

面向 Windows 10/11 x64 的 USB 投屏控制工具，同时保留 HarmonyOS 5.0.1（API 13）及以上的 HDC 通道，并支持 Android 设备的 ADB / scrcpy 通道。桌面端可以显示手机画面，并使用鼠标完成点击、拖动、滑动和滚动；同时提供系统按键、电脑文本粘贴到手机，以及无需安装手机应用的离线 OCR 取字。

## v0.1.1 当前版本

2026-11-05 更新，新增 Android 拖入 APK 安装，并修复 ADB 在线时画面卡住后无法自动恢复的问题。视频采用消息通道/解码器局部修复和最多 3 次原设备重连，恢复期间保留同一份录屏；主动断开或关闭窗口会取消重连。

此版本通过 TypeScript 类型检查、187 项自动测试及构建，并完成 Android 实机故障恢复、录屏连续性、最终失败与关窗保存验证；APK 拖放安装也已完成实机验证。源码与版本说明见 [v0.1.1 Release](https://github.com/xxmxst/hmos/releases/tag/v0.1.1)。沿用公开源码归档范围，不附带含 HOScrcpy SDK 的运行包。

## v0.1.0 源码归档

此版本于 2026-11-03 归档到 [xxmxst/hmos](https://github.com/xxmxst/hmos)，使用 `v0.1.0` 标签和 [GitHub Release](https://github.com/xxmxst/hmos/releases/tag/v0.1.0) 固定源码版本。

公开仓库包含应用源码、Java 桥接源码、测试、构建脚本、配置和中文批处理。第三方工具二进制、运行包、设备截图与录屏、日志、缓存和本机开发配置不在归档范围内。Release 提供源码下载，不附带 Windows 运行包；HOScrcpy SDK 的再分发限制见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

归档验证包括 TypeScript 类型检查、128 项自动测试及构建。Android/ADB 的自动连接、键盘输入、截图、OCR、录屏及灭屏投屏已通过当前设备实机验证；鸿蒙通道保留，尚未完成鸿蒙 USB 实机验证，灭屏投屏目前仅支持 Android/ADB。

## 当前能力

- 同时发现 HDC 和 ADB USB 设备，区分“鸿蒙 / Android”，显示授权、离线和未知状态；一条通道不可用不会阻断另一条。
- 完整与极简模式可切换，记住模式、窗口大小和位置；极简模式保留左侧快捷操作和 Windows 原生标题栏。
- 鸿蒙通过 HOScrcpy SDK、Android 通过官方 scrcpy-server 获取 H.264 视频，共用 JMuxer + MediaSource 解码。
- 共用“复制截图”按钮直接把图片放入电脑剪贴板，无需选择保存文件；“保存截图”按钮可另存 PNG。原始截图失败时回退到当前视频帧。
- 共用录屏按钮保存 WebM 视频（仅画面、不录声音）；旋转时保持录屏文件尺寸并等比例居中。
- 鼠标点击、拖动、滚轮、右键返回，以及主页、电源、音量和旋转控制。
- Android/ADB 可使用左栏“灭屏”仅关闭手机物理屏幕，电脑继续投屏和控制；同一按钮变为“亮屏”用于恢复。断开投屏时会尝试恢复亮屏，鸿蒙通道暂不支持此操作。
- 点击投屏中的手机输入框后，可直接输入英文、数字、符号；电脑中文输入法选词提交后整段上屏。
- 支持回车、退格、Delete、Tab、方向键、Home/End、PageUp/PageDown，以及 Shift 选择、Ctrl+A/Z/Y 等组合键；Ctrl+C/X 在手机内部复制/剪切，Ctrl+V 或“粘贴”使用电脑剪贴板。
- Android 普通 ASCII 直接注入，中文及其他 Unicode 通过手机剪贴板提交，会替换手机剪贴板内容；电脑剪贴板不因直接键入而改变。
- 输入仅在投屏区域获焦时生效，切换设备、断开连接或进入 OCR 时停止转发。
- 使用左侧“识字”按钮冻结手机画面，在电脑上选择文字并复制。
- 简体中文和英文 OCR 完全离线运行，截图与识别结果不会上传或持久化。

投屏、控制、粘贴和 OCR 均不要求在手机上安装 HAP。

## Android 连接与截图录屏

1. 手机开启 USB 调试，连接电脑并确认授权。
2. 完整模式可在设备列表选择标有“Android”的 USB 设备并开始投屏；鸿蒙设备继续选择“鸿蒙”。极简模式会持续检测 USB 设备，只有一台已授权设备时自动开始投屏；多台设备时可直接在极简界面选择并连接。左侧“断开”结束投屏后不会立即自动连回，可点击“连接”重试或拔插设备重新连接。
3. 本版本使用 scrcpy 5.0.1 完成实机验证。请从 [官方发行页](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1) 自行下载完整 Windows 发行版，解压后点“配置 Android”选择其中的 `scrcpy.exe`，必须保留同版 `scrcpy-server` 和 DLL。源码仓库不包含这些二进制文件。
4. 左侧“复制截图”直接复制图片，可在支持图片的输入框中按 `Ctrl+V` 粘贴；“保存截图”另存 PNG。左侧“录屏”点击后直接开始，同一按钮录制时显示“停录”，再次点击自动保存 WebM 到系统“视频”目录下的 `鸿蒙投屏助手/录屏` 文件夹，文件夹会自动创建，文件按录制时间命名并附加随机标识。停止投屏、设备断开或关闭窗口时会结束录屏并保存已收到的数据。
5. 录屏使用电脑端 30 fps 画布编码，不包含手机声音；使用录制开始时的画面尺寸，横竖屏变化时保留比例和黑边。

Android 工具查找优先级：`HMR_SCRCPY_PATH`、应用中保存的工具路径、打包或开发目录的 `scrcpy` / `vendor/scrcpy`、PATH、下载目录的 scrcpy 发行版。ADB 优先使用 `HMR_ADB_PATH`，其次是所选 scrcpy 同目录的 ADB，再查找 Android SDK 环境变量与 PATH。当前解析 scrcpy 3.x / 4.x / 5.x 协议；系统升级后优先选择已验证可用的最新官方发行版，不混用客户端和服务端文件。

截图、录屏仅在用户操作后保存到本机，不会上传。部分手机会在截图字节前输出 Warning，Android 通道会识别并剥离该前缀，避免保存损坏的图片。

## Android 视频自动恢复

ADB 仍在线但画面不更新时，程序会区分手机端断流、电脑端收包中断和解码停滞：优先重建消息通道或解码器，并对支持的 scrcpy 发送视频重置探测；仍失败时按 1、2、4 秒间隔，最多连续重连原设备 3 次，保留原画质。连续健康运行 60 秒后恢复重试额度。

恢复期间显示最后一帧和“正在恢复画面”，暂停向手机发送新输入；录屏保留在同一文件中。最终失败会结束并保存录屏。主动断开或退出会取消重连，物理灭屏设置在恢复后重新应用。静止画面、OCR、最小化和系统休眠有单独的探测与缓冲处理；不支持视频重置命令的早期 scrcpy 3.x 不会仅因长时间静止而自动重连。

## Android 拖入 APK 安装

连接并授权 Android USB 设备，在设备列表选中目标设备后，将单个 `.apk` 文件拖到窗口即可安装；完整与极简模式均支持，投屏过程中也可使用。安装会覆盖同签名应用并保留数据，不会自动启动应用。安装期间显示状态并锁定设备选择，手机如出现 USB 安装授权，需要手动确认。

暂不支持鸿蒙 HDC、多个 APK 或 `.apks` / `.xapk` 拆分包。签名冲突、版本降级等失败会提示原因，不会自动卸载原应用。关闭窗口会等待安装结束，再走原有录屏保存流程。

## OCR 使用方法

1. 开始投屏并等待画面正常显示。
2. 点击左侧工具栏的“识字”。
3. 鸿蒙优先调用 `snapshot_display`、Android 优先调用 `screencap` 获取原始分辨率截图；如果失败，会自动使用当前视频帧。
4. 等待离线识别完成，然后在冻结画面的文字上拖动选择并按 `Ctrl+C`，也可以点击“复制选中”或“复制全部”。
5. 按 `Esc` 或点击“退出识字”恢复实时投屏和手机控制。

第一次识字需要初始化 OCR 引擎，通常会比后续识别稍慢。OCR 模式会阻止鼠标事件发送到手机，避免选择文字时误触手机。复杂背景、极小字号、手写字和艺术字体可能降低识别准确率。

## 开发运行

要求 Node.js 20+、npm 和 JDK 17+，确保 `java`、`javac`、`jar` 可在命令行运行；生成最小 JRE 时还需要 JDK 的 `jlink`。

克隆源码后按需准备本地工具：

- Android：自行下载并完整解压 scrcpy 5.0.1，运行后通过“配置 Android”指定路径，也可放入 `vendor/scrcpy` 或设置 `HMR_SCRCPY_PATH`。
- 鸿蒙：自行准备 HDC 3.2.0b 或更高版本及随附文件，放入 `vendor/hdc` 或设置 `HMR_HDC_PATH`；HOScrcpy SDK 由下方脚本下载并校验固定 SHA-256。
- `vendor` 为本地依赖目录，已排除在版本控制之外。离线 OCR 引擎和语言数据由 npm 锁定依赖安装，构建时复制到输出目录。

```powershell
git clone https://github.com/xxmxst/hmos.git
cd hmos
npm.cmd ci
npm.cmd run vendor:sdk
npm.cmd run typecheck
npm.cmd test
npm.cmd start
```

`npm start` 会构建桌面端、复制本地中英文字库并启动 Electron，无需安装 HAP。

## Windows 一键命令

项目根目录提供了一组可直接双击的中文批处理文件：

- `00-常用命令菜单.bat`：统一菜单入口。
- `01-启动开发版.bat`：构建并启动 Electron 开发版。
- `02-查看手机连接.bat`：显示 HDC 版本和手机连接状态。
- `03-安装项目依赖.bat`：安装或更新 npm 依赖。
- `04-运行自动测试.bat`：运行全部自动测试。
- `05-完整检查.bat`：依次执行类型检查、测试、构建和冒烟测试。
- `06-快速打包.bat`：复用已有 SDK、HDC 和 JRE 生成安装版与便携版。
- `07-完整打包.bat`：重新准备 SDK/JRE 后执行完整发布打包。
- `08-打开打包目录.bat`：列出最新安装包并打开 `release` 目录。

所有命令都会自动切换到项目目录，并在执行结束后保留窗口显示结果。构建或打包前请关闭正在运行的投屏软件，否则 Java 桥接 JAR 可能因被占用而无法覆盖。

HDC 解析优先级如下：

1. 环境变量 `HMR_HDC_PATH`
2. `vendor/hdc/hdc.exe`
3. 开发机上的 `D:\hdc\hdc.exe`
4. `PATH` 中的 `hdc.exe`

建议使用 HDC 3.2.0b 或更高版本。连接手机后，`hdc list targets -v` 中的 USB 设备必须为 `Ready` 或 `Connected`。

## 验证

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:ocr
```

`smoke:ocr` 会禁止网络读取，加载应用打包的本地中英文字库，并执行一次完整识别调用。

`node scripts/smoke-apk-install.cjs` 使用隔离设备验证真实磁盘文件拖放、preload 路径解析、安装目标绑定、重复安装拦截、模式切换和关窗等待，不会安装到手机。需要真机验证时显式设置 `HMR_TEST_APK` 为测试 APK 的完整路径；仅在恰好一台 Android USB 设备就绪时执行安装，不自动打开应用，同时验证投屏、录屏连续性和关窗保存。

`node scripts/smoke-video-recovery.cjs` 会连接唯一已授权的 Android USB 实机，模拟消息通道丢包、播放停滞、视频断流和本应用 scrcpy 退出，验证原设备恢复、灭屏设置、录屏连续性与主动断开取消；不重启全局 ADB server，测试产物仅保存在 `.tmp`。

窗口布局和自动连接场景可分别通过 `node scripts/smoke-window.cjs`、`node scripts/smoke-compact-connection.cjs` 在隔离设备环境中验证。连接 Android 手机后，`node scripts/smoke-screen-power.cjs` 可验证物理灭屏、实时画面、控制和退出亮屏恢复；测试会临时滑动系统通知面板并在结束时收起，手机屏幕也会恢复。

连接已授权的 Android USB 手机后，可显式运行 `npm run smoke:android`，验证真实解码、原始截图、OCR 截图、录屏播放和关窗保存。该测试会截取当前手机画面并录制短视频，产物保存在 `.tmp/android-smoke-*`，不加入普通单元测试。

## 架构

```text
Electron Renderer
  ├─ MessagePort 接收 H.264 视频并渲染
  ├─ 鼠标坐标映射与手机控制
  └─ 冻结截图 + 可选择 OCR 文字层
Electron Main
  ├─ HDC：鸿蒙发现、snapshot_display、截图拉取与即时清理
  ├─ ADB：Android 发现、screencap、官方 scrcpy 视频与控制协议
  ├─ 截图保存与分块录屏写入
  ├─ Tesseract.js：本地简体中文 + 英文识别
  └─ Java 17 边车：HMR1 二进制协议 ↔ HOScrcpy SDK
```

主进程同一时间最多保留一张 OCR 截图，限制为 25 MiB、2000 万像素；手机和电脑上的临时截图会在拉取后立即删除。识别结果仅返回渲染进程用于显示和复制。

## 发布构建

1. 将经过验证的新版 HDC 及随附 DLL 放入 `vendor/hdc`，将官方完整 scrcpy 发行版放入 `vendor/scrcpy`（当前为 5.0.1）；打包时两条通道的资源一起携带。
2. 运行 `node scripts/build-jre.mjs` 生成最小 JRE。
3. 运行 `npm run dist`。

最终生成 NSIS 安装包和便携版。当前项目没有 Windows 代码签名证书，未签名构建可能触发 Windows SmartScreen 提示。

## 第三方许可

HOScrcpy SDK v1.0.15-beta 在构建时从 GitCode 发布页下载并校验固定 SHA-256。公开分发包含该 JAR 的安装包前，应先向 SDK 作者确认二进制再分发许可；未确认前仅限个人或内部开发使用。Tesseract.js 与语言数据许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
