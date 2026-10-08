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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityCostSummary, ActivityRouteAuditStep, ActivityTeam, ActivityTask } from './activity-monitor.ts'
import type { AgentTeamsLocaleKey, AgentTeamsTranslate } from './locales.ts'
import css from './RouteDetails.module.css'

/** Pointer dwell before a popover opens (DESIGN D.3; copied, not tuned). */
export const POPOVER_OPEN_DELAY_MS = 100
/** Close grace after the pointer leaves (DESIGN D.3; copied, not tuned). */
export const POPOVER_CLOSE_DELAY_MS = 100
/** Skeleton shows this long before giving up and rendering an em dash (D.5). */
export const COST_SKELETON_GIVEUP_MS = 2000

/** Single shared open popover: a non-empty key replaces the previous card. */
let openPopoverKey: string | null = null
const popoverListeners = new Set<() => void>()

function publishPopoverKey(next: string | null): void {
  if (openPopoverKey === next) return
  openPopoverKey = next
  for (const listener of popoverListeners) listener()
}

function subscribePopoverKey(listener: () => void): () => void {
  popoverListeners.add(listener)
  return () => { popoverListeners.delete(listener) }
}

function readPopoverKey(): string | null {
  return openPopoverKey
}

/** Shared 100 ms dwell / 100 ms grace / one-card-at-a-time controller. */
function useExclusivePopover(popoverKey: string): {
  readonly open: boolean
  readonly enter: () => void
  readonly leave: () => void
} {
  const [open, setOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTimerKey = useRef<string | null>(null)
  useEffect(() => subscribePopoverKey(() => {
    if (openPopoverKey === popoverKey || openPopoverKey === null) return
    setOpen(false)
  }), [popoverKey])
  useEffect(() => () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
  }, [])
  const enter = useCallback((): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (openTimerKey.current === popoverKey) return
    openTimerKey.current = popoverKey
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      publishPopoverKey(popoverKey)
      setOpen(true)
    }, POPOVER_OPEN_DELAY_MS)
  }, [popoverKey])
  const leave = useCallback((): void => {
    openTimerKey.current = null
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
      if (openPopoverKey === popoverKey) publishPopoverKey(null)
    }, POPOVER_CLOSE_DELAY_MS)
  }, [popoverKey])
  return { open, enter, leave }
}

function popoverPointerProps(open: boolean, enter: () => void, leave: () => void): {
  readonly onPointerEnter: () => void
  readonly onPointerLeave: () => void
  readonly 'data-open'?: boolean
} {
  return { onPointerEnter: enter, onPointerLeave: leave, 'data-open': open || undefined }
}

/** aria-label/`title` carry the same fact for keyboards and screen readers. */
function auditTriggerLabel(task: ActivityTask, t: AgentTeamsTranslate): string {
  const total = task.routeAudit === undefined ? 0 : task.routeAudit.total
  return `${t('route.auditTitle')} · ${t('route.auditSteps', { count: total })}`
}

/** Mono `provider/model@effort` line; empty parts collapse away. */
export function routeLine(provider: string, model: string, effort: string): string {
  const left = provider.trim()
  const right = model.trim()
  const base = left !== '' && right !== '' ? `${left}/${right}` : right !== '' ? right : left
  const e = effort.trim()
  return base === '' ? (e === '' ? '' : `@${e}`) : e === '' ? base : `${base}@${e}`
}

/** The four difficulty tiers keep their host task-badge look (D.4/D.5). */
export function difficultyBadge(task: ActivityTask, t: AgentTeamsTranslate): React.ReactNode {
  if (task.difficulty === undefined) return null
  return (
    <span
      className={css.difficultyBadge}
      data-difficulty={task.difficulty}
      title={t('task.route.difficulty', { difficulty: task.difficulty })}
    >
      {task.difficulty}
    </span>
  )
}

/** D.4 step coloring: neutral / business / error / caption only. */
function stepTone(step: ActivityRouteAuditStep): string {
  switch (step.step) {
    case 'tier-degrade': return 'business'
    case 'fallback': return 'businessStrong'
    case 'route-rejected':
    case 'blocked': return 'error'
    case 'pending': return 'pending'
    default: return 'neutral'
  }
}

/** Render one audit step row; the trailing route chip mirrors the D.4 table. */
function auditStepRow(step: ActivityRouteAuditStep, index: number, t: AgentTeamsTranslate): React.ReactNode {
  const tone = stepTone(step)
  const route = step.route
  const routeText = route === undefined
    ? ''
    : routeLine(route.provider ?? '', route.model ?? '', route.reasoning_effort ?? '')
  return (
    <div className={css.auditRow} data-tone={tone} key={`${step.at}:${step.step}:${index}`}>
      <span className={css.auditIndex} aria-hidden>{index + 1}</span>
      <span className={css.auditRowBody}>
        <span className={css.auditStepName}>
          <span className={css.auditStep}>{step.step}</span>
          {step.outcome !== '' && <span className={css.auditOutcome}>{step.outcome}</span>}
        </span>
        {step.detail !== '' && <span className={css.auditDetail}>{step.detail}</span>}
        {routeText !== '' && <span className={css.auditRoute}>{routeText}</span>}
        {tone === 'pending' && step.detail === '' && (
          <span className={css.auditDetail}>{t('route.auditPendingDetail')}</span>
        )}
      </span>
    </div>
  )
}

/** Route audit popover (B): read-only D.3 card listing the bounded steps. */
export function RouteAuditPopover({ task, t, popoverKey }: {
  readonly task: ActivityTask
  readonly t: AgentTeamsTranslate
  readonly popoverKey: string
}) {
  const audit = task.routeAudit
  const { open, enter, leave } = useExclusivePopover(popoverKey)
  if (audit === undefined || audit.entries.length === 0) return null
  return (
    <span className={css.auditAnchor} {...popoverPointerProps(open, enter, leave)}>
      <span className={css.auditTrigger} role="img" aria-label={auditTriggerLabel(task, t)} title={auditTriggerLabel(task, t)} data-audit-trigger>
        {t('route.auditTrigger', { count: audit.total })}
        {audit.truncated > 0 && <span className={css.auditTruncated}>{t('route.auditTruncated', { count: audit.truncated })}</span>}
      </span>
      {open && (
        <span className={css.popoverCard} data-popover="route-audit" data-audit-popover role="group" aria-label={t('route.auditTitle')}>
          <span className={css.popoverHeading}>{t('route.auditTitle')}</span>
          <span className={css.popoverList}>
            {audit.entries.map((step, index) => auditStepRow(step, index, t))}
          </span>
        </span>
      )}
    </span>
  )
}

/** Number formatting copied from the host chat rules (D.5: character-identical). */
export function formatTokensGrouped(value: number): string {
  const negative = value < 0
  const digits = String(Math.abs(Math.round(value)))
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
  return `${negative ? '-' : ''}${groups.join(',')}`
}

/** One decimal, trailing `.0` trimmed (cost buckets are fractional). */
function formatCostEstimate(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function costMetricText(metric: { value: number } | undefined, cost: boolean): string | null {
  if (metric === undefined) return null
  return cost ? formatCostEstimate(metric.value) : formatTokensGrouped(metric.value)
}

/** Cost popover (C.1): the same D.3 card listing the per-member rows. */
export function CostPopover({ cost, t, popoverKey }: {
  readonly cost: ActivityCostSummary
  readonly t: AgentTeamsTranslate
  readonly popoverKey: string
}) {
  const { open, enter, leave } = useExclusivePopover(popoverKey)
  const members = cost.members ?? []
  return (
    <span className={css.auditAnchor} {...popoverPointerProps(open, enter, leave)}>
      <span
        className={css.auditTrigger}
        role="img"
        aria-label={t('cost.popoverAria')}
        title={t('cost.popoverAria')}
        data-cost-trigger
      >
        {t('cost.membersDetail', { count: members.length })}
      </span>
      {open && (
        <span className={css.popoverCard} data-popover="team-cost" data-cost-popover role="group" aria-label={t('cost.popoverAria')}>
          <span className={css.popoverHeading}>{t('cost.popoverTitle')}</span>
          <span className={css.popoverList}>
            {members.map((member) => (
              <div className={css.costRow} key={member.memberId || member.memberName} data-member-cost>
                <span className={css.costRowName}>{member.memberName}</span>
                <span className={css.costRowBuckets}>
                  {(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const).map((bucket) => {
                    const text = costMetricText(member.reading?.[bucket], false)
                    if (text === null) return null
                    return (
                      <span className={css.costBucket} key={bucket}>
                        <span className={css.costBucketLabel}>{t(`cost.bucket.${bucket}` as AgentTeamsLocaleKey)}</span>
                        <span className={css.costBucketValue}>{text}</span>
                      </span>
                    )
                  })}
                  {(() => {
                    const text = costMetricText(member.reading?.costEstimate, true)
                    if (text === null) return null
                    return (
                      <span className={css.costBucket} data-bucket-cost>
                        <span className={css.costBucketLabel}>{t('cost.bucket.costEstimate')}</span>
                        <span className={css.costBucketValue}>{text}</span>
                      </span>
                    )
                  })()}
                  {member.attributedSubsessions !== undefined && member.attributedSubsessions > 0 && (
                    <span className={css.costBucket}>
                      <span className={css.costBucketLabel}>{t('cost.bucket.subsessions')}</span>
                      <span className={css.costBucketValue}>{formatTokensGrouped(member.attributedSubsessions)}</span>
                    </span>
                  )}
                </span>
                <span className={css.costRowSource}>{t('cost.source.label', { source: cost.source ?? '' })}</span>
              </div>
            ))}
          </span>
        </span>
      )}
    </span>
  )
}

/**
 * Headline cost cell (C.1): a team-total figure in the panel/team header.
 *
 * States: `ok` → real number; `no-data`/missing → a 37px pulsing skeleton that
 * gives up after 2 s and becomes an em dash; never a fabricated zero.
 */
export function TeamCostCell({ cost, t }: {
  readonly cost: ActivityTeam['cost']
  readonly t: AgentTeamsTranslate
}) {
  const giveUp = cost?.status !== 'ok'
  const [skeletonEnded, setSkeletonEnded] = useState(giveUp ? COST_SKELETON_GIVEUP_MS : 0)
  useEffect(() => {
    if (cost?.status === 'ok') return
    setSkeletonEnded(COST_SKELETON_GIVEUP_MS)
    const timer = setTimeout(() => setSkeletonEnded(COST_SKELETON_GIVEUP_MS + 1), COST_SKELETON_GIVEUP_MS)
    return () => clearTimeout(timer)
  }, [cost])
  const totals = cost?.status === 'ok' ? cost.totals : undefined
  const totalText = costMetricText(totals?.costEstimate, true) ?? costMetricText(totals?.inputTokens, false)
  if (cost?.status === 'ok' && totalText !== null) {
    return (
      <span className={css.costCell} data-cost-state="ok" title={t('cost.source.label', { source: cost.source ?? '' })}>
        <span className={css.costCellLabel}>{t('cost.summaryLabel')}</span>
        <span className={css.costCellValue}>{totalText}</span>
      </span>
    )
  }
  if (skeletonEnded <= COST_SKELETON_GIVEUP_MS) {
    return <span className={css.costCellSkeleton} data-cost-state="skeleton" aria-label={t('cost.skeletonAria')} />
  }
  return (
    <span className={css.costCellNoData} data-cost-state="no-data" title={cost?.reason ?? t('cost.noDataFallback')}>
      {t('cost.noDataMark')}
    </span>
  )
}

/** Mono `difficulty · role · provider/model@effort` route-key decomposition. */
export function memberRouteKeyParts(member: {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly difficulty?: string
  readonly normalizedRole?: string
  readonly role?: string
}): { readonly difficulty: string; readonly role: string; readonly route: string } {
  const role = (member.normalizedRole ?? member.role ?? '').trim()
  return {
    difficulty: (member.difficulty ?? '').trim(),
    role,
    route: routeLine(member.provider ?? '', member.model ?? '', member.reasoningEffort ?? ''),
  }
}

/**
 * Member row routeKey chip (B member view): five segments in mono
 * `label-tertiary`, hidden entirely when the member has no frozen key parts.
 */
export function MemberRouteKey({ member }: {
  readonly member: Parameters<typeof memberRouteKeyParts>[0]
}) {
  const { difficulty, role, route } = memberRouteKeyParts(member)
  if (difficulty === '' && role === '' && route === '') return null
  return (
    <span className={css.routeKeyChip} data-route-key data-monospace-label>
      {difficulty !== '' && <span className={css.routeKeySeg}>{difficulty}</span>}
      {role !== '' && <span className={css.routeKeySeg}>{role}</span>}
      {route !== '' && <span className={css.routeKeySeg}>{route}</span>}
    </span>
  )
}
