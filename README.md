# 大肥鱼的黑心渔场

[在线试玩](https://lauhux022-creator.github.io/fatfish-island/) · [开发进度](docs/progress.md) · [数值与设计](docs/design.md)

给大肥鱼打工。甩一竿，把想逃跑的鱼拍晕，再连人带桨冲到秤边交货。M2.5 可在浏览器里和阿铲、桶桶、溜溜三个机器人一起上工。他们会钓鱼、交鱼，也会抢你的鱼。

## 本地开工

需要 Node.js 22.12 或更新版本。首次下载依赖用 `npm ci`，随后一条命令启动：

```sh
npm run dev
```

- [游戏开发版](http://127.0.0.1:5173/fatfish-island/)
- [Node 服务健康检查](http://127.0.0.1:8797/health)
- `npm run build` 检查类型并输出 `dist/`。`npm run preview` 预览静态产物。

## 怎么玩

| 操作 | 按键 |
| --- | --- |
| 移动、跳跃 | WASD 或方向键、空格 |
| 瞄准 | 移动鼠标 |
| 抛竿 | 朝岸外海面按住左键蓄力，松手抛出 |
| 收线 | 鱼或木箱咬钩后，连点左键 |
| 拍晕 | 瞄准上岸的鱼，按 F 或鼠标右键挥桨 |
| 搬鱼、抛鱼 | 近身按 E 抬晕鱼，再靠近橙色秤盘，朝秤按 E 投进去 |
| 抢鱼 | 靠近并瞄准队友手中的鱼或半空中的鱼，按 E 截胡 |
| 钩队友当饵 | 瞄准队友甩钩。钩中后朝海面点左键，甩出队友引来大鱼 |
| 友伤 | 朝队友按 F 或鼠标右键，从近处一桨拍飞 |
| 静音 | M 或界面上的静音按钮 |

触屏可点场景瞄准，使用屏幕方向键和动作按钮。被桨拍到或撞上岸上警示箱会摔成布娃娃，两秒后站起来。鱼款给最后有效碰鱼的人，被当饵的队友拿不到那条鱼的绩效。

每班 4 分钟。朝海面两处浅金水纹抛竿更容易等到咬钩。船员往同一条路赶去交货，榜首容易被围。活饵渔获在连击收益之外再乘 ×1.8。

左上显示本班团队指标。右上「绩效榜」可打开实时排名。下班暂停并结算，按 Enter 或点「继续上工」才进入下一天。第一名加发当班渔获款的 25%，末位扣当班渔获款的 20%，次日戴「待优化」帽并减速 10%。

## 复现与自查

- `?seed=m2-review` 固定渔获和机器人的随机序列。调试面板可读当前种子。
- `?day=3` 从第三天开局。M2.5 在每班结算确认后进入下一天。昼夜切换和三天团队指标安排在 M5。
- `?debug=1` 显示物理、交货、干扰、逃鱼及易手数据，并开放只读调试接口。
- 调试模式可加 `&shiftSeconds=48` 缩短每班时长，便于复验结算。可用范围 10–240 秒。
- [固定种子试玩](https://lauhux022-creator.github.io/fatfish-island/?seed=m2-review&day=3&debug=1) · [48 秒结算复现](https://lauhux022-creator.github.io/fatfish-island/?seed=m2-review&day=3&debug=1&shiftSeconds=48)

启动开发服务后，在另一终端运行 `npm run test:smoke`。脚本通过无头 Chrome 模拟按键和点击，验证钓鱼交货、钩木箱、逃鱼移除、队友活饵收益、友伤、两种抢鱼和日末暂停。需要 Chrome，亦可用 `CHROME_PATH` 指定兼容的 Chromium。指定 `SCREENSHOT_DIR=docs/screenshots` 可重拍截图；指定 `GAME_URL` 可验证远程部署。

`npm run test:review` 用相同种子和真实键鼠事件跑完整个 240 模拟秒，输出各人交鱼、入账、受扰、逃鱼及易手数据。默认用浏览器时钟推进整班，设置 `REVIEW_REALTIME=1` 可按真实时间跑。

## 目录与联机配置

| 路径 | 用途 |
| --- | --- |
| `shared/sim/` | 60 Hz 共享 Rapier 模拟、机器人输入、四人快照及集中数值 |
| `client/` | Three.js 场景、程序化模型、HUD、浏览器输入与合成音效 |
| `server/` | Node 开发服务与健康检查 |
| `docs/` | 进度、设计、实机截图 |
| `reviews/` | 审查意见 |
| `.github/workflows/pages.yml` | 构建并发布静态试玩 |

M3 接入老板的 MockBrain 和 DeepSeekBrain，M4 接入房间码、20 Hz 权威快照和断线观战。当前可通过复制 `.env.example` 为 `.env` 调整本地 Node 端口。约定 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL` 由后续 Node 联机服务从私有 `.env` 读取，默认使用 MockBrain。静态 Pages 试玩始终走浏览器本地模拟。

Pages 使用 GitHub Actions 发布 `main` 的静态产物，Vite base 为 `/fatfish-island/`。页面角落的版本和提交短哈希与构建来源对应。

## 审查流程

每轮开工前和每次推送前运行 `git pull --ff-only origin main`，用 `git log --stat -- reviews/` 检查新增或更新。先处理新审查，再开始新里程碑，顺序为 P0 → P1 → P2。「备注」可只回应。

在 `docs/progress.md` 对应小节逐条写明「已改」及提交号、「不改」及理由，或排期到哪个里程碑。有验收数据就按同样种子和操作复测，记录实测值。审查正文保持原样。审查者维护 `reviews/`、`assets/dafeiyu/`、`docs/dafeiyu-bible.md`，这些文件发生冲突时以远程版本为准。

处理完一份审查后提交并推送，提交信息含「回应 reviews/<文件名>」，打对应标签。大肥鱼的角色设定和参考图到位后按审查材料对齐。
