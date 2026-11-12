# arena-draft

服务端权威的双队竞技选角协议：**轮流禁用 → 队内秘密候选 → 到期公开**，裁决结果直接产出可载入比赛场景的正式阵容（`arena-match-scene@1`）。

## 运行

```bash
npm install
npm start          # http://localhost:4317，自动创建一局演示
```

启动日志会打印三个入口：观战页 `/spectate/:matchId`、A 队 `/table/:matchId?token=...`、B 队 `/table/:matchId?token=...`。每队两个座位令牌，可同时打开。

环境变量：`PORT`、`BAN_MS`、`SECRET_MS`、`AWAY_GRACE_MS`。

## 脚本选手

服务器启动后，脚本选手可以自建对局，也可以加入已有对局：

```bash
BASE_URL=http://localhost:4317 node scripts/bot-client.js
# 或加入已有对局：
BASE_URL=http://localhost:4317 node scripts/bot-client.js <matchId> <tokenA0> <tokenB0>
```

脚本选手以真实 WebSocket 座位身份提交禁用/秘密意图，等到裁决后打印两队正式阵容与场景地址。

离线无浏览器模拟（含默认策略、约束校验、场景生成）：

```bash
npm run sim
npm run sim -- --json
npm run sim -- --rules '{"banTurnsPerTeam":0,"factionCap":1,"slotPlan":["vanguard","support","flex","flex2"]}'
```

## 协议要点

- **意图带轮次身份**：禁用意图携带 `roundId + turnId`，秘密意图携带 `roundId + windowId`，并带 `intentId` 做幂等。服务端逐项校验阶段、轮次、回合、座位归属、暂离状态、重复投递后，才决定是否采用。
- **秘密隔离**：`publicView()` 在任何阶段都不含候选角色；座位视图只含本队候选，对手仅暴露「已提交位置数」。公开结果只从同一次 `adjudicate()` 的快照产生，不依赖前端隐藏。
- **截止瞬间**：同一座位同一位置以最新意图为准（改选可覆盖），同 `intentId` 重复投递只生效一次；跨座位冲突按最新意图 + 座位号确定性裁决；全体暂离超过宽限后提前触发默认裁决。
- **联合约束**：位置接受的角色类型、阵营上限、最少阵营数，以及剩余池可完成性（DFS 可行性）在同一处校验；全局再枚举两队互不重叠的完整阵容，保证一个角色不会被多个阵营同时锁定。
- **默认策略**：从威胁评分产生禁用顺序，从适配分产生候选顺序；默认禁用会逐个试探，只禁掉不会让两队失去互斥阵容的角色。裁决时枚举全局阵容，优先保留秘密候选，再按默认策略补位，最后独立复核约束。候选耗尽或不存在互斥阵容时进入 `failed`，不生成锁或场景。
- **结果来源**：正式阵容每个位置标注 `secret`（秘密采用）、`default`（默认补位）、`contested-fallback`（跨队争抢回退）或 `constraint-fallback`（约束回退），可直接追溯。

## 测试

```bash
npm test            # 24 个单元/集成测试（引擎、规则配置、HTTP/WebSocket）
npm run test:ui     # Playwright 浏览器端到端（自起 4321 端口服务器；需先安装浏览器与系统库）
```

覆盖：候选耗尽、队内冲突/改选、队内重复、超时默认选择、默认禁用仍保留可行池、迟到旧轮次/旧回合、重复投递、暂离与双方离线裁决、秘密视图隔离、跨阵营唯一锁、默认策略约束、裁决幂等与确定性。

## 场景

`GET /api/matches/:id/scene` 在裁决前返回 409 `match-not-revealed`，裁决后返回 `arena-match-scene@1`：区块尺寸、目标点、双方单位（槽位、出生点、角色属性）、禁用与争抢记录。前端 `public/js/scene-loader.js` 直接校验并驱动 canvas 运行，不依赖任何静态展示卡片。
