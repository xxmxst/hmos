# 第三方组件说明

## HOScrcpy SDK

- 版本：v1.0.15-beta
- 来源：https://gitcode.com/OpenHarmonyToolkitsPlaza/HOScrcpy
- 下载：https://gitcode.com/OpenHarmonyToolkitsPlaza/HOScrcpy/releases/tag/v1.0.15-beta
- SHA-256：`d2b8091faf75ccda27a1b5b7a8eea2791a2d99c06a1ade8b491ec4679fbdd649`

仓库中的许可证模板信息不完整。在作者明确授予二进制再分发许可之前，不应公开
发布内含该 SDK JAR 的安装包。

## Electron / Chromium / Node.js

Electron 及其包含的 Chromium、Node.js 按各自上游许可使用。发布产物中的
`LICENSES.chromium.html` 和 Electron 许可文件应保留。

## scrcpy / Android Platform Tools

- 当前随包版本：scrcpy 5.0.1（使用用户已验证的官方 Windows 完整发行版）。
- 上游：https://github.com/Genymobile/scrcpy
- scrcpy：Apache-2.0；保留 `vendor/scrcpy/LICENSE.txt`。
- 随发行版提供的 ADB、FFmpeg、SDL 和 libusb 按各自上游许可使用，打包时保留完整发行资源和相关许可。
- 客户端与 `scrcpy-server` 必须来自同一发行版，不修改官方服务端二进制。

## JMuxer

用于 H.264 MediaSource 兼容回退。发布时保留 npm 包中附带的许可证文本。

## Tesseract.js 与离线语言数据

- `tesseract.js` / `tesseract.js-core` 7.0.0：Apache-2.0
- `@tesseract.js-data/chi_sim` 1.0.0：MIT
- `@tesseract.js-data/eng` 1.0.0：MIT

应用打包 `4.0.0` 的简体中文和英文模型。文字识别完全在本机进行，不会把截图或识别结果上传到网络。
