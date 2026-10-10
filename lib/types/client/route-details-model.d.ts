/**
 * Pure route presentation helpers (DESIGN D, step 7).
 *
 * Kept CSS-free and React-free so offline tests can import the tsc output
 * directly (`lib/client/route-details-model.js`), mirroring the
 * `activity-model.ts` pattern. The component half lives in
 * `RouteDetails.tsx`; see its module doc for the popover interaction rules.
 * @module dsh-agent-teams/client/route-details-model
 */
/** Pointer dwell before a popover opens (DESIGN D.3; copied, not tuned). */
export declare const POPOVER_OPEN_DELAY_MS = 100;
/** Close grace after the pointer leaves (DESIGN D.3; copied, not tuned). */
export declare const POPOVER_CLOSE_DELAY_MS = 100;
/** Mono `provider/model@effort` line; empty parts collapse away. */
export declare function routeLine(provider: string, model: string, effort: string): string;
/**
 * Member-row routeKey decomposition (B member view).
 *
 * The routeKey is `difficulty + normalizedRole + provider + model +
 * reasoning_effort`; the panel splits it into the D.4 five readable segments:
 * difficulty, role, provider, model, effort — mono `label-tertiary`.
 */
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
    readonly provider: string;
    readonly model: string;
    readonly effort: string;
};
