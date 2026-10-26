# 第三方声明

项目代码采用 AGPL-3.0-only；原项目维护者为 anlonely，贡献者保留各自版权。以下依赖并不因此改变自身许可证。

## JavaScript 依赖

版本依据本次 `package-lock.json`。完整传递依赖及版本见锁文件，许可证正文和版权声明随各 npm 包分发并保留在安装目录。构建或分发镜像时不要删除依赖中的许可文件。

| 包 | 锁定版本 | 声明许可证 | 用途 |
| --- | --- | --- | --- |
| `busboy` | 1.6.0 | MIT | 运行 |
| `express` | 5.2.1 | MIT | 运行 |
| `https-proxy-agent` | 7.0.6 | MIT | 运行 |
| `jszip` | 3.10.1 | (MIT OR GPL-3.0-or-later) | 运行 |
| `node-fetch` | 3.3.2 | MIT | 运行 |
| `puppeteer-core` | 25.16.0 | Apache-2.0 | 运行 |
| `qrcode` | 1.5.4 | MIT | 运行 |
| `socks-proxy-agent` | 8.0.5 | MIT | 运行 |
| `ws` | 8.22.0 | MIT | 运行 |
| `@vitejs/plugin-react` | 5.2.0 | MIT | 开发/构建 |
| `concurrently` | 10.0.6 | MIT | 开发/构建 |
| `lucide-react` | 0.562.0 | ISC | 开发/构建 |
| `react` | 19.2.7 | MIT | 开发/构建 |
| `react-dom` | 19.2.7 | MIT | 开发/构建 |
| `vite` | 7.3.7 | MIT | 开发/构建 |

`busboy` / `streamsearch` 的锁文件没有 license 字段，本次按已安装包自带 LICENSE 核对为 MIT。传递依赖中还包括 ISC、BSD、Apache-2.0、CC-BY-4.0、MIT/Zlib 等声明；具体适用范围以包内原文为准。

## 运行镜像

Docker 镜像包含 Node.js、Alpine、Chromium、NSS、字体及其依赖，各自适用上游许可证；镜像中保留 npm 包和系统包的分发内容。Chromium 与 Noto 字体的商标和版权不属于本项目。

## 图片与教程

公开版本的 `clan-logo.svg` 和 `specialty-laborer.svg` 是随源码提供的简单矢量图。原社区 Logo、录屏、成员截图及邀请二维码未包含在公开包中；文字教程不包含成员身份。

现有专长矢量图与小程序导航图标作为项目素材保留；部署者新增或替换的素材应自行确认授权并记录来源。用户上传的头像、Logo、地图和其他内容属于各自权利人，不包含在开源代码授权中。

Steam、Discord、KOOK、微信和 Rust 的名称用于说明集成兼容性，不表示官方合作、授权运营或背书。
