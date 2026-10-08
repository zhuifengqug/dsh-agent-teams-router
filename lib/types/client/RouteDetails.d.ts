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
 * @module dsh-agent-teams/client/route-details
 */
import type { ActivityCostSummary, ActivityTeam, ActivityTask } from './activity-monitor.ts';
import type { AgentTeamsTranslate } from './locales.ts';
/** Pointer dwell before a popover opens (DESIGN D.3; copied, not tuned). */
export declare const POPOVER_OPEN_DELAY_MS = 100;
/** Close grace after the pointer leaves (DESIGN D.3; copied, not tuned). */
export declare const POPOVER_CLOSE_DELAY_MS = 100;
/** Skeleton shows this long before giving up and rendering an em dash (D.5). */
export declare const COST_SKELETON_GIVEUP_MS = 2000;
/** Mono `provider/model@effort` line; empty parts collapse away. */
export declare function routeLine(provider: string, model: string, effort: string): string;
/** The four difficulty tiers keep their host task-badge look (D.4/D.5). */
export declare function difficultyBadge(task: ActivityTask, t: AgentTeamsTranslate): React.ReactNode;
/** Route audit popover (B): read-only D.3 card listing the bounded steps. */
export declare function RouteAuditPopover({ task, t, popoverKey }: {
    readonly task: ActivityTask;
    readonly t: AgentTeamsTranslate;
    readonly popoverKey: string;
}): import("react").JSX.Element | null;
/** Number formatting copied from the host chat rules (D.5: character-identical). */
export declare function formatTokensGrouped(value: number): string;
/** Cost popover (C.1): the same D.3 card listing the per-member rows. */
export declare function CostPopover({ cost, t, popoverKey }: {
    readonly cost: ActivityCostSummary;
    readonly t: AgentTeamsTranslate;
    readonly popoverKey: string;
}): import("react").JSX.Element;
/**
 * Headline cost cell (C.1): a team-total figure in the panel/team header.
 *
 * States: `ok` → real number; `no-data`/missing → a 37px pulsing skeleton that
 * gives up after 2 s and becomes an em dash; never a fabricated zero.
 */
export declare function TeamCostCell({ cost, t }: {
    readonly cost: ActivityTeam['cost'];
    readonly t: AgentTeamsTranslate;
}): import("react").JSX.Element;
/** Mono `difficulty · role · provider/model@effort` route-key decomposition. */
export declare function memberRouteKeyParts(member: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly difficulty?: string;
    readonly normalizedRole?: string;
    readonly role?: string;
}): {
    readonly difficulty: string;
    readonly role: string;
    readonly route: string;
};
/**
 * Member row routeKey chip (B member view): five segments in mono
 * `label-tertiary`, hidden entirely when the member has no frozen key parts.
 */
export declare function MemberRouteKey({ member }: {
    readonly member: Parameters<typeof memberRouteKeyParts>[0];
}): import("react").JSX.Element | null;
