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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityRouteAuditStep, ActivityTeam, ActivityTask } from './activity-monitor.ts'
import type { AgentTeamsLocaleKey, AgentTeamsTranslate } from './locales.ts'
import {
  POPOVER_CLOSE_DELAY_MS,
  POPOVER_OPEN_DELAY_MS,
  memberRouteKeyParts,
  routeLine,
} from './route-details-model.ts'
import css from './RouteDetails.module.css'

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

/**
 * Member row routeKey chip (B member view): the slot-identity segments the
 * member's own model badge does not already show, in mono `label-tertiary`.
 *
 * The member row already renders a compact model badge on the left, so the
 * `model` segment is intentionally left out here (2026-10-09 user decision:
 * one model label per row, not two). The full five-segment key stays in the
 * `title` and on the data attributes.
 */
export function MemberRouteKey({ member }: {
  readonly member: Parameters<typeof memberRouteKeyParts>[0]
}) {
  const parts = memberRouteKeyParts(member)
  const { difficulty, role, provider, model, effort } = parts
  const shown = [difficulty, role, provider, effort].filter((part) => part !== '')
  if (shown.length === 0) return null
  return (
    <span className={css.routeKeyChip} data-route-key data-monospace-label
      title={[difficulty, role, provider, model, effort].filter((part) => part !== '').join(' / ')}
      data-route-key-model={model === '' ? undefined : model}
    >
      {difficulty !== '' && <span className={css.routeKeySeg} data-route-key-seg="difficulty">{difficulty}</span>}
      {role !== '' && <span className={css.routeKeySeg} data-route-key-seg="role">{role}</span>}
      {provider !== '' && <span className={css.routeKeySeg} data-route-key-seg="provider">{provider}</span>}
      {effort !== '' && <span className={css.routeKeySeg} data-route-key-seg="effort">{effort}</span>}
    </span>
  )
}
