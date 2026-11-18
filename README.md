# 大肥鱼的黑心渔场

[在线试玩](https://lauhux022-creator.github.io/fatfish-island/) · [开发进度](docs/progress.md) · [数值与设计](docs/design.md)

给大肥鱼打工。甩一竿，把想逃跑的鱼拍晕，再连人带桨冲到秤边交货。M1 是单人手感版，打开网页即可上工。

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
| 搬鱼、抛鱼 | 近身对晕鱼按 E；靠近橙色秤盘，朝秤按 E 投进去 |
| 静音 | M 或界面上的静音按钮 |

触屏可点场景瞄准，使用屏幕方向键和动作按钮。岸上标了警示条的箱子会让冲过来的玩家摔成布娃娃，两秒后站起来。钩海面上的木箱可练习回收和抛投。

## 复现与自查

- `?seed=m1-review` 固定渔获随机序列。启动时 HUD 的调试面板可读当前种子。
- `?day=3` 从第三天开局。M1 的天数用于复现和显示，日夜及结算在 M5 接入。
- `?debug=1` 显示物理和交货状态，并开放只读的浏览器调试接口。
- [复现用试玩链接](https://lauhux022-creator.github.io/fatfish-island/?seed=m1-review&day=3&debug=1)

启动开发服务后，在另一终端运行 `npm run test:smoke`。脚本通过无头 Chrome 模拟按键和点击，验证交鱼入账、钩木箱和布娃娃恢复。需要 Chrome，亦可用 `CHROME_PATH` 指定兼容的 Chromium。指定 `SCREENSHOT_DIR=docs/screenshots` 可重拍截图；指定 `GAME_URL` 可验证远程部署。

## 目录与联机配置

| 路径 | 用途 |
| --- | --- |
| `shared/sim/` | 60 Hz 共享 Rapier 模拟、输入和快照、集中数值 |
| `client/` | Three.js 场景、程序化模型、HUD、浏览器输入与合成音效 |
| `server/` | Node 开发服务；M1 提供健康检查 |
| `docs/` | 进度、设计、实机截图 |
| `reviews/` | 审查意见 |
| `.github/workflows/pages.yml` | 构建并发布静态试玩 |

M2 加入机器人队友。M3 接入老板的 MockBrain 和 DeepSeekBrain，M4 接入房间码、20 Hz 权威快照和断线观战。当前可通过复制 `.env.example` 为 `.env` 调整本地 Node 端口。约定 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL` 由后续 Node 联机服务从私有 `.env` 读取，默认使用 MockBrain。静态 Pages 试玩始终走浏览器本地模拟。

Pages 使用 GitHub Actions 发布 `main` 的静态产物，Vite base 为 `/fatfish-island/`。页面角落的版本和提交短哈希与构建来源对应。
