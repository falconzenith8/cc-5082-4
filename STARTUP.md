# 启动清单（STARTUP）

本清单面向「拿到一个未缓存任何资源的新目录」的操作者。所有产物都能用固定种子重建，
角色池、头像、情境提交序列在同种子下字节级一致；选角结果只来自服务端实时裁决，仓库不写死任何阵容。

## 0. 环境要求

- Node.js 18+（开发验证使用 22.x）
- 浏览器 E2E 另需 Playwright Chromium 与系统库（仅 `npm run test:ui` 需要，协议本身不依赖浏览器）

## 1. 安装依赖

```bash
npm ci        # 或 npm install
```

## 2. 固定种子重建资源（角色池 / 头像 / 情境）

```bash
npm run build
# 等价于 node scripts/build-resources.js
# 可选：--seed <种子> --out <public 目录>
```

产物（均为生成物，可随时删除后重建）：

- `public/assets/portraits/*.svg`：每名角色一张确定性头像
- `public/assets/manifest.json`：素材路径 + sha256 清单
- `data/roster.json`：24 人角色池（定位、四维、阵营、互斥关系、头像路径）
- `data/scenarios.json`：4 个情境的操作脚本与规则关系（不含任何期望选角结果）

## 3. 资源校验（缺失素材 / 失效引用会带路径报错并以非零码退出）

```bash
npm run verify
# 等价于 node scripts/verify-resources.js
```

校验内容：角色池结构与互斥引用、素材文件存在性、哈希一致性、孤儿素材、情境角色引用、种子一致性。

## 4. 启动多人选角服务

```bash
npm start
# 默认 http://localhost:4317，启动日志打印三类入口：
#   旁观页  /spectate/<matchId>
#   A 队座位 /table/<matchId>?token=<座位令牌>
#   B 队座位 /table/<matchId>?token=<座位令牌>
```

环境变量：`PORT`、`BAN_MS`、`SECRET_MS`、`AWAY_GRACE_MS`。

## 5. 界面怎么启动（多人选角不是只有脚本）

1. `npm start` 后打开启动日志里的 A 队链接和 B 队链接（各含两个座位令牌，可开四个标签页）。
2. 再打开旁观链接，得到公共视图。
3. 在 A、B 两个队伍界面直接操作：
   - 禁用阶段：轮到本队时点击角色池中的角色即提交禁用意图，由服务端裁决是否采用。
   - 秘密阶段：点选角色后在对应阵容位点「提交已选角色」；可改选、可看推荐候选。
   - 互斥角色在角色池中自动置灰（服务端也会以 `mutex-conflict` 拒绝）。
4. 顶部「队内视图 / 公共视图」开关可随时切换：
   - 队内视图：预览区显示本队秘密候选；对手只显示已提交位置数。
   - 公共视图：与旁观者所见完全一致，不含任何 `secret.own/opponent` 候选字段。
5. 截止后服务端一次性裁决，双方界面与旁观页同时进入「正式阵容」展示，并可点「送入比赛场景」载入 canvas 对局界面。
6. 所有控件均由多人选角内核（WebSocket 协议 + 服务端 `MatchRoom`）驱动；意图被拒时失败信息经 `intent.result/rejected` 回传到发起的座位界面。

## 6. 脚本选手驱动真实协议

```bash
# 服务器已启动时：脚本选手以真实 WebSocket 座位身份自建或加入对局
BASE_URL=http://localhost:4317 npm run bots
# 离线进程内模拟（不联网，仍走同一引擎裁决）
npm run sim
```

## 7. 情境演练（正常轮换 / 候选耗尽 / 队员掉线 / 越权反例）

```bash
npm run scenario                 # 跑全部 4 个情境
node scripts/run-scenario.js --scenario exhaustion      # 只跑一个
```

每个情境目录条目（`data/scenarios.json`）都带：

- `instructions`：逐步操作说明
- `expectRules`：希望触发/验证的规则关系
- `script`：脚本选手要发送的真实协议意图序列

情境文件**不预填期望阵容**；演练器只对照服务端实际裁决产出校验规则是否发生。
`unauthorized-peek` 是故意越权的反例：旁观者、对手令牌、伪造令牌三类身份尝试读取秘密，
断言公共 WS 与 HTTP 载荷在裁决前都不含隐藏候选 id。

## 8. 测试

```bash
npm test            # 40 个 Node 单元/集成测试（引擎、规则、资源、情境、HTTP/WS、越权反例）
npm run test:ui     # Playwright 浏览器 E2E（需先安装浏览器：npx playwright install chromium 及系统库）
```

## 9. 冷启动自检（新目录从零到正式阵容）

```bash
npm run cold-start
```

该脚本把源文件拷到一个临时空目录（排除 `node_modules` 与所有生成物），依次执行
依赖安装 → 种子重建 → 资源校验 → 起服务 → 真实 WebSocket 打完一局 → 校验正式阵容、场景与头像可访问。

## 10. 固定种子与可定位错误

- 默认种子 `arena-draft-2026`（见 `shared/roster-generator.js`），同种子重建的角色池与提交序列完全一致。
- 失效角色引用、互斥指向不存在角色、素材缺失/哈希不符、种子错配，都会抛出带 `code` 与具体路径/角色 id 的错误，
  不会静默降级或用写死结果顶替。
