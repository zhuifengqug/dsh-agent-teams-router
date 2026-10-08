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
| D | UI 改动（设计语言参照 `dsh-claude-style`，规格已定稿见 D 段；B/C 展示并入步 7 一次落地） |

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
// ⚠ 模块级 inject 是硬依赖（服务不齐、插件整体不激活），绝不用它声明可选服务。
// 照 src/router.ts 的 valueRouterOf() 既定模式，在调用时以 ctx.get() 探测：
export function agencyServicesOf(ctx: { get(key: never): unknown }) {
  const teams = ctx.get('agencyAgentsTeams')      // undefined 即缺席
  const library = ctx.get('agencyAgentsLibrary')
  const persona = ctx.get('agencyAgentsPersona')
  if (teams === undefined || library === undefined || persona === undefined) {
    return { available: false }                    // 任一缺失即整体回落
  }
  // …最小方法集校验通过后返回可用句柄
}
```

用 `ctx.get(name)` 探测；**任一缺失即整体回落**，`available: false`，AgentTeams 行为完全不变。`export const inject` 数组保持不动。（2026-10-08 评审修正：原稿 `inject: ['agencyAgentsTeams', …]` 示例照字面落地会让 agency-agents 缺席时本插件不激活，与回落目标相反。）

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

5. 成员 `name` = expert 的 `slug`（保证 lower-kebab-case，符合 `memberName()` 校验）；**同一 slug 重复出现时加 `-2`/`-3` 后缀并在 diagnostics 标注原名**（persona 按 slug 拉取，不受改名影响）
6. **`provider` / `model` / `reasoning_effort` 全部留空** → 走 value-router 四档
7. **阵容超过 `maxMembers`：明确报错并提示调整 config，不静默截断**
8. locale 取客户端 locale，读不到用 `zh`；persona 上限 **8000 字符**

**主理人字段（2026-10-08 评审裁决）**：agency 团队的 `coordinatorPrompt` / `constraints` / `deliveryRequirements` 在 `agent_teams_create` 的**响应里回显给队长会话采纳执行**（不改提示词管线）；`goal` 并入团队 `description`。忽略这组字段等于丢掉专家团协调规则的一半价值（`summon_expert_team` 即「先读主理人规则再委派」的范式）。

**调用入口**（两种，二选一或都做）：
- `/agent-teams --agency <teamId|teamName> <目标>`
- `agent_teams_create({ agencyTeam: '<id|name>', approval: 'required' })`

> 不选"映射成 profiles 配置"的方案：那需要把 321 个专家的 prompt 抄进 config，正是用户要避免的"重复写 profile"。

**缓存与预算**：persona 正文按需读、只在建团时读该团那几个成员，不预加载全量（agency-agents 自己的注释也强调"不预加载任何专家提示词正文"）。单成员 persona 上限 **8000 字符**，超限截断+记 diagnostics/`routeAudit`。

**冲突与优先级（2026-10-08 定稿）**：
- `agencyTeam` × `profile` → 报错，不做隐式二选一
- `agencyTeam` × `plan.members` → 报错（阵容由 agency 团队供给）
- `agencyTeam` × `plan.tasks` → 允许（任务图与阵容正交）
- 都不给 → 现有行为（captain 自组队）

### A.3 回落与失败

| 情况 | 行为 |
| --- | --- |
| 三个服务任一缺失 | `available: false`，`agencyTeam` 参数被拒并给出原因；现有路径不受影响 |
| teamId 不存在 | 明确报错，列出可用 team id（不静默回落） |
| expert 无 persona | 用 `duty + instructions` 兜底，并在成员 diagnostics 标注 |
| persona 超长 | 截断到 8000 字符上限，记 diagnostics/`routeAudit` |
| 同一 expertSlug 重复 | 成员名加 `-2` 后缀，diagnostics 标注原名 |
| 阵容超 maxMembers | 明确报错并提示调整 config，不静默截断 |

### A.4 验收

- agency-agents 在场：`/agent-teams --agency <用户的自定义团> 目标` 能建出正确阵容，成员 `executionPrompt` 含 persona 正文，`team.json` 里成员无写死模型；create 响应回显主理人字段。
- agency-agents 移除/服务未注册：功能完全回落，`pnpm verify` 全绿，无异常日志。
- 单测：桥接层纯函数化（给 fake 的 teams/library/persona 三个 stub），覆盖"服务缺失 / team 不存在 / persona 缺失 / persona 超长 / slug 重名 / 超 maxMembers"。

---

## B · 路由决策可见

### B.1 现状
`routeAudit[]` 已按任务落盘，但**没有任何出口**：用户只能翻 `.agent-teams/<teamId>/team.json`。

### B.2 设计

**实际增量边界（2026-10-08 评审核实）**：任务卡的难度徽章、任务 model、`routeStatus`/`routeSource` 投影**已存在**（`src/snapshot.ts` L208-211、`ActivityPanel.tsx` L496-498）。本段真正缺的是 audit 步骤链、reasoning effort 显示、`degraded`/`fallback`/`pending` 的视觉区分；实现时勿重复造已有的东西。

1. **数据投影（步 5）**：把任务的 `routeAudit` 汇进 client 可见的 snapshot/事件流（与现有 member/task 投影同一通道，不新开通道）；**截最近 12 条+被截总数**（`tools.ts` 在重解析时会追加 audit，不截则无界增长），并补 `degraded` / `fallback` / `reasoningEffort` 字段。
2. **UI（步 7，按 D 段规格落地）**：
   - 任务卡上显示难度徽章（`low/medium/high/max`）+ 最终线路（`provider/model@effort`）
   - 悬停/展开 popover：按 sequence 列出 audit steps（`validate` → `user-route`/`captain-route`/`route-rejected`/`tier-rotate`/`same-tier-substitute`/`tier-degrade`/`fallback`/`pending`），每步带 `status` 与 `detail`
   - 降级/兜底用不同色重（`tier-degrade` 黄、`fallback` 橙、`blocked` 红）
3. **成员视角（步 7）**：成员行显示其 `routeKey` 拆解（difficulty / role / provider / model / effort 五段）。

### B.3 验收
- 步 5 单测：audit 截断+计数、字段缺失不炸、`degraded`/`fallback` 标志透传。
- 步 7 活体三场景：高难度命中降级 → 面板如实显示降级链路；全局兜底 → 显示 `fallback` 步骤；catalog 不可用 → 显示 `pending` 而非假装有线路。

---

## C · 成本汇总 + 难度评分卡

### C.1 团队级成本汇总
**问题**：每个成员是**独立会话**（`startContinuable` 创建），`dsh-cost-meter` 按会话算，面板上看不到"这个团一共花了多少、谁最贵"。

**设计（2026-10-08 评审裁决：数据层与展示层分离，展示并入步 7）**：
- 优先复用宿主已有的 usage/成本来源（不自己重算 token）——先以 `ctx.get()` 探测 `dsh-cost-meter` 是否 `provide` 了可注入服务（**不用 try/catch 当探测器**）；有则用，无则从成员会话 usage 投影读取（成员是 `startContinuable` 独立会话，按 member.id/session 聚合）。
- 汇总粒度：团队合计 + 成员分列（输入/输出/缓存命中/估算费用），**每个数字标注来源**。
- **展示位置（与 D.5 对齐，取代早先"花名册列分列"的表述）**：面板标题区一行团队合计，成员分列明细收进 popover；花名册行不放成本数字。
- 数据层只负责字段与 no-data 状态；UI 全部在步 7 按 D 段实现。

**风险**：跨版本 usage 字段不稳定 → 用"能读到就显示、读不到就显示 —"的降级策略，绝不编造数字。

### C.2 显式难度评分卡（**关键**）
**问题（已核实）**：`agent_teams_create_task` 有 `difficulty` 参数，但 `usageSectionText()`（`src/index.ts` L139-150，10 条协议）**一次都没提 `difficulty` 是什么、什么算 high**。四档派发的输入端因此全凭队长感觉。

用户已决定"留空派发" ⇒ **没有评分卡，留空派发就是随机派发**。所以 C.2 是 A 的前置。

**设计**：在 `usageSectionText` 里加一段显式判据（并在 `agent_teams_create_task` / `edit_plan` 的 `difficulty` 参数 description 里给一行摘要）：

| 档 | 判据（收敛条件，非任务类型） | 典型（编码） | 典型（调研/写作） |
| --- | --- | --- | --- |
| `low` | 机械执行、单点改动、错了立刻可见 | 改文案、加字段、跑命令取结果 | 单点查询、格式整理 |
| `medium` | 单模块/单一方法、有明确验收 | 加工具参数、补一个测试、改一处 UI 文案逻辑 | 常规调研、单源分析、初稿 |
| `high` | 跨模块/跨文件、要权衡、有回归风险 | 改服务接口、重构数据流、写质量门 | 多源交叉验证、需设计判断的方案 |
| `max` | 疑难根因、安全关键、不可逆/公开契约 | 改协议、改 schema、删旧路径、发布 | 安全关键结论、独立复核、跨模块架构决策 |

外加三条硬规则：
- **不确定就报高不报低**（降级是允许的、升档是禁止的——与 value-router "只降不升"一致）
- **档位是任务属性，不是成员属性**；同一成员可接不同档任务（`memberReuseKey` 会按档拆槽位）
- **档位直接映射线路池与成本——夸大档位是烧钱，不是买保险**（max 档对齐 value-router 池语义：疑难根因/安全关键/独立复核/跨模块架构决策）

### C.3 验收
- 单测（可自动化）：`usageSectionText` 输出含评分卡段落，且原 10 条协议逐字不变。
- 实跑抽查（不可自动化，captain 活环境执行一次并记录）：同一目标跑两次，队长给出的难度分布稳定（不出现同任务一次 low 一次 max）。

---

## D · UI 改动（设计语言参照 `dsh-claude-style`）

### D.0 参照物与采信边界

参照插件：`D:\DSHData\home\profiles\desktop\node_modules\dsh-claude-style`。它的设计体系有两层：

| 文件 | 内容 |
| --- | --- |
| `docs/STYLE.md`（661 行 / 44KB） | 逐 token 的配色表（Claude 与 DeepSeek 两套并列）、弹层/搜索/状态行/首页版面等组件的精确尺寸与动画 |
| `docs/decisions/D*.md`（53 篇 ADR） | 每篇写「决定 / 理由 / 代价 / 重审条件」；编号是稳定标识，被推翻的作废不复用 |

**只采信它的设计语言与尺寸，不抄它的实现手段。** 它大量工作在**改造宿主既有 DOM**（结构辨认 → 打标记 → `!important` 覆盖宿主 inline 值）；AgentTeams 是自带 React 组件、渲染自己的面板，**不需要**那一套。

### D.1 令牌：只用宿主 alias，不写死颜色

- 颜色一律走 `--dsw-alias-*`：`bg-base`、`bg-layer-1/2/3`、`bg-overlay`、`border-l1/l2/l3`、`label-primary/secondary/tertiary/caption`、`brand-primary`、`link`、`state-business-primary/tertiary`、`interactive-bg-hover`。
- **不新增私有颜色 token**；确需中间色时用 `color-mix()` 从宿主令牌派生。
- 主题：**默认只写一份 token 引用**——alias token 随宿主主题自动切换；仅 `color-mix()` 派生值需要主题分支。（2026-10-08 裁决：不采用「暗色基准 + `:not([data-ds-dark-theme])` 亮色覆盖」——那是 claude-style 宿主 DOM 改造场景的纪律，自有 React 面板用不上。）
- 单一强调色占可见元素 **< 10%**，只用于「当前项 / 选中 / 焦点环」，**不用于普通文字**。

### D.2 形状与节奏

| 项 | 值 |
| --- | --- |
| 圆角 | 4 / 8 / 16 px；CTA 用 pill（9999px） |
| 边框 | 1px `var(--dsw-alias-border-l1)` |
| 间距 | 4px 节奏 |
| 字体 | 标题/陈述 serif；UI 与正文宿主 sans；**技术标签用 mono**（provider/model/effort、任务 id、routeKey） |
| 数字 | 会变化的数字（token、费用、耗时）一律 **tabular figures**，避免跳动 |

### D.3 弹层（B 的 audit popover 直接用这套）

照抄它的弹层基准（ADR D16 + STYLE.md「Popovers」），**不自创第二套卡片**。

**卡片**：背景 `var(--dsw-alias-bg-overlay)`；边框 `1px solid var(--dsw-alias-border-l1)`；圆角 12px；阴影 `0 8px 30px rgba(20,20,19,.12), 0 2px 8px rgba(20,20,19,.06)`（**字面值豁免**：阴影属 elevation 不属主题色，2026-10-08 裁决）；内边距 6px；布局 flex column、`gap: 6px`、列表体行距 3px；层级高于宿主菜单；入场 `opacity 0→1` + `translateY(4px) scale(.98)` → none，`.15s ease`。

**行**：最小高度 32px（下限非上限，两行会撑高）；内边距 `2px 7px`；圆角 6px；文字 13px/20px `label-primary`；悬停 `var(--dsw-alias-interactive-bg-hover)`（用 D.1 已列的 token，**不用字面 rgba**，2026-10-08 裁决）；图标 16px `label-secondary`；两行行 = 名称 13px/16px @500 + 说明 11px/14px `label-tertiary`。

**小标题 / 分隔**：小标题 11px/16px @600、`letter-spacing .04em`、大写、`label-tertiary`、`padding: 6px 7px 2px`；分隔线 1px `border-l1`、`margin: 2px 4px`。

**停留与互斥**：指针进入后 **100ms** 才展开（避免划过误开），离开 **100ms** 后收起；**同一时刻只开一张**（打开前先关其余）。这两个数照抄，不另定。

### D.4 B 落地

- **任务卡**（在既有任务板卡片上增量）：难度徽章（`low/medium/high/max`，mono）+ 最终线路 `provider/model@effort`（mono）。
- **悬停任务卡 → audit popover**：小标题「路由决策」，其下每个 audit step 一行（两行行：步骤名 + `detail`），带序号。
- **步骤着色**（只用状态令牌，不引入新色）：

| 步骤 | 表现 |
| --- | --- |
| `validate` / `user-route` / `captain-route` / `tier-rotate` / `same-tier-substitute` | 中性 `label-secondary` |
| `tier-degrade` | `state-business-primary` |
| `fallback` | `state-business-primary` + 加粗 |
| `route-rejected` / `blocked` | 宿主 error 令牌（无则该色加深） |
| `pending` | `label-caption` + 文案「线路未定，等待目录」 |

- **成员行**：显示 `routeKey` 五段拆解（difficulty / role / provider / model / effort），mono，`label-tertiary`。
- popover 内**只读**，不提供写操作。

### D.5 C.1 落地

直接采用它的数字纪律（ADR D27）：

- **数字只有一个去处**：面板标题区一行摘要（团队合计），明细进一个 popover；**不在成员行里散着一堆数字**（C.1 节早先"花名册列分列"的表述已被本条取代，2026-10-08 裁决）。
- 读数用 **tabular figures**；标签与格式规则**照抄宿主**（宿主有 `formatTokens` / `formatDuration` 之类规则时镜像一份，输出逐字符相同）。
- **「无数据」≠「零」**：读不到来源时画占位骨架（按真实行高 37px = 16 + 1 + 20、1.6s 脉冲），**不画 0**；骨架 **2s 后放弃**，之后显示 `—`。
- 每个数字标注来源（哪个投影/账本）。

### D.6 借自它的四条工程纪律

1. **快速失败，不吞错**（ADR D12）：可选宿主服务用 `ctx.get(name) === undefined` 判断（cordis 对缺席服务返回 `undefined`），**不要拿 try/catch 当探测器**；每个允许的 catch 必须在注释里写明原因。
2. **功能隔离**：每个功能单独安装，装不上就报告一次并退役；teardown **最先注册且幂等**——每个功能是它自己 DOM 标记的唯一清理者。
3. **样式性能**（ADR D9）：依赖结构的判断由脚本算成属性、CSS 只读属性；`:has()` **只允许出现在选择器最后一段**。实测：非末段 `:has()` 每帧样式重算多 7–13ms，末段仅 0.1–0.5ms。
4. **样式归属**（ADR D33）：AgentTeams 的规则全部限定在自己的根节点下，避免与皮肤互相认领。

> 注（2026-10-08 评审）：纪律 1–3 源自 claude-style 的宿主 DOM 改造场景，在本插件的自有 React 面板**没有直接落点**（React 卸载即清理、className 直控无 `:has()` 需求）——借其原则，不寻找不存在的 DOM 标记机制；第 1 条的探测语义与第 4 条直接适用。

### D.7 明确不做

- **不做吉祥物/像素动画**（螃蟹与 Deepy 是它的品牌资产，与团队面板无关）。
- **不改造宿主既有 DOM**：无需结构辨认 + `!important` 覆盖那一套。
- **不新增私有颜色 token**。
- **不引入图表库**：成本明细用文字行 + 数字，不做热力图/堆叠图。

### D.8 验收

- 亮/暗两主题逐面板检查：颜色全部来自宿主令牌（grep 样式表，**除注明豁免的 elevation 阴影外**无裸十六进制与 `rgb(`）。
- audit popover：100ms 展开、100ms 收起、同时只开一张；步骤着色与实际 `routeAudit` 一致（造降级 / 兜底 / pending 三场景）。
- 成本：无数据时先骨架后 `—`，**不出现 `0`**；数字列不跳动。
- 焦点环用 `brand-primary`，不用自定义色。
- 选择器检查：无 `:has()` 出现在非末段。

---

## 实施顺序（按依赖，每步独立可验证）

| 步 | 内容 | 依赖 | 验证 |
| --- | --- | --- | --- |
| 1 | ✅ 合上游 4 个 bug 修复 | — | 已完成（`4346733`） |
| 2 | ✅ metadata 归属（homepage/repository/bugs + contributors） | — | 已完成（`46a507a`，`pnpm verify:release` 6/6） |
| 3 | **C.2 难度评分卡**（A 的前置） | — | `usageSectionText` 单测 |
| 4 | **A** agency-agents 桥接（含回落） | 3 | 桥接单测 + 服务缺失回归 |
| 5 | **B** 数据层：routeAudit 投影进快照（截 12 条 + degraded/fallback/effort 字段） | 4 | 截断/字段/回归单测 |
| 6 | **C.1** 数据层：成本聚合（no-data≠0，来源标注） | 5 | 形状与 no-data 单测 |
| 7 | **D** UI：B/C 展示层一次性落地（含 B.3 三场景与 C.1 读数显示） | 6 | 双主题浏览器验收（captain 侧） |
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

---

## 评审裁决记录（2026-10-08，用户已确认）

1. **成本数字位置**：标题区团队合计 + popover 成员分列（守 D.5「数字只有一个去处」；C.1 早先"花名册列分列"表述作废）。
2. **步骤切分**：步 5/6 只做数据层，步 7 一次性做全部 UI——消除"先做临版 UI、步 7 再按 D 规格重写"的返工。
3. **agency 主理人字段**：`agent_teams_create` 响应回显 coordinatorPrompt/constraints/deliveryRequirements 供队长采纳；goal 并入团队 description。
4. **D 段自洽**：悬停改用 `interactive-bg-hover` token；阴影字面值按 elevation 豁免并在验收注明；删「暗色基准/`:not()`」纪律，默认单份 token、仅 `color-mix()` 派生写主题分支。
5. **C.2 评分表**：采纳修订稿——max 档对齐 value-router 池语义（疑难根因/安全关键/独立复核/跨模块架构决策），补调研/写作类锚点，加「夸档=烧钱」成本平衡句。
6. **实现性修正**：A.2 的 agency 服务探测一律 `ctx.get()`（模块级 `inject` 是硬依赖，agency-agents 缺席会让本插件整体不激活，与"任一缺失整体回落"相反；照 `src/router.ts` 的 `valueRouterOf()` 模式）。
7. **A 段缺省规格补齐**：slug 重名 `-2` 后缀+diagnostics；超 maxMembers 报错不截断；persona 截断上限 8000 字符；locale 客户端优先、缺省 zh；冲突矩阵 `agencyTeam`×`profile` / ×`plan.members` 报错、×`plan.tasks` 允许。
8. **文档勘误**：0 段 D 行与实施顺序步 7 的「待定」过期文字更新；B 段补实际增量边界（难度徽章/routeStatus/routeSource 投影已存在）；D.6 注明纪律 1–3 无直接落点；C.3 验收拆为「单测（可自动化）+ 实跑抽查（captain 活环境）」。
