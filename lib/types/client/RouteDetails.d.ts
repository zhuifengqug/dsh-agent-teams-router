/**
 * Legacy route-audit presentation.
 *
 * 2026-10-10 去路由后本插件不再产生任何审计条目；本模块保留的唯一用途是让
 * **旧团队**磁盘上已有的审计轨迹仍可在面板里读出来（历史可读，不再新增）。
 * 新任务的 `routeAudit` 一律不存在，因此这些组件对新团队不渲染任何内容。
 *
 * Pure helpers (timing constants, `routeLine`) live in
 * `route-details-model.ts` so offline tests can import the tsc output without
 * pulling in CSS.
 * @module dsh-agent-teams/client/route-details
 */
import type { ActivityTask } from './activity-monitor.ts';
import type { AgentTeamsTranslate } from './locales.ts';
/** The four difficulty tiers keep their host task-badge look (D.4/D.5). */
export declare function difficultyBadge(task: ActivityTask, t: AgentTeamsTranslate): React.ReactNode;
/** Route audit popover (B): read-only D.3 card listing the bounded steps. */
export declare function RouteAuditPopover({ task, t, popoverKey }: {
    readonly task: ActivityTask;
    readonly t: AgentTeamsTranslate;
    readonly popoverKey: string;
}): import("react").JSX.Element | null;
