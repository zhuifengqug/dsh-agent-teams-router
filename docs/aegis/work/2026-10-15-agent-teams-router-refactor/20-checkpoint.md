# 续作检查点

tag: type:progress

## 当前状态
- 已完成：前三项改造在 `002b987`、`07797b3`、`bb06a9b` 提交；#203 客户端卡片身份修复已实现并构建。
- 当前切片八项全部实现完成，工作树待本地提交；基线 `fork/v0.1.22-router`，初始 HEAD `bb06a9b072d48b7842c995cd694eeaba99044e81`，初始干净、ahead 4，不推送。
- #188 以共享 finding 行号谓词写读一致，数字哨兵按数值类型自愈，错误类型仍保留并诊断；#189 加 `memberLlmProvider`，显式队员线路优先、默认模型按目录唯一归属；#205 记录已结算终轮失败，不改终态 task，旧错误被新任务取代时忽略。
- #174/#183 官方补丁已按上游提交 `648fd9a2` 移植：`src/artifacts.ts` 是唯一工作区字节读取者，`src/workspace-audit.ts` 是 status/面板/交付共用审计 owner，`src/quality-gates.ts` 保持纯函数并接收 `DeliveryAudit`。
- #161 verdict 与 revision 绑定：claim 存 `verdictStartSnapshot`，close 记录 `reviewedAttempt/reviewedArtifacts/reviewedGaps/reviewedScope`，换代或字节变化即阻断交付并显示过期标记。
- #175A/#175B：repair 记录 `findingSourceTaskIds` 因果边（不可为 `dependencies`，失败 gate 永不解锁下游），失败 verification 自动生成修复 + 重验轮且保留原失败命令。
- 专家最终规则已落地：`agent_teams_experts` 列完整目录含 enabled；建队员时按任务挑一次有效专家并冻结；缺失/停用/无 persona 静默落为普通队员；成员行、状态渲染与暂存名单简短显示绑定专家。
- 关于 #176/#160：前者为本 fork 不支持的 lead inheritance，后者要求改写既有 session 日志，均超出批准范围，不移植。
- 独立只读审查（子代理）复现的 11 类反例全部修复并加入回归：血缘在 implementation 终止、unbound 候选禁 supersede、缺审计阻断、证据覆盖检查、独立 checker 升级、mixed 排除 finding 整条升级、逐 scope 审计避免全局 cap、符号链接显式 gap、失败 gate 精确因果键、跨血缘同名 finding 不闭环、verification 命令并集。

## 验证证据
- `pnpm typecheck`、`pnpm build`、`pnpm verify` 全部通过（exit 0）；`pnpm verify` 各套件 fail 全为 0，仅 4 项 Windows 平台能力跳过（POSIX 权限探针 2、文件符号链接 1、chmod 1）。
- 关键套件：quality-gates 85、质量门禁 surface 15、agency-bridge 29、capabilities 18、member-failure 15、member-experts 3、composition-smoke 5、usage/workspace-activity/route-details 13。
- 日志留档：`evidence/typecheck.log`、`evidence/build.log`、`evidence/verify.log`。

## 下一步
1. 本地 Conventional Commit（不推送）。
2. 用户侧重启 DSH Desktop 后做活体验收：专家清单可见、成员行显示专家、verdict 过期标记。

## 漂移决定
continue。仅使用当前宿主依赖闭包做静态构建与离线回归，未声称另一运行环境的真实模型验收；未执行 `git fetch`/`git pull`/推送/宿主重启，未改动 desktop profile、`dsh.client.inject` 或 `link:` 结构。
