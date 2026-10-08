/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */

import type { TaskDifficulty, TaskRouteAuditEntry, TaskRouteLine, TaskRouteSource, TaskRouteStatus } from './router.ts'

/** Task lifecycle statuses in progression order. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** Structured quality-gate kind. Absent / unknown values are treated as `work`. */
export type TaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work'

export const TASK_KINDS: readonly TaskKind[] = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
  'work',
]

/** Review / requirements conclusion. Only `pass` may complete those kinds. */
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject'

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs_revision', 'reject']

/** Finding severity used by review / requirements output. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'blocker'

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['low', 'medium', 'high', 'blocker']

/** One structured review finding. */
export interface ReviewFinding {
  /** Stable id, for example `SEC-001`. */
  id: string
  severity: FindingSeverity
  file?: string
  line?: number
  problem: string
  requiredFix: string
  resolved?: boolean
}

/** One acceptance criterion result recorded at completion. */
export interface AcceptanceResult {
  criterion: string
  status: 'passed' | 'failed'
  evidence?: string
}

/** One verification command result recorded at completion. */
export interface CommandResult {
  command: string
  status: 'passed' | 'failed'
  exitCode?: number
  evidence?: string
}

/** Profile / team review-loop limits. */
export interface ReviewPolicy {
  requirementsMinRounds?: number
  requirementsMaxRounds?: number
  codeMaxRounds?: number
  maxRepairAttempts?: number
  requiredReviewers?: string[]
}

/** One captain-only contract amendment recorded on a quality task. */
export interface TaskRevision {
  /** Epoch ms when the amendment was applied. */
  at: number
  /** Identity that applied it (`captain`). */
  by: string
  /** Why the previous contract was wrong; kept for the audit trail. */
  reason: string
  /** Amended contract field names (`objective`, `acceptance`, …). */
  fields: string[]
  /** Previous values of the amended fields; fields absent before are omitted. */
  previous: Record<string, unknown>
}

/** Append-only observations; never replace the terminal verdict or unlock a gate. */
export interface TaskEvidence {
  at: number
  by: string
  attempt: number
  attemptId?: string
  note?: string
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
}

/** One task of a team's task list. */
export interface TeamTask {
  /** Stable task id from the profile template; absent for ad-hoc tasks. */
  profileSeedId?: string
  /** Stable task id within the team (`t1`, `t2`, …). */
  id: string
  /** Brief title for the task. */
  subject: string
  /** What needs to be done. */
  description?: string
  status: TaskStatus
  /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
  assignee?: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  dependencies: string[]
  /** The worker's written result, set when the task completes or fails. */
  output?: string
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
  handoffId?: string
  /** Previous activation retained until a handoff drain succeeds (retryable). */
  handoffFromMemberId?: string
  /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
  reassigning?: boolean
  /** Quality-gate kind. Missing values are treated as `work`. */
  kind?: TaskKind
  /** Review / requirements / repair loop index, 1-based when present. */
  round?: number
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
  /** Supplemental observations, attributed to their original execution generation. */
  supplementalEvidence?: TaskEvidence[]
  reviewedTaskId?: string
  reviewedAttempt?: number
  /** Repair source: the implementation / previous successful artifact. */
  sourceTaskId?: string
  sourceFindingIds?: string[]
  /** User-constraint / goal items this task claims to cover. */
  coverageOf?: string[]
  /** Captain-only contract amendments, oldest first (see amendTaskContract). */
  revisions?: TaskRevision[]
  /**
   * Task difficulty tier. Missing means `medium`.
   *
   * Difficulty is the routing dimension: whoever dispatches a task may pick a
   * tier instead of naming a model, and the model router turns that tier into a
   * concrete provider/model/reasoning_effort.
   */
  difficulty?: TaskDifficulty
  /** Free-text role as written by the captain or the user. Missing means `general`. */
  role?: string
  /** `role` after trim + whitespace collapsing + Unicode lowercasing. Part of the member reuse key. */
  normalizedRole?: string
  /**
   * Optional **explicit** route request: provider/model/reasoning_effort.
   *
   * The user's hard route wins over everything; the captain's preference is
   * used when valid and merely recorded as rejected when not. Absent means the
   * task routes by difficulty.
   */
  route?: TaskRouteLine
  /** Provenance of `route` when present: `user` (hard) or `captain` (preference). */
  routeSource?: 'user' | 'captain'
  /** Outcome of the last validation/resolution: only `resolved` may be dispatched. */
  routeStatus?: TaskRouteStatus
  /** Where the last successful resolution actually got the route from. */
  routeResolvedSource?: TaskRouteSource
  /**
   * The concrete route the last successful resolution produced.
   *
   * Kept separate from `route` (which is the *request*): a task may carry no
   * request at all and still resolve to a concrete route from its difficulty
   * tier. Members freeze themselves from this value, not from the request.
   */
  resolvedRoute?: TaskRouteLine
  /** Audit trail of the last resolution, oldest first. */
  routeAudit?: TaskRouteAuditEntry[]
  /**
   * Why this task is waiting instead of running.
   *
   * Set when a task cannot be dispatched even though its route is fine — today
   * only when the plan needs more members than the global `maxMembers` cap
   * allows. The task keeps its resolved route: it is never downgraded and never
   * given a different model, it simply queues.
   */
  queueReason?: string
  createdAt: number
  updatedAt: number
}

/** One audit step as the activity snapshot carries it (bounded projection of the durable entry). */
export interface TeamRouteAuditStep {
  at: number
  step: string
  outcome: string
  detail: string
  tier?: string
  route?: { provider?: string; model?: string; reasoning_effort?: string; status?: string }
}

/** Bounded audit projection: the most recent steps plus how many older ones were cut. */
export interface TeamRouteAuditProjection {
  /** The most recent entries, oldest first. */
  entries: readonly TeamRouteAuditStep[]
  /** Entries on the durable record before truncation. */
  total: number
  /** Older entries cut to keep the snapshot payload bounded. */
  truncated: number
}

/** Member lifecycle status. */
export type MemberStatus = 'idle' | 'working' | 'removed'

/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this member was created. */
  provider?: string
  /** Resolved model captured when this member was created. */
  model?: string
  /** Resolved reasoning effort captured from the captain or target model default. */
  reasoningEffort?: string
  /** Prompt specific to this member's execution turns. */
  executionPrompt?: string
  /** Configured second-choice route. */
  fallback?: TeamModelFallback
  /** Active route after fallback, without changing the primary descriptor route. */
  activeProvider?: string
  activeModel?: string
  /** Whether the fallback route is currently active. */
  fallbackActive?: boolean
  /**
   * Frozen member reuse key: `difficulty + normalizedRole + provider + model +
   * reasoning_effort`. Two tasks that resolve to the same key must be served by
   * the same member; a different key requires a separate member.
   */
  routeKey?: string
  /**
   * Provenance of `provider`/`model`/`reasoningEffort`.
   *
   * `user` = pinned by the human in the staged plan editor. A pin is an explicit
   * decision: it outranks the route derived from the member's tasks, and it must
   * be dispatchable or approval is rejected. `captain` = set through the
   * model-facing plan tools. Absent = authored by a profile, or derived from the
   * member's tasks by `planMemberSlots`.
   */
  routeSource?: 'user' | 'captain'
  /** Difficulty this member was frozen for (part of `routeKey`). */
  difficulty?: string
  /** Normalized role this member was frozen for (part of `routeKey`). */
  normalizedRole?: string
  joinedAt: number
  status: MemberStatus
  /** Execution admission is closed while a failed/pending handoff is drained. */
  stopping?: boolean
  /**
   * Last member-start failure, recorded so the captain can see why a member
   * never acquired a session instead of observing an unexplained `unspawned`
   * member. Cleared by the next successful start.
   */
  spawnError?: string
}

/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
  /** Guidance is scoped to the recipient's execution generation, when present. */
  taskId?: string
  attemptId?: string
  /** Source execution generation, independent of the recipient guidance generation. */
  sourceTaskId?: string
  sourceAttemptId?: string
  sourceTaskStatus?: TaskStatus
  /** Cancelled delivery is retained for audit but must not wake the recipient. */
  discardedAt?: number
}

/** Snapshot of the named profile used to seed a team. */
export interface TeamModelFallback {
  provider: string
  model: string
}

export interface TeamProfileSnapshot {
  name: string
  description?: string
  protocol?: string
  executionPrompt?: string
  fallback?: TeamModelFallback
  /** Frozen planning mode: captain plans the graph; seed keeps template tasks. */
  taskPlanning?: 'captain' | 'seed'
  /** Frozen review-loop policy from the creating profile. */
  reviewPolicy?: ReviewPolicy
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Immutable named profile snapshot, when created from a profile. */
  profile?: TeamProfileSnapshot
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  createdAt: number
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
  /**
   * Two-phase execution lifecycle. Missing means `running` for durable
   * compatibility with teams created before staging existed.
   */
  phase?: 'staged' | 'running'
  /**
   * Human-facing review sub-state while `phase` is `staged`. Missing staged
   * records are treated as `awaiting_review` for backward compatibility.
   * `awaiting_feedback` means the user returned to chat and the Captain must
   * ask what should change before editing this same draft.
   */
  planReviewState?: 'awaiting_review' | 'awaiting_feedback'
  /** Timestamp written only after a staged plan is explicitly approved. */
  approvedAt?: number
  /**
   * Human halt from the captain chat. The team remains on disk, members stay
   * available, and unfinished work is cancelled until the captain resumes.
   */
  halted?: boolean
  /** Timestamp of the latest human halt, when present. */
  haltedAt?: number
  /** Review-loop policy snapshot copied from the creating profile, when present. */
  reviewPolicy?: ReviewPolicy
  /** Set when an automatic review/repair loop hits its configured ceiling. */
  escalated?: boolean
}

// ── 团队成本汇总（DESIGN C.1 数据层，2026-10-08 评审裁决：数据层与展示层分离） ──
//
// 形状只挂在活动快照（snapshot.ts → TeamActivitySnapshot.cost）上，**不写
// team.json**：成本是活数据（来自宿主 usage 来源），落盘即过期。展示位置按
// DESIGN D.5（标题区一行团队合计 + 成员分列进 popover），UI 全部在步 7。

/** 成本数字的来源（闭集；面板据此给每个数字标注「从哪来」）。 */
export type TeamCostSource =
  | 'cost-meter:service'
  | 'projection:costUsage'
  | 'projection:tokenUsage'

/** 一个实测数字：真实读数 + 产生它的来源。绝不编造、绝不估算。 */
export interface TeamCostMetric {
  value: number
  source: TeamCostSource
}

/**
 * 契约四桶：输入 / 输出 / 缓存命中 / 缓存写入 / 估算费用。
 * 来源真正报出的桶才存在——缺桶 = 该项无数据（≠ 0）。
 */
export interface TeamCostBuckets {
  inputTokens?: TeamCostMetric
  outputTokens?: TeamCostMetric
  cacheReadTokens?: TeamCostMetric
  cacheWriteTokens?: TeamCostMetric
  costEstimate?: TeamCostMetric
}

/** 一个成员的成本行。`reading` 缺席 = 该成员无数据（不是 0）。 */
export interface TeamMemberCost {
  /** 成员的 durable 子会话 id（staged/未派生成员为空串）。 */
  memberId: string
  memberName: string
  reading?: TeamCostBuckets
  /**
   * 来源报告的、归属该成员的委托子会话数（成员开启委派、其孙会话有账本记录时
   * 才出现）。这些子会话的用量已并入该成员读数，避免团队合计漏算。
   */
  attributedSubsessions?: number
}

/**
 * 团队级成本汇总（DESIGN C.1）。
 *
 * - `status: 'no-data'`：来源缺席或读不到任何成员读数——**明确 no-data 状态，
 *   绝不输出 0 充数**；`reason` 说明为什么读不到，供面板展示。
 * - `status: 'ok'`：至少一条真实读数；`source` 标注读数实际使用的来源，
 *   `totals` 对成员读数逐桶求和（没有任何成员报出的桶保持缺席），`members`
 *   为花名册全员分列（无读数的成员不带 `reading`）。
 */
export interface TeamCostSummary {
  status: 'ok' | 'no-data'
  /** 读数实际使用的来源（status 为 `ok` 时存在）。 */
  source?: TeamCostSource
  /** 读不到的原因（status 为 `no-data` 时存在）。 */
  reason?: string
  /** 团队合计；没有任何成员报出的桶保持缺席（≠ 0）。 */
  totals?: TeamCostBuckets
  /** 成员分列；status 为 `ok` 时花名册全员出现。 */
  members?: readonly TeamMemberCost[]
}
