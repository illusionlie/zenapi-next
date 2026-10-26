# Design：Webhook 出站通知与故障报警

> 需求 prd.md（R1-R6）。锚点已亲核：wrangler.toml `[triggers]` 单条 `17 3 * * *`
> （:10-11）、`index.ts:221-233` scheduled 直通 `runDailyMaintenance`、usage_logs 有
> `status`（'success'/'error'）+ `error_code` 列（schema :77-78）。

## 0. 相对 PRD 的两处裁定（偏离已记录）

1. **「渠道进入冷却事件」报警开关不做**：冷却触发在请求热路径，事件式推送需在
   `recordChannelFailure` 处 fire-and-forget 发网——拖热路径且跨 isolate 语义混乱。
   5 分钟周期评估的失败率报警已覆盖同一场景（渠道坏了失败率必然先超标）。PRD R3
   的该子项裁撤。
2. **静默窗口用 settings 时间戳而非纯内存**：isolate 内存跨实例不共享会重复报警；
   评估周期 5 分钟（非每请求），每渠道每静默期至多一次 settings 写——量可控且跨
   isolate 一致。键 `alert_state:{channelId}` JSON `{lastAlertAt, lastRecoverAt}`。

## 1. 数据模型

- 迁移 `0031_webhooks.sql` + schema.sql：
  ```sql
  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    type TEXT NOT NULL,            -- feishu|wecom|dingtalk|slack|generic
    url TEXT NOT NULL,             -- 机器人 webhook 地址（含 token，管理员域可见）
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  ```
- settings 新键（全部读宽写严，数值 clamp 照 settings-config spec 两级形态）：
  - `alert_failure_rate_pct`（0-100，默认 50，0 = 关闭报警）
  - `alert_min_samples`（0-10000，默认 5）
  - `alert_silence_minutes`（1-1440，默认 30）
  - `alert_window_minutes`（5-120，默认 15，评估窗口）
  - `daily_report_enabled`（严格布尔 "true"/"false"，默认 "false"）

## 2. 评估器 `services/alerts.ts`

`evaluateAlerts(db): Promise<void>`（cron 每 5 分钟调用）：

1. 读 enabled webhooks（空表直接 return——默认零行为）+ 五个 settings；
2. 单查询近 `alert_window_minutes` 窗口聚合：
   `SELECT channel_id, COUNT(*) total, SUM(status='error') errors FROM usage_logs
   WHERE created_at >= ? AND channel_id IS NOT NULL GROUP BY channel_id`；
3. 逐渠道判定：`errors/total*100 >= threshold && total >= min_samples` → 候选报警；
4. 静默判定：`alert_state:{id}` 存在且 `now - lastAlertAt < silence` → 跳过；
   **恢复通知**：`lastAlertAt` 存在且当前失败率 < threshold/2（滞后带防抖）→ 发
   「已恢复」+ 清 `lastAlertAt`（保留 lastRecoverAt 供展示）；
5. 触发 → 构造 `AlertMessage{title, lines[], severity, ts}` → 全部 enabled
   webhooks `Promise.allSettled` 并发发送（单个失败仅 console.warn `[alerts]`，
   无重试队列）→ 写 `alert_state:{id}`（报警与恢复都刷新）；
6. 阈值关闭（threshold=0）时若有未恢复状态 → 顺带清状态（设置关闭不残留）。

## 3. 发送适配器 `services/webhook-senders.ts`

`sendWebhook(type, url, message): Promise<{ok, status?}>` 纯函数（10s AbortSignal
超时）：

| type | payload 形状 |
|------|--------------|
| feishu | `{"msg_type":"text","content":{"text":…}}` |
| wecom | `{"msgtype":"text","text":{"content":…}}` |
| dingtalk | `{"msgtype":"text","text":{"content":…}}`（v1 不做加签） |
| slack | `{"text":…}` |
| generic | message 对象原样 POST |

message 文本渲染统一 `formatMessage(message): string`（标题 + 逐行 + 时间戳），
generic 才用结构化对象。未知 type → 不发送（fail-open + warn）。

## 4. 日报（并入 03:17 链尾）

`runDailyMaintenance` 尾部追加 `maybeSendDailyReport(db)`：`daily_report_enabled`
严格布尔（照 normalize_developer_role 两级读取链）关则零开销 return；开则聚合昨日
`usage_stats_daily`（全站 requests/tokens/cost 合计 + top 5 渠道/模型）→
AlertMessage 形态（type='daily_report'）→ 全 webhook 推送。失败不影响维护链
（fault-isolated 照既有步骤模式）。

## 5. cron 接线

- wrangler.toml：`crons = ["17 3 * * *", "*/5 * * * *"]`；
- `index.ts` scheduled 按 `_event.cron` 分发：`"*/5 * * * *"` → `evaluateAlerts`，
  其余 → `runDailyMaintenance`（+ 日报在 maintenance 链尾）。

## 6. CRUD 路由 `/api/webhooks`（adminAuth，不进放行清单）

`routes/webhooks.ts`：GET 列表 / POST 创建（type 白名单 + url https 校验）/ PATCH
（name/type/url/enabled）/ DELETE / `POST /test`（body 可带未保存的 type+url，
构造样例 AlertMessage 真实发送，返回各适配器结果）。UI：SettingsView「通知与报警」
卡片——webhook 列表（类型徽标 + 启用开关 + 测试/删除）+ 添加表单 + 五个 settings
数值/开关字段（照既有卡片模式）。

## 7. 测试地图（`tests/webhook-alerts.test.ts` 新建）

- 适配器 payload 形状 ×5（fetch mock 断言 URL/body）+ 未知 type fail-open；
- 评估器：失败率达标触发且五 webhook 全收到（allSettled）、静默期内不重发、
  恢复通知滞后带（threshold/2）、样本不足不触发、threshold=0 清状态零发送、
  无 webhook 零查询；
- settings 解析：五键 clamp / 脏值降默认 / 布尔严格解析；
- cron 分发：`*/5` 走评估器、03:17 走维护链（mock 断言互不误调）；
- 日报：开关关零开销、开则昨日聚合推送形状。
- 存量维护链测试零回归（03:17 语义不变）。
