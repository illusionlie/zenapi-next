-- 0027: 渠道服务端客户端预设（disguise_preset）
-- 值为 services/client-presets.ts CLIENT_PRESET_IDS 白名单内的预设 ID；
--   NULL/空 = 不启用（零回归基线）。预设本体是代码常量而非配置——上游指纹
--   随客户端版本漂移，列只存指针，指纹数据（头表 / 版本号 / 工具集）随代码
--   发版刷新。
-- 回填：无——存量渠道 NULL 即「预设关闭」，行为与迁移前逐字节一致。
ALTER TABLE channels ADD COLUMN disguise_preset TEXT;
