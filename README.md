<div align="center">

<img src="ui/assets/watch-desk-duo-v2.webp" alt="鲸声守望双角色值班台：黑鲸操作电脑，蓝鲸核对原文" width="100%">

<h1>鲸声守望</h1>

<p><strong>共同维护讨论与创作环境</strong></p>
<p>DSH 社区讨论环境巡查插件 · 阅读整篇讨论 · 结合专题语境 · 保留原文与依据</p>

<p>
  <a href="https://github.com/KitlingKittyRabbit/dsh-whale-watch/releases/tag/v0.9.0"><img src="https://img.shields.io/badge/试用版-0.9.0-b39a68?style=flat-square" alt="试用版 0.9.0"></a>
  <a href="https://github.com/KitlingKittyRabbit/dsh-whale-watch/actions/workflows/tests.yml"><img src="https://github.com/KitlingKittyRabbit/dsh-whale-watch/actions/workflows/tests.yml/badge.svg" alt="程序检查状态"></a>
  <a href="docs/TESTED.md"><img src="https://img.shields.io/badge/DSH_Web-0.2.2--rc.1-517d8d?style=flat-square" alt="适配 DSH Web 0.2.2-rc.1、0.2.1-rc.5 和 0.2.0-rc.2"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-517d8d?style=flat-square" alt="MIT 许可证"></a>
</p>

<p>
  <a href="#开始使用"><strong>开始使用</strong></a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="docs/USAGE.md">使用手册</a> ·
  <a href="https://github.com/KitlingKittyRabbit/dsh-whale-watch/releases">下载版本</a> ·
  <a href="https://github.com/KitlingKittyRabbit/dsh-whale-watch/issues">反馈问题</a>
</p>

</div>

---

鲸声守望帮助你从讨论中找出值得查看的具体言行，例如人身攻击、地图炮和普通创作区引战。它按**笔记正文、配图与已保存评论区**组织语境，结合可更换的专题资料分析，展示「可疑」或「其它」，并保留原文和判断依据，供你核对。

> 当前为实验版，模型结论需要结合原文复核。浏览器自动采集已停用；平台内容通过第三方数据 API 读取，也可直接导入原文试用。

## 能做什么

| 阅读与判断 | 资料与处理 |
| --- | --- |
| **整篇理解语境**<br>一起读取正文、配图、评论及回复；未读全时保留范围说明。 | **专题可以更换**<br>导入或编辑背景、术语与语境说明，内置 DS 拟人争议配置。 |
| **关键词与指定用户**<br>按关键词、用户主页或用户 ID 查笔记；可选择用户「且／或」关键词。 | **范围与费用可查看**<br>按篇数和数据额度限制读取，展示筛除、未读完和失败情况。 |
| **依据随原文查看**<br>展示具体引文、判断理由及不确定之处，区分「可疑」与「其它」。 | **已阅与缓存管理**<br>看完标记已阅；清空旧结论或采集记录后可撤销。 |
| **进度清楚可续跑**<br>同时统计篇数与条目数，停止后继续剩余任务，失败项可重试。 | **对话也能操作**<br>巡查助手操作工作台，配置制作助手整理专题草稿。 |

## 界面预览

![鲸声守望独立界面预览，使用人工编写的演示数据](docs/images/workbench-preview.png)

<p align="center"><sub>独立界面预览 · 演示数据不对应真实帖子或用户。正式工作台从 DSH 侧栏打开。</sub></p>

工作台保留三个页面：**巡查**处理内容，**专题**管理背景与术语，**设置**配置模型、规则和费用额度。

## 开始使用

已在 **DSH Web 0.2.2-rc.1、Linux、Node 24** 验证安装与原生工作台；同时保留 **0.2.1-rc.5 和 0.2.0-rc.2** 支持，详细验证范围见[实测记录](docs/TESTED.md)。其他系统和宿主版本尚未实测。

### 1. 安装插件

在 DSH「**插件 → 添加插件**」填写下面的仓库地址：

```text
https://github.com/KitlingKittyRabbit/dsh-whale-watch
```

启用「鲸声守望」并刷新页面，点击左侧同名入口。需要固定版本时，可在 [Releases 下载 `.tgz` 安装包](https://github.com/KitlingKittyRabbit/dsh-whale-watch/releases)，在同一输入框填写其本地绝对路径。

<details>
<summary>已经安装旧版，如何升级？</summary>

按宿主提示升级或卸载旧包后重装；若仍显示旧版或入口未更新，再重启 DSH。个人数据保存在插件包目录之外，会继续保留。仓库安装获得默认分支当前版本；安装包对应指定发布版本。

若遇到旧包与 DSH 0.2.2-rc.1 不兼容，请安装 **0.9.0**，其中已包含 0.8.10 的兼容修复，无需添加版本豁免。若重试仍取得旧版，可从 Releases 下载 0.9.0 安装包后安装。

</details>

### 2. 选择专题和模型

到「**专题 → 更换专题**」选择内置 DS 配置，或导入自己的专题文件；到「**设置**」选择分析模型，默认沿用 DSH 已配置的模型。

### 3. 开始巡查，或先导入原文

在「**巡查**」输入关键词开始读取与分析。要读取平台内容，需先在设置中填写 SocialDataX 数据密钥；也可展开「**导入原文**」，使用自己的文字试用，无需数据密钥。

也可填写「**指定用户**」：接受完整主页链接或用户 ID，每行一个，最多 5 个。关键词留空时只读这些用户的笔记；同时填写关键词后，可选 **且**（标题或正文命中任一关键词）或 **或**（合并用户笔记与全站关键词结果、去重）。它不检索某用户在全站发表过的全部评论。筛选时读取笔记也计入数据额度，详见[搜索范围说明](docs/USAGE.md#搜索范围与指定用户)。

默认每轮最多读取 **5 篇**、整篇分析 **5 篇**，数据读取额度 **5 元**。**数据 API、文字分析和看图分别计费**，数据额度不包含模型费用。首次可选择仅采集，核对材料后再分析。

查看原文和依据后，点击「**已阅**」整理列表；遇到停止或失败，按页面提示继续或重试。详细操作见[使用手册](docs/USAGE.md)。

## 两个助手，分工清楚

| 对话模式 | 适合做什么 |
| --- | --- |
| **鲸声守望** | 操作工作台：采集、分析、继续任务、查看原图、标记已阅、管理记录和专题。与界面共用同一套数据。 |
| **鲸声守望配置制作助手** | 根据提供的材料整理背景、术语和来源，保存专题草稿。查看草稿后，再由你采用。 |

日常操作用第一个，整理专题用第二个。数据密钥在设置表单填写；助手对话和模型任务可能产生调用费用。

## 了解更多

| 文档 | 内容 |
| --- | --- |
| [使用手册](docs/USAGE.md) | 搜索筛选、专题设置、继续任务、缓存管理、费用与本机数据。 |
| [专题配置指南](docs/CONTEXT_CONFIG.md) | 背景、术语与语境说明的文件格式，如何导入和分享。 |
| [版本更新](docs/CHANGELOG.md) | 0.9.0 指定用户与关键词且／或组合，及近期更新。 |
| [实测记录](docs/TESTED.md) | 已验证的安装环境、程序检查和真实模型评估范围。 |
| [反馈与贡献](CONTRIBUTING.md) | 如何报告误判、漏判和使用问题，如何参与开发。 |

采集使用 SocialDataX 第三方服务；视频画面与音频不识别。采集记录保存在本机，待分析材料会发送到所选模型服务。插件不自动举报，也不认定作者所属阵营。更完整的范围与费用说明见[使用手册](docs/USAGE.md)。

<details>
<summary><strong>本地开发</strong></summary>

```bash
npm ci --ignore-scripts
npm test
npm run pack:plugin
```

生成 `artifacts/dsh-dafeiyu-patrol-0.9.0.tgz`，只包含运行代码、界面、公开配置、样例和文档，不包含个人记录或凭据。

`npm run dev` 提供独立界面预览，不调用真实模型。正式工作台通过 DSH 原生侧栏插槽挂载。更多验证说明见[贡献指南](CONTRIBUTING.md)。

</details>

---

<p align="center">欢迎带上脱敏原文、必要上下文和具体依据，一起讨论误报与漏判。<br><a href="LICENSE">MIT 许可</a> · <a href="ui/assets/README.md">插画与素材说明</a> · <a href="https://github.com/KitlingKittyRabbit/dsh-whale-watch/issues">参与反馈</a></p>
