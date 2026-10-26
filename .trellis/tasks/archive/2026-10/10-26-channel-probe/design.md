# Design：渠道主动健康探测（默认关）

> 需求 prd.md（R1-R6）。锚点已亲核：`channel-testing.ts:139` `fetchChannelModels`
> （逐声明格式 `Promise.allSettled` 探测 + `ChannelTestResult`，伪装模板在探针内
> 解析——直接复用）；wrangler.toml crons 现两条（03:17 维护 + */5 报警）；
> `index.ts` scheduled 已按 `event.cron` 分发（webhook-alerts 建立的模式，加分支
> 即可）；维护链在 `services/usage-stats.ts` `runDailyMaintenance`。

## 1. 数据模型

- 迁移 `0032_channel_probe.sql` + schema.sql：
  ```sql
  ALTER TABLE channels ADD COLUMN probe_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN last_probe_at TEXT;
  CREATE TABLE channel_probes (
    channel_id TEXT NOT NULL, checked_at TEXT NOT NULL,
    status TEXT NOT NULL,          -- healthy|degraded|down
    latency_ms INTEGER, detail TEXT,   -- 逐格式结果 JSON（{format: ok|err}）
    PRIMARY KEY (channel_id, checked_at)
  );
  ```
- settings 键 `probe_interval_minutes`（0-1440，默认 30；**0 = 全局关闭**——即使
  渠道开了探测也不跑，总闸门；两级形态照 settings-config spec）。

## 2. 调度（`services/channel-probe.ts` 新建）

`runChannelProbes(db): Promise<void>`（cron 每 10 分钟 tick 调用）：

1. `probe_interval_minutes = 0` → 直接 return（总闸）；
2. 无 `probe_enabled=1` 渠道（单查询）→ return（默认零行为：全关时每 tick 恰
   1-2 条只读查询）；
3. **到期判定含抖动**（反定时特征，PRD 硬约束）：渠道到期阈值 =
   `last_probe_at < now - (interval - rand(0, min(5, interval/4))) 分钟`——每次
   tick 独立随机，渠道在 interval 到期前 0-5 分钟窗口内的某个 tick 被探测
   （last_probe_at NULL = 从未探测过 → 立即到期）；
4. 到期渠道 `Promise.allSettled` 并发探测（单渠道内复用 `fetchChannelModels`，
   逐声明格式）——并发上限 5（分批，防多渠道同时打上游）；
5. 分类（design 定稿）：全部格式 ok 且耗时 < 5s → `healthy`；部分格式 ok 或
   耗时 ≥ 5s → `degraded`；全部失败 → `down`（"有响应即可达"语义对齐连通性
   测试；detail 存逐格式 `{format: "ok"|"err: msg截断"}`）；
6. 写入：每渠道 1 行 channel_probes + UPDATE channels.last_probe_at（单渠道
   batch 两语句；渠道间独立，单渠道失败不影响其他）。

## 3. 路由隔离（PRD R5 硬约束）

探测链路**零耦合**渠道冷却/路由：不 import `channel-cooldown` / `key-cooldown`
任何函数，不写 usage_logs，不动 `channels` 路由相关字段（除 last_probe_at）。
测试必须断言：探测 down 后 `isChannelCoolingDown(channelId)` 仍为 false。

## 4. cron 接线

- wrangler.toml：`crons = ["17 3 * * *", "*/5 * * * *", "*/10 * * * *"]`；
- index.ts scheduled 加分支（`ALERT_EVALUATION_CRON` 同款常量模式）；
- 保留清理：`runDailyMaintenance` 链尾追加 channel_probes 7 天清理
  （`checked_at < cutoff`，fault-isolated 照既有步骤模式；cutoff 复用
  `retentionCutoffIso` 语义按 7 天算）。

## 5. CRUD + UI

- `routes/channels.ts` POST/PATCH 接 `probe_enabled`（严格布尔归一 0/1；PUT 语义
  与 enabled/status 同类——非三态，缺省保留）；`channel-repo` 若 INSERT/UPDATE
  列清单是显式的需同步（SELECT * 则自动带出）；channels 列表接口自然返回新列。
- `ChannelsView.tsx`：渠道表单加「主动探测」ToggleSwitch（默认关，副文案注明
  「定时 GET /models 连通性探测，零 token 消耗；公益站/中转站请勿开启」）。
- `routes/monitoring.ts` GET 响应增 `probes` 段：每渠道最近 14 条探测（status/
  checked_at/latency_ms）+ 最新一条摘要——单查询
  `WHERE checked_at >= now-7d ORDER BY checked_at DESC`（量小不做窗口函数，
  内存按 channel 分组取前 14）。
- `MonitoringView.tsx`：渠道行加探测色条（14 格，healthy 绿 / degraded 黄 /
  down 红 / 无数据灰）+ 悬停显示时间与延迟；复用既有展开区或 tooltip。

## 6. 测试地图（`tests/channel-probe.test.ts` 新建）

- 默认全关：tick 恰 1-2 条 SELECT、零 INSERT/UPDATE、零 fetch；
- interval=0 总闸：开着的渠道也不探测；
- 到期判定：NULL last_probe_at 立即到期、未到期不探、抖动窗口（注入 rand 或
  多次断言阈值区间）、探测后 last_probe_at 刷新；
- 分类三态与 detail 形状（fetch mock）；
- **路由隔离断言**：down 后渠道冷却状态仍 false；
- 保留清理：7 天前行被删、近期保留；
- channels CRUD：probe_enabled 接线 + 默认 0。
