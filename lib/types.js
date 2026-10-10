/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */
/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];
export const TASK_KINDS = [
    'requirements',
    'implementation',
    'verification',
    'review',
    'repair',
    'integration',
    'work',
];
export const REVIEW_VERDICTS = ['pass', 'needs_revision', 'reject'];
export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'blocker'];
// ── 团队成本汇总 ──────────────────────────────────────────────────────────
//
// 2026-10-10 用户裁决下线：成本单元格与「费用明细」popover 已整体删除，
// 数据层（原 src/cost.ts）、快照投影（TeamActivitySnapshot.cost）与相关
// 类型一并移除。此处不再保留 cost 形状。
