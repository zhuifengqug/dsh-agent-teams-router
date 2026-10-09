/**
 * Route & cost presentation layer (DESIGN D, step 7).
 *
 * One shared popover recipe serves both the per-task route audit (B) and the
 * per-team member cost breakdown (C.1): the dsh-claude-style card baseline
 * (D.3) with a 100 ms dwell before opening, a 100 ms close grace after the
 * pointer leaves, and only one popover open at a time. The popover is an
 * absolutely positioned overlay under `.panel` (already `position: absolute`,
 * which makes it the containing block) — no body portal, no `position: fixed`.
 * Steps follow the D.4 color table with host status tokens only.
 *
 * Pure helpers (timing constants, `routeLine`, number formatting, routeKey
 * splitting) live in `route-details-model.ts` so offline tests can import the
 * tsc output without pulling in CSS.
 * @module dsh-agent-teams/client/route-details
 */
import type { ActivityCostSummary, ActivityTeam, ActivityTask } from './activity-monitor.ts';
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
/** Cost popover (C.1): the same D.3 card listing the per-member rows. */
export declare function CostPopover({ cost, t, popoverKey }: {
    readonly cost: ActivityCostSummary;
    readonly t: AgentTeamsTranslate;
    readonly popoverKey: string;
}): import("react").JSX.Element;
/**
 * Headline cost cell (C.1): a team-total figure in the panel/team header.
 *
 * States: `ok` with a headline bucket → real number (title carries the
 * metric's source); `ok` without a displayable headline bucket → em dash
 * (data arrived but the headline has nothing honest to show); otherwise a
 * 37px pulsing skeleton that gives up after 2 s and becomes an em dash. The
 * give-up timer keys on the *status value*, not object identity — the poll
 * rebuilds the summary object every second and must not reset the clock.
 */
export declare function TeamCostCell({ cost, t }: {
    readonly cost: ActivityTeam['cost'];
    readonly t: AgentTeamsTranslate;
}): import("react").JSX.Element;
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
