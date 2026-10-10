import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { POPOVER_CLOSE_DELAY_MS, POPOVER_OPEN_DELAY_MS, memberRouteKeyParts, routeLine, } from "./route-details-model.js";
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
/**
 * Member row routeKey chip (B member view): the slot-identity segments the
 * member's own model badge does not already show, in mono `label-tertiary`.
 *
 * The member row already renders a compact model badge on the left, so the
 * `model` segment is intentionally left out here (2026-10-09 user decision:
 * one model label per row, not two). The full five-segment key stays in the
 * `title` and on the data attributes.
 */
export function MemberRouteKey({ member }) {
    const parts = memberRouteKeyParts(member);
    const { difficulty, role, provider, model, effort } = parts;
    const shown = [difficulty, role, provider, effort].filter((part) => part !== '');
    if (shown.length === 0)
        return null;
    return (_jsxs("span", { className: css.routeKeyChip, "data-route-key": true, "data-monospace-label": true, title: [difficulty, role, provider, model, effort].filter((part) => part !== '').join(' / '), "data-route-key-model": model === '' ? undefined : model, children: [difficulty !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "difficulty", children: difficulty }), role !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "role", children: role }), provider !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "provider", children: provider }), effort !== '' && _jsx("span", { className: css.routeKeySeg, "data-route-key-seg": "effort", children: effort })] }));
}
