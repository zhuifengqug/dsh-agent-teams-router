/**
 * Route presentation layer (DESIGN D, step 7).
 *
 * The shared popover recipe serves the per-task route audit (B): the
 * dsh-claude-style card baseline (D.3) with a 100 ms dwell before opening, a
 * 100 ms close grace after the pointer leaves, and only one popover open at a
 * time. The popover is an absolutely positioned overlay under `.panel`
 * (already `position: absolute`, which makes it the containing block) — no
 * body portal, no `position: fixed`. Steps follow the D.4 color table with
 * host status tokens only.
 *
 * Pure helpers (timing constants, `routeLine`, routeKey splitting) live in
 * `route-details-model.ts` so offline tests can import the tsc output without
 * pulling in CSS.
 * @module dsh-agent-teams/client/route-details
 */
import type { ActivityTask } from './activity-monitor.ts';
import type { AgentTeamsTranslate } from './locales.ts';
import { memberRouteKeyParts } from './route-details-model.ts';
/** The four difficulty tiers keep their host task-badge look (D.4/D.5). */
export declare function difficultyBadge(task: ActivityTask, t: AgentTeamsTranslate): React.ReactNode;
/** Route audit popover (B): read-only D.3 card listing the bounded steps. */
export declare function RouteAuditPopover({ task, t, popoverKey }: {
    readonly task: ActivityTask;
    readonly t: AgentTeamsTranslate;
    readonly popoverKey: string;
}): import("react").JSX.Element | null;
/**
 * Member row routeKey chip (B member view): the slot-identity segments the
 * member's own model badge does not already show, in mono `label-tertiary`.
 *
 * The member row already renders a compact model badge on the left, so the
 * `model` segment is intentionally left out here (2026-10-09 user decision:
 * one model label per row, not two). The full five-segment key stays in the
 * `title` and on the data attributes.
 */
export declare function MemberRouteKey({ member }: {
    readonly member: Parameters<typeof memberRouteKeyParts>[0];
}): import("react").JSX.Element | null;
