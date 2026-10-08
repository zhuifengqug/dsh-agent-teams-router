/**
 * Pure route/cost presentation helpers (DESIGN D, step 7).
 *
 * Kept CSS-free and React-free so offline tests can import the tsc output
 * directly (`lib/client/route-details-model.js`), mirroring the
 * `activity-model.ts` pattern. The component half lives in
 * `RouteDetails.tsx`; see its module doc for the popover interaction rules.
 * @module dsh-agent-teams/client/route-details-model
 */
/** Pointer dwell before a popover opens (DESIGN D.3; copied, not tuned). */
export const POPOVER_OPEN_DELAY_MS = 100;
/** Close grace after the pointer leaves (DESIGN D.3; copied, not tuned). */
export const POPOVER_CLOSE_DELAY_MS = 100;
/** Skeleton shows this long before giving up and rendering an em dash (D.5). */
export const COST_SKELETON_GIVEUP_MS = 2000;
/** Mono `provider/model@effort` line; empty parts collapse away. */
export function routeLine(provider, model, effort) {
    const left = provider.trim();
    const right = model.trim();
    const base = left !== '' && right !== '' ? `${left}/${right}` : right !== '' ? right : left;
    const e = effort.trim();
    return base === '' ? (e === '' ? '' : `@${e}`) : e === '' ? base : `${base}@${e}`;
}
/**
 * Token-count formatting copied from the host chat `formatExactTokens` rule
 * (DESIGN D.5: labels and number formats mirror the host character for
 * character). The group separator is the host's literal `,` for both locales.
 */
export function formatTokensGrouped(value) {
    const negative = value < 0;
    const digits = String(Math.abs(Math.round(value)));
    const groups = [];
    for (let end = digits.length; end > 0; end -= 3)
        groups.unshift(digits.slice(Math.max(0, end - 3), end));
    return `${negative ? '-' : ''}${groups.join(',')}`;
}
/** One decimal, trailing `.0` trimmed (cost buckets are fractional). */
export function formatCostEstimate(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
/**
 * Member-row routeKey decomposition (B member view).
 *
 * The routeKey is `difficulty + normalizedRole + provider + model +
 * reasoning_effort`; the panel splits it into the D.4 five readable segments:
 * difficulty, role, provider, model, effort — mono `label-tertiary`.
 */
export function memberRouteKeyParts(member) {
    const provider = (member.provider ?? '').trim();
    const model = (member.model ?? '').trim();
    return {
        difficulty: (member.difficulty ?? '').trim(),
        role: (member.normalizedRole ?? member.role ?? '').trim(),
        provider,
        model,
        effort: (member.reasoningEffort ?? '').trim(),
    };
}
