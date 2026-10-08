# 自有 fork 定制设计（2026-10-08）

仓库：`zhuifengqug/dsh-agent-teams-router`（fork 自 `NanmiCoder/dsh-agent-teams` v0.1.22）
分支：`fork/v0.1.22-router`；起点 `4346733`（已并入上游 4 个 bug 修复）

---

## 0. 总目标与边界

| 项 | 内容 |
| --- | --- |
| A | 接入 `@michengai/dsh-agency-agents`，**用已有的专家团当成员阵容**，不再重复写 `profiles` |
| B | 把已落盘的 `routeAudit[]` 显示到 ActivityPanel：看得见"为什么这个成员用了这个模型" |
| C | ① 团队级成本汇总 ② 显式难度评分卡（**留空派发能成立的前提**） |
| D | UI 改动（待用户确认具体诉求） |

**硬约束（用户既定）**
- 成员模型**留空**，交给 `dsh-value-router` 四档派发。
- 成员 provider/model/reasoning_effort 在创建时冻结写入 `team.json`，运行中不换。
- 源码在 `src/`，产物在 `lib/`；改 `src/` 必须重建。
- 不做破坏性变更；与上游保持可合并（新功能尽量走"可选桥接"而非改上游既有路径）。

**非目标**
- 不改上游既有工具语义；不动 `agent_teams_*` 的 14 个稳定工具名。
- 不改包名（只改 metadata 归属字段）。
- 不实现"运行中动态换模型"。

---

## A · 接入 agency-agents

### A.1 已核实的事实（实读 `@michengai/dsh-agency-agents@1.0.11`）

包通过 `ctx.reflect.provide` 注册 4 个服务（`lib/src-Cqu41I1d.js`）：

| 服务名 | provide 位置 | 内容 |
| --- | --- | --- |
| `agencyAgentsTeams` | L3176 | `teamLibrary = createTeamLibrary(() => library.catalog(), {read, revision, mutate}, …)` |
| `agencyAgentsTeamEngine` | L3177 | `resolveTeamEngine(ctx, void 0, maxDepth).status` → `{state: enabled\|unsupported\|disabled, mode: subagent\|native, reason, recommendation}` |
| `agencyAgentsLibrary` | L3223 | `library = createExpertLibrary(async () => [...experts], {…}, divisions, locale)` |
| `agencyAgentsPersona` | L3224 | `personaSource = createAgencyPersonaSource(...)` → `{ async getPrompt(slug, division, locale) }` |

另有 Host Remote 服务 `AgencyAgentsRemote extends TypertRemoteService`（`lib/remote.d.ts`），方法：`getTeams()` / `getCatalog()` / `getPrompt(slug, division)` / `getCustomExpert(slug)` / `getEnabled()` / `saveTeam()` / `saveCustomExpert()` / `setTeamEnabled()` / `deleteTeam()` / `setEnabled()`。**这些是给客户端用的**，Host 侧集成应走上面 4 个 `reflect.provide` 服务。

数据结构（`remote.d.ts`）：
- `TeamInput` = `{id?, builtin?, name, description, tags[], goal, constraints, deliveryRequirements, members[{expertSlug, duty, instructions}], examples[], coordinatorMode: 'custom'|'template', coordinatorTemplateId, coordinatorTemplateVersion: 1, coordinatorPrompt}`
- `CatalogSnapshot.experts[]` = `{slug, name, nameEn, description, descriptionEn, emoji, division, divisionZh, conflict?, custom, avatar?}`
- 插件 Config = `{root, provider (默认 spawn), divisions[], maxDepth?}`

**结论：agency-agents 的 team 成员是"角色 + 职责 + 指令"，不是完整 persona 正文；persona 正文要按需用 `getPrompt(slug, division)` 拉。** 这正好对上 AgentTeams 的 `executionPrompt`。

### A.2 设计

**注入方式**：可选桥接（与 `dsh-value-router` 既有模式一致）。

```ts
// src/agency-bridge.ts（新文件）
inject: ['agencyAgentsTeams', 'agencyAgentsLibrary', 'agencyAgentsPersona']  // 三者皆可选
```

用 `ctx.get(name)` 探测；**任一缺失即整体回落**，`available: false`，AgentTeams 行为完全不变。

**成员装配**：
1. `agencyAgentsTeams` 取到指定团队（按 id 或 name 匹配）
2. 对每个 `member.expertSlug`，从 `agencyAgentsLibrary` 的 catalog 查 `division`
3. `agencyAgentsPersona.getPrompt(slug, division, locale)` 取 persona 正文
4. 合成成员 `executionPrompt`：

   ```
   <persona 正文>

   ## 本次职责
   <duty>

   ## 补充指令
   <instructions>
   ```

5. 成员 `name` = expert 的 `slug`（保证 lower-kebab-case，符合 `memberName()` 校验）
6. **`provider` / `model` / `reasoning_effort` 全部留空** → 走 value-router 四档

**调用入口**（两种，二选一或都做）：
- `/agent-teams --agency <teamId|teamName> <目标>`
- `agent_teams_create({ agencyTeam: '<id|name>', approval: 'required' })`

> 不选"映射成 profiles 配置"的方案：那需要把 321 个专家的 prompt 抄进 config，正是用户要避免的"重复写 profile"。

**缓存与预算**：persona 正文按需读、只在建团时读该团那几个成员，不预加载全量（agency-agents 自己的注释也强调"不预加载任何专家提示词正文"）。单成员 persona 长度需设上限并在超限时截断+记审计。

**冲突与优先级**（需在实现时明确并写入文档）：
`agencyTeam` 与 `profile` 同时给出 → 报错，不做隐式二选一。二者都不给 → 现有行为（captain 自组队）。

### A.3 回落与失败

| 情况 | 行为 |
| --- | --- |
| 三个服务任一缺失 | `available: false`，`agencyTeam` 参数被拒并给出原因；现有路径不受影响 |
| teamId 不存在 | 明确报错，列出可用 team id（不静默回落） |
| expert 无 persona | 用 `duty + instructions` 兜底，并在成员 diagnostics 标注 |
| persona 超长 | 截断到上限，记 `routeAudit`/diagnostics |

### A.4 验收

- agency-agents 在场：`/agent-teams --agency <用户的自定义团> 目标` 能建出正确阵容，成员 `executionPrompt` 含 persona 正文，`team.json` 里成员无写死模型。
- agency-agents 移除/服务未注册：功能完全回落，`pnpm verify` 全绿，无异常日志。
- 单测：桥接层纯函数化（给 fake 的 teams/library/persona 三个 stub），覆盖"服务缺失 / team 不存在 / persona 缺失 / persona 超长"。

---

## B · 路由决策可见

### B.1 现状
`routeAudit[]` 已按任务落盘，但**没有任何出口**：用户只能翻 `.agent-teams/<teamId>/team.json`。

### B.2 设计
1. **数据投影**：把任务的 `routeAudit` 汇进 client 可见的 snapshot/事件流（与现有 member/task 投影同一通道，不新开通道）。
2. **UI**：
   - 任务卡上显示难度徽章（`low/medium/high/max`）+ 最终线路（`provider/model@effort`）
   - 悬停/展开 popover：按 sequence 列出 audit steps（`validate` → `user-route`/`captain-route`/`route-rejected`/`tier-rotate`/`same-tier-substitute`/`tier-degrade`/`fallback`/`pending`），每步带 `status` 与 `detail`
   - 降级/兜底用不同色重（`tier-degrade` 黄、`fallback` 橙、`blocked` 红）
3. **成员视角**：成员行显示其 `routeKey` 拆解（difficulty / role / provider / model / effort 五段）。

### B.3 验收
- 造一个"高难度任务命中降级"的场景，面板能如实显示降级链路。
- 造一个"全局兜底"场景，能显示 `fallback` 步骤。
- 造一个 pending（catalog 不可用）场景，显示 `pending` 而非假装有线路。

---

## C · 成本汇总 + 难度评分卡

### C.1 团队级成本汇总
**问题**：每个成员是**独立会话**（`startContinuable` 创建），`dsh-cost-meter` 按会话算，面板上看不到"这个团一共花了多少、谁最贵"。

**设计**：
- 优先复用宿主已有的 usage/成本来源（不自己重算 token）——实现前先确认 `dsh-cost-meter` 是否 `provide` 了可注入服务；有则注入，无则从 session usage 读取。
- 汇总粒度：团队合计 + 成员分列（输入/输出/缓存命中/估算费用）。
- 展示在 ActivityPanel 的花名册列（可排序），并在面板标题显示团队合计。

**风险**：跨版本 usage 字段不稳定 → 用"能读到就显示、读不到就显示 —"的降级策略，绝不编造数字。

### C.2 显式难度评分卡（**关键**）
**问题（已核实）**：`agent_teams_create_task` 有 `difficulty` 参数，但 `usageSectionText()`（`src/index.ts` L139-150，10 条协议）**一次都没提 `difficulty` 是什么、什么算 high**。四档派发的输入端因此全凭队长感觉。

用户已决定"留空派发" ⇒ **没有评分卡，留空派发就是随机派发**。所以 C.2 是 A 的前置条件。

**设计**：在 `usageSectionText` 里加一段显式判据（并在 `agent_teams_create_task` / `edit_plan` 的 `difficulty` 参数 description 里给一行摘要）：

| 档 | 判据（收敛条件，非任务类型） | 典型 |
| --- | --- | --- |
| `low` | 单文件、无判断、机械执行；错了立刻可见 | 改文案、加字段、跑命令取结果、格式化 |
| `medium` | 单模块、有明确验收、需读现有代码 | 加工具参数、补一个测试、改一处 UI 文案逻辑 |
| `high` | 跨模块/跨文件契约、要权衡、有回归风险 | 改服务接口、重构数据流、写质量门 |
| `max` | 架构级、公开契约/持久化/兼容边界、不可逆 | 改协议、改 schema、删旧路径、发布 |

外加两条硬规则：
- **不确定就报高不报低**（降级是允许的、升档是禁止的——与 value-router "只降不升"一致）
- **档位是任务属性，不是成员属性**；同一成员可接不同档任务（`memberReuseKey` 会按档拆槽位）

### C.3 验收
- 同一目标跑两次，队长给出的难度分布稳定（不出现同任务一次 low 一次 max）。
- 评分卡文本不吞掉原 10 条协议的语义（回归：`usageSectionText` 单测）。

---

## D · UI 改动（待用户定）

已观察到的现有 UI：ActivityPanel（分段进度 + 可折叠花名册 + 交互式任务 DAG）、StagingPlanEditor、会话卡、中英实时切换。

**候选（等用户挑选/补充）**：
1. 路由徽章与 audit popover（= B）
2. 成员成本列与团队合计（= C.1）
3. 任务卡显示难度档 + 角色标签
4. 建团时按 agency 团队选择（= A 的可视化入口，替代敲 `/agent-teams --agency`）
5. 面板标题区显示"当前生效的 value-router 档位摘要"

> **需要用户明确**：具体想改哪里（花名册？任务板？建团流程？配色密度？）。

---

## 实施顺序（按依赖，每步独立可验证）

| 步 | 内容 | 依赖 | 验证 |
| --- | --- | --- | --- |
| 1 | ✅ 合上游 4 个 bug 修复 | — | 已完成（`4346733`） |
| 2 | metadata 归属（homepage/repository/bugs + contributors） | — | `pnpm verify:release` |
| 3 | **C.2 难度评分卡**（A 的前置） | — | `usageSectionText` 单测 |
| 4 | **A** agency-agents 桥接（含回落） | 3 | 桥接单测 + 服务缺失回归 |
| 5 | **B** routeAudit 投影 + 面板 | — | 三个场景验收 |
| 6 | **C.1** 成本汇总 | — | 读数正确性 + 降级显示 |
| 7 | **D** UI（待定） | 5,6 | 浏览器验收 |
| 8 | 填充 `max` 档配置（profile 侧，非本仓库） | — | 面板确认 |

**提交切分**：一步一提交，Conventional Commits，中文正文；每笔提交前跑 `pnpm build` + `pnpm typecheck` + 相关测试。

---

## 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| agency-agents 服务名/形状随版本变 | A 失效 | 只依赖服务名 + 最小方法集；缺方法即回落；把核实过的版本写进注释 |
| 上游 `usageSectionText` 改动导致冲突 | C.2 rebase 冲突 | 评分卡尽量独立成一段追加，不改动原 10 条 |
| 成本字段跨宿主版本不稳 | C.1 显示错误数字 | 读不到就显示 `—`，不估算 |
| 与上游分叉加深 | 每次上游发版 rebase 变痛 | 新功能独立成文件（如 `agency-bridge.ts`），少改上游既有文件 |
| `max` 档为空 | 留空派发后 max 任务降到 high | 步 8 填档（profile 侧） |
