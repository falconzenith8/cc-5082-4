# arena-draft

服务端权威的双队竞技选角系统：**轮流禁用 → 队内秘密候选 → 到期公开**，裁决结果直接产出可载入比赛场景的正式阵容（`arena-match-scene@1`）。

角色池、互斥关系、可视化资源与情境提交序列全部由**固定种子**确定性生成，同种子可字节级重建；仓库不写死任何选角结果，所有阵容只来自服务端实时裁决。

## 快速开始（新目录从零启动）

```bash
npm ci
npm run build      # 固定种子重建角色池(24人)/SVG 头像/情境文件
npm run verify     # 校验素材哈希、互斥与情境引用（缺失即带路径报错）
npm start          # http://localhost:4317，自动创建一局演示
npm run cold-start # 一键冷启动自检：空目录 → 构建 → 起服 → 打完一局 → 正式阵容
```

完整步骤与界面启动方式见 [STARTUP.md](./STARTUP.md)。

启动日志打印三类入口：观战页 `/spectate/:matchId`、A 队 `/table/:matchId?token=...`、B 队 `/table/:matchId?token=...`。每队两个座位令牌，可同时打开。环境变量：`PORT`、`BAN_MS`、`SECRET_MS`、`AWAY_GRACE_MS`。

## 角色池与互斥关系

- `shared/roster-generator.js`：mulberry32 PRNG + 固定种子（默认 `arena-draft-2026`）生成 24 人池，每种定位 6 人、每阵营 6 人；前 16 人为人工策划基线，后 8 人数值由种子派生。
- **互斥关系**：8 对跨阵营角色不能进入同一支队伍的阵容。互斥是公开元数据（随视图下发 `mutexes`），在三处强制执行：
  1. 秘密意图提交即时拒绝（`mutex-conflict`），界面同步置灰；
  2. 可行性 DFS 与阵容枚举跳过互斥组合；
  3. 裁决后 `validateFinalRosters` 独立复核。
- 可视化资源：`shared/assets.js` 为每名角色生成确定性 SVG 头像，并写带 sha256 的 `manifest.json`。素材缺失、哈希篡改、种子错配、失效角色引用都会抛出带 `code` 与路径/角色 id 的可定位错误。

## 情境演练（脚本选手驱动真实协议）

```bash
npm run scenario                                   # 全部 4 个情境
node scripts/run-scenario.js --scenario exhaustion # 单个情境
```

| 情境 | 覆盖规则关系 |
| --- | --- |
| `rotation` 正常轮换 | 轮换顺序、旧回合守卫、秘密隔离、意图幂等、改选、到期裁决、跨队唯一锁 |
| `exhaustion` 候选耗尽 | 无解阵容 → `failed`，不生成任何锁或场景，场景接口 409 |
| `disconnect` 队员掉线 | 暂离追踪、离线座位意图拒绝、宽限计时、双方离线裁决、默认补位 |
| `unauthorized-peek` 越权反例 | 旁观者/对手令牌/伪造令牌偷看秘密，公共 WS 与 HTTP 载荷零隐藏字段泄漏 |

情境文件（`data/scenarios.json`）每段都附 `instructions` 操作说明与 `expectRules` 规则关系，但**只含操作脚本，不含期望选角结果**；演练器对照服务端实际裁决验证规则是否发生。脚本选手通过真实 WebSocket 座位连接发意图，不是离线函数调用。

## 界面（多人选角内核驱动控件）

- A/B 双方界面可直接禁用、提交/改选秘密候选并锁定；互斥角色置灰，失败原因经 `intent.result/rejected` 回传。
- 顶部「队内视图 / 公共视图」开关：队内视图在预览区显示本队秘密候选，公共视图与旁观者所见一致（无 `secret.own/opponent` 字段），用于核对信息公布时机。
- 裁决后进入正式阵容展示，可一键「送入比赛场景」，由 `public/js/scene-loader.js` 校验 schema 并驱动 canvas 对局。
- 界面启动步骤见 STARTUP.md 第 5 节；仅有脚本不算完成，浏览器 E2E（`npm run test:ui`）覆盖点击禁选、锁定、视图切换与场景载入。

## 协议要点

- **意图带轮次身份**：禁用意图携带 `roundId + turnId`，秘密意图携带 `roundId + windowId`，并带 `intentId` 做幂等。服务端逐项校验阶段、轮次、回合、座位归属、暂离状态、重复投递、角色定位、阵营与互斥后才采用。
- **秘密隔离**：`publicView()` 任何阶段都不含候选角色；座位视图只含本队候选，对手仅暴露「已提交位置数」。公开结果只从同一次 `adjudicate()` 快照产生，不依赖前端隐藏。
- **截止瞬间**：同位置以最新意图为准（改选覆盖），同 `intentId` 重复投递只生效一次；跨座位冲突按最新意图 + 座位号确定性裁决；全体暂离超过宽限提前触发默认裁决。
- **联合约束**：位置接受的角色类型、阵营上限、最少阵营数、互斥关系与剩余池可完成性（DFS）在同一处校验；全局枚举两队互不重叠且不含互斥对的完整阵容。
- **默认策略**：威胁评分产生禁用顺序、适配分产生候选顺序；默认禁用逐个试探，只禁掉不会让两队失去可行阵容的角色。候选耗尽或无解时进入 `failed`，不生成锁或场景。
- **结果来源**：正式阵容每个位置标注 `secret` / `default` / `contested-fallback` / `constraint-fallback`，可直接追溯。

## 测试

```bash
npm test          # 40 个 Node 单元/集成测试
npm run test:ui   # Playwright 浏览器 E2E（需 npx playwright install chromium 及系统库）
```

覆盖：种子确定性、互斥拒绝与复核、资源哈希/缺失/篡改报错、情境结构与反例、候选耗尽、队内冲突/改选、超时默认、暂离裁决、秘密视图隔离、越权令牌降级、跨阵营唯一锁、裁决幂等。

## 目录

```
shared/        角色池生成器、PRNG、资源管线、规则、场景与情境生成器（引擎/前端共享）
server/        MatchRoom 裁决内核与 HTTP/WebSocket 服务
public/        选角界面、场景 canvas、字体与生成的 assets/
scripts/       资源构建/校验、情境演练、冷启动、脚本选手、离线模拟
data/          生成物：roster.json、scenarios.json（可由种子重建）
test/          Node 测试与浏览器 E2E
```
