# 管理员 2FA 设计评估

## Goal

管理员账户目前仅密码 + session（密码哈希存 `settings` 表，会话存 `admin_sessions`），无任何第二因子。管理员握有全部渠道明文 api_key、支付网关密钥（`ldc_epay_key`）、备份导入（全量替换式）等高危面，密码泄露即全站沦陷。对照 New API 已有 TOTP + 备份码 + Passkey。

**本任务交付物是评估报告，不写任何业务代码。** 用户看完报告决定是否立项实施；实施另开子任务挂批次父任务（`10-28-cpa-newapi-adoption-batch`）下。

## 评估问题（报告必须逐项回答）

- **Q1 范围**：仅管理员（`/api/auth`）还是同时覆盖用户端（`/api/u/auth`）可选开启？LinuxDO OAuth 登录是否也走 2FA（OAuth 自带第一因子，二次 TOTP 是加保险还是冗余）——给建议。
- **Q2 库选型**：TOTP（RFC 6238）实现——npm 库（如 `otpauth`）在 Workers 的兼容性（无 Node crypto，需 WebCrypto HMAC-SHA1）vs 手写约百行；QR 码方案（后端出 provisioning URI `otpauth://totp/...`、前端渲染）。
- **Q3 存储与迁移**：secret 与备份码哈希存哪（settings 键 vs 新列/新表——管理员单账户背景下 settings 键可能已够）；迁移文件与 schema.sql 同步义务。
- **Q4 登录流改造**：两步式（密码通过 → 2FA 挑战态 → 提交 6 位码 → 发 session）vs 单步式（密码 + 码同请求）；对管理台 UI 与现有脚本化调用的影响面——**`x-admin-token` 等直连鉴权路径不动**（2FA 只保护登录态的获取，不碰已发 session 的校验）。
- **Q5 恢复路径**：备份码数量 / 单次有效 / 哈希存储；丢失 secret 的重置流程（留管理端点还是 DB 手工操作——安全权衡给建议）。
- **Q6 强制策略**：默认可选开启 or 强制；要不要 `TURNSTILE_DISABLED` 式紧急逃生开关。
- **Q7 工作量估算**：人日级 + 任务拆分 + 回滚形状（禁用开关回退即恢复单因子登录）。

## Acceptance Criteria

- [ ] 报告落盘本任务 `research/`，逐项回答 Q1–Q7，含明确推荐方案。
- [ ] 用户拍板前不修改任何业务代码。

## 非目标

- 不评估 Passkey/WebAuthn（报告里一句话说明为何不选即可：注册/恢复流 UI 成本远超 TOTP）。
- 不保护 tokenAuth API 令牌路径（API 令牌是机器凭证，不是人的登录态）。
