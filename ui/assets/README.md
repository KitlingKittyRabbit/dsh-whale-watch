# 前端美术资源

`watch-desk-duo-v2.webp` 是为巡查页专门绘制的横向值班场景，2169×725，约3:1，约317KB。黑鲸在电脑上调度工具、整理文件；蓝鲸对照讨论材料核对语境和依据。新版两侧均为完整可见的房间环境，标题、专题和按钮由左上角的紧凑半透明信息牌呈现；图片等比铺满横幅，不再加整侧深色渐变。图片本身不含页面文字。窄面板收起装饰场景，专题和设置页使用紧凑页头。

原始PNG保留在 `design/whale-watch/watch-desk-duo-v2.png`。运行WebP仅作格式编码，未重新绘画。`npm run art:build` 将WebP嵌入两份样式表，打包前自动执行；生成的样式表也随源码提供。页面不依赖新增图片路由，不需要用户安装图片转换工具。

蓝鲸沿用用户确认的v5角色设定。黑鲸身份参考来自 [dsh-stickers](https://github.com/william-jin-cmu/dsh-stickers)，仓库将黑鲸娘表情图归功于少女阿原 [@ayuanwong](https://github.com/ayuanwong)。参考图仅供本次绘画使用，没有随插件分发。

本次使用内置 imagegen 生成新场景，完整提示词、参考来源和检查记录见仓库 `design/whale-watch/watch-desk-duo-v2-prompt.json`。原v5设定稿保留在设计目录，不再直接裁切进产品界面。

`discussion-search.svg` 为「对话框＋放大镜」单色符号，侧栏以相同几何内联呈现，继承宿主颜色和图标尺寸。`ui/icon.svg` 为其深海蓝底版本，用于插件列表。

本目录随插件打包，不依赖外部图片站点。
