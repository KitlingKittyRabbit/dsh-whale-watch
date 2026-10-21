# 鲸声守望美术方案

2026-10-17。八份独立设计稿均保留 Q 版造型、鲸鳍耳、蓝发与短斗篷。

| 文件 | 方向 | 状态 |
| --- | --- | --- |
| `keeper-chibi-cool-painterly-v1.png` | 冷调厚涂与木刻头像 | 用户选中保留 |
| `keeper-chibi-classical-oil-v1.png` | 古典油画，强调光影和油彩质感 | 比较稿 |
| `keeper-chibi-art-deco-v1.png` | Art Deco，强调几何构成和徽记感 | 比较稿 |
| `keeper-chibi-community-inspector-v1.png` | 冷调厚涂，增加观察镜、评论记录板和工作徽章，提灯挂腰侧 | 职责表达试稿 |
| `keeper-chibi-community-inspector-v2.png` | 记录板朝向角色，低头核对；深蓝灰底，移除灯塔、海岸和提灯 | 职责表达修订稿 |
| `keeper-chibi-community-inspector-v3.png` | 夜间社区值班室：讨论公告板、木桌与台灯；人物姿势和头像延续v2 | 背景场景试稿 |
| `keeper-chibi-community-inspector-v4.png` | 尾巴连接和轮廓仍然错误，像贴在裙后的膜翼 | 用户否决，留档 |
| `keeper-chibi-community-inspector-v5.png` | 参考真实鲸尾照片重画整段尾巴：弯曲尾柄连接两瓣中央，尾缘留内凹缺口 | 用户确认，作为蓝鲸角色设定 |

v5保留为角色设定，原先将设定稿裁入页头和侧栏的方案已撤下。产品页使用独立构思的双角色横向值班场景；侧栏与插件列表统一使用「对话框＋放大镜」符号。

本轮使用内置 imagegen 生成；两份比较稿的完整提示词保存在 `generation-prompts.json`，参考图为已保存的冷调厚涂版本。原生成文件保留，各方案分别另存。

职责表达试稿的完整提示词保存在 `community-inspector-prompt.json`，同样使用内置 imagegen 和冷调厚涂版本作为参考。

职责表达修订稿使用内置 imagegen 编辑上一份试稿；完整提示词保存在 `community-inspector-v2-prompt.json`。旧稿保留，未替换插件运行图标。

夜间值班室背景试稿使用内置 imagegen 编辑v2；完整提示词保存在 `community-inspector-v3-prompt.json`。

尾巴修订稿使用内置 imagegen 编辑v3；完整提示词保存在 `community-inspector-v4-prompt.json`，原版本保留。

v5重新以v3为底图，使用NOAA鲸尾照片作为结构参考；完整提示词、参考来源和生成方式保存在 `community-inspector-v5-prompt.json`。

双角色前端场景使用 `watch-desk-duo-v2.png`：完整值班室横幅，两侧均有可见环境。运行图为 `ui/assets/watch-desk-duo-v2.webp`，完整提示词保存在 `watch-desk-duo-v2-prompt.json`；首版原图与提示词也保留。构图与页面约定见 `frontend-direction.md`。
