import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { COST_SKELETON_GIVEUP_MS, POPOVER_CLOSE_DELAY_MS, POPOVER_OPEN_DELAY_MS, formatCostEstimate, formatTokensGrouped, memberRouteKeyParts, routeLine, } from "./route-details-model.js";
import css from './RouteDetails.module.css';
/** Single shared open popover: a non-empty key replaces the previous card. */
let openPopoverKey = null;
const popoverListeners = new Set();
function publishPopoverKey(next) {
    if (openPopoverKey === next)
        return;
    openPopoverKey = next;
    for (const listener of popoverListeners)
        listener();
}
function subscribePopoverKey(listener) {
    popoverListeners.add(listener);
    return () => { popoverListeners.delete(listener); };
}
/** Shared 100 ms dwell / 100 ms grace / one-card-at-a-time controller. */
function useExclusivePopover(popoverKey) {
    const [open, setOpen] = useState(false);
    const openTimer = useRef(null);
    const closeTimer = useRef(null);
    const openTimerKey = useRef(null);
    useEffect(() => subscribePopoverKey(() => {
        if (openPopoverKey === popoverKey || openPopoverKey === null)
            return;
        setOpen(false);
    }), [popoverKey]);
    useEffect(() => () => {
        if (openTimer.current !== null)
            clearTimeout(openTimer.current);
        if (closeTimer.current !== null)
            clearTimeout(closeTimer.current);
    }, []);
    const enter = useCallback(() => {
        if (closeTimer.current !== null) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
        if (openTimerKey.current === popoverKey)
            return;
        openTimerKey.current = popoverKey;
        openTimer.current = setTimeout(() => {
            openTimer.current = null;
            publishPopoverKey(popoverKey);
            setOpen(true);
        }, POPOVER_OPEN_DELAY_MS);
    }, [popoverKey]);
    const leave = useCallback(() => {
        openTimerKey.current = null;
        if (openTimer.current !== null) {
            clearTimeout(openTimer.current);
            openTimer.current = null;
        }
        closeTimer.current = setTimeout(() => {
            closeTimer.current = null;
            setOpen(false);
            if (openPopoverKey === popoverKey)
                publishPopoverKey(null);
        }, POPOVER_CLOSE_DELAY_MS);
    }, [popoverKey]);
    return { open, enter, leave };
}
function popoverPointerProps(open, enter, leave) {
    return { onPointerEnter: enter, onPointerLeave: leave, 'data-open': open || undefined };
}
/** aria-label/`title` carry the same fact for keyboards and screen readers. */
function auditTriggerLabel(task, t) {
    const total = task.routeAudit === undefined ? 0 : task.routeAudit.total;
    return `${t('route.auditTitle')} · ${t('route.auditSteps', { count: total })}`;
}
/** The four difficulty tiers keep their host task-badge look (D.4/D.5). */
export function difficultyBadge(task, t) {
    if (task.difficulty === undefined)
        return null;
    return (_jsx("span", { className: css.difficultyBadge, "data-difficulty": task.difficulty, title: t('task.route.difficulty', { difficulty: task.difficulty }), children: task.difficulty }));
}
/** D.4 step coloring: neutral / business / error / caption only. */
function stepTone(step) {
    switch (step.step) {
        case 'tier-degrade': return 'business';
        case 'fallback': return 'businessStrong';
        case 'route-rejected':
        case 'blocked': return 'error';
        case 'pending': return 'pending';
        default: return 'neutral';
    }
}
/** Render one audit step row; the trailing route chip mirrors the D.4 table. */
function auditStepRow(step, index, t) {
    const tone = stepTone(step);
    const route = step.route;
    const routeText = route === undefined
        ? ''
        : routeLine(route.provider ?? '', route.model ?? '', route.reasoning_effort ?? '');
    return (_jsxs("div", { className: css.auditRow, "data-tone": tone, children: [_jsx("span", { className: css.auditIndex, "aria-hidden": true, children: index + 1 }), _jsxs("span", { className: css.auditRowBody, children: [_jsxs("span", { className: css.auditStepName, children: [_jsx("span", { className: css.auditStep, children: step.step }), step.outcome !== '' && _jsx("span", { className: css.auditOutcome, children: step.outcome })] }), step.detail !== '' && _jsx("span", { className: css.auditDetail, children: step.detail }), routeText !== '' && _jsx("span", { className: css.auditRoute, children: routeText }), tone === 'pending' && step.detail === '' && (_jsx("span", { className: css.auditDetail, children: t('route.auditPendingDetail') }))] })] }, `${step.at}:${step.step}:${index}`));
}
/** Route audit popover (B): read-only D.3 card listing the bounded steps. */
export function RouteAuditPopover({ task, t, popoverKey }) {
    const audit = task.routeAudit;
    const { open, enter, leave } = useExclusivePopover(popoverKey);
    if (audit === undefined || audit.entries.length === 0)
        return null;
    return (_jsxs("span", { className: css.auditAnchor, ...popoverPointerProps(open, enter, leave), children: [_jsxs("span", { className: css.auditTrigger, role: "img", "aria-label": auditTriggerLabel(task, t), title: auditTriggerLabel(task, t), "data-audit-trigger": true, children: [t('route.auditTrigger', { count: audit.total }), audit.truncated > 0 && _jsx("span", { className: css.auditTruncated, children: t('route.auditTruncated', { count: audit.truncated }) })] }), open && (_jsxs("span", { className: css.popoverCard, "data-popover": "route-audit", "data-audit-popover": true, role: "group", "aria-label": t('route.auditTitle'), children: [_jsx("span", { className: css.popoverHeading, children: t('route.auditTitle') }), _jsx("span", { className: css.popoverList, children: audit.entries.map((step, index) => auditStepRow(step, index, t)) })] }))] }));
}
/** Number formatting copied from the host chat rules (D.5: character-identical). */
function costMetricText(metric, cost) {
    if (metric === undefined)
        return null;
    return cost ? formatCostEstimate(metric.value) : formatTokensGrouped(metric.value);
}
/** Cost popover (C.1): the same D.3 card listing the per-member rows. */
export function CostPopover({ cost, t, popoverKey }) {
    const { open, enter, leave } = useExclusivePopover(popoverKey);
    const members = cost.members ?? [];
    return (_jsxs("span", { className: css.auditAnchor, ...popoverPointerProps(open, enter, leave), children: [_jsx("span", { className: css.auditTrigger, role: "img", "aria-label": t('cost.popoverAria'), title: t('cost.popoverAria'), "data-cost-trigger": true, children: t('cost.membersDetail', { count: members.length }) }), open && (_jsxs("span", { className: css.popoverCard, "data-popover": "team-cost", "data-cost-popover": true, role: "group", "aria-label": t('cost.popoverAria'), children: [_jsx("span", { className: css.popoverHeading, children: t('cost.popoverTitle') }), _jsx("span", { className: css.popoverList, children: members.map((member) => (_jsxs("div", { className: css.costRow, "data-member-cost": true, children: [_jsx("span", { className: css.costRowName, children: member.memberName }), _jsxs("span", { className: css.costRowBuckets, children: [['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map((bucket) => {
                                            const text = costMetricText(member.reading?.[bucket], false);
                                            if (text === null)
                                                return null;
                                            return (_jsxs("span", { className: css.costBucket, children: [_jsx("span", { className: css.costBucketLabel, children: t(`cost.bucket.${bucket}`) }), _jsx("span", { className: css.costBucketValue, children: text })] }, bucket));
                                        }), (() => {
                                            const text = costMetricText(member.reading?.costEstimate, true);
                                            if (text === null)
                                                return null;
                                            return (_jsxs("span", { className: css.costBucket, "data-bucket-cost": true, children: [_jsx("span", { className: css.costBucketLabel, children: t('cost.bucket.costEstimate') }), _jsx("span", { className: css.costBucketValue, children: text })] }));
                                        })(), member.attributedSubsessions !== undefined && member.attributedSubsessions > 0 && (_jsxs("span", { className: css.costBucket, children: [_jsx("span", { className: css.costBucketLabel, children: t('cost.bucket.subsessions') }), _jsx("span", { className: css.costBucketValue, children: formatTokensGrouped(member.attributedSubsessions) })] }))] }), _jsx("span", { className: css.costRowSource, children: t('cost.source.label', { source: cost.source ?? '' }) })] }, member.memberId || member.memberName))) })] }))] }));
}
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
export function TeamCostCell({ cost, t }) {
    const status = cost?.status;
    const [skeletonEnded, setSkeletonEnded] = useState(false);
    useEffect(() => {
        if (status === 'ok') {
            setSkeletonEnded(false);
            return;
        }
        const timer = setTimeout(() => setSkeletonEnded(true), COST_SKELETON_GIVEUP_MS);
        return () => clearTimeout(timer);
    }, [status]);
    if (status === 'ok' && cost !== undefined) {
        const totals = cost.totals;
        const headlineMetric = totals?.costEstimate;
        const headline = headlineMetric ?? totals?.inputTokens;
        if (headline !== undefined) {
            return (_jsxs("span", { className: css.costCell, "data-cost-state": "ok", title: t('cost.source.label', { source: (headlineMetric ?? headline).source }), children: [_jsx("span", { className: css.costCellLabel, children: t('cost.summaryLabel') }), _jsx("span", { className: css.costCellValue, children: costMetricText(headline, headlineMetric !== undefined) })] }));
        }
        return (_jsx("span", { className: css.costCellNoData, "data-cost-state": "no-data", title: t('cost.noDataFallback'), children: t('cost.noDataMark') }));
    }
    if (!skeletonEnded) {
        return _jsx("span", { className: css.costCellSkeleton, "data-cost-state": "skeleton", "aria-label": t('cost.skeletonAria') });
    }
    return (_jsx("span", { className: css.costCellNoData, "data-cost-state": "no-data", title: cost?.reason ?? t('cost.noDataFallback'), children: t('cost.noDataMark') }));
}
/**
 * Member row routeKey chip (B member view): five segments in mono
 * `label-tertiary`, hidden entirely when the member has no frozen key parts.
 */
export function MemberRouteKey({ member }) {
    const { difficulty, role, provider, model, effort } = memberRouteKeyParts(member);
    if (difficulty === '' && role === '' && provider === '' && model === '' && effort === '')
        return null;
    return (_jsxs("span", { className: css.routeKeyChip, "data-route-key": true, "data-monospace-label": true, title: [difficulty, role, provider, model, effort].filter((part) => part !== '').join(' / '), children: [difficulty !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "difficulty", children: difficulty }), role !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "role", children: role }), provider !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "provider", children: provider }), model !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "model", children: model }), effort !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "effort", children: effort })] }));
}
