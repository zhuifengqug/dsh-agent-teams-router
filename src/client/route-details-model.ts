/**
 * Pure route presentation helpers.
 *
 * Kept CSS-free and React-free so offline tests can import the tsc output
 * directly (`lib/client/route-details-model.js`), mirroring the
 * `activity-model.ts` pattern. The component half lives in
 * `RouteDetails.tsx`.
 *
 * 2026-10-10 去路由：成员侧的 `memberRouteKeyParts` 已随「成员线路键」概念一起
 * 退役（成员不再有 difficulty/role/provider/model/effort 五段键）。保留的
 * `routeLine` 只服务于**旧团队**遗留审计轨迹的只读展示。
 * @module dsh-agent-teams/client/route-details-model
 */

/** Pointer dwell before a popover opens (DESIGN D.3; copied, not tuned). */
export const POPOVER_OPEN_DELAY_MS = 100
/** Close grace after the pointer leaves (DESIGN D.3; copied, not tuned). */
export const POPOVER_CLOSE_DELAY_MS = 100

/** Mono `provider/model@effort` line; empty parts collapse away. */
export function routeLine(provider: string, model: string, effort: string): string {
  const left = provider.trim()
  const right = model.trim()
  const base = left !== '' && right !== '' ? `${left}/${right}` : right !== '' ? right : left
  const e = effort.trim()
  return base === '' ? (e === '' ? '' : `@${e}`) : e === '' ? base : `${base}@${e}`
}
