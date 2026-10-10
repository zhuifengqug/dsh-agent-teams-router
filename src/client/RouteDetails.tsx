/**
 * Legacy route-audit presentation.
 *
 * 2026-10-10 去路由后本插件不再产生任何审计条目；本模块保留的唯一用途是让
 * **旧团队**磁盘上已有的审计轨迹仍可在面板里读出来（历史可读，不再新增）。
 * 新任务的 `routeAudit` 一律不存在，因此这些组件对新团队不渲染任何内容。
 *
 * Pure helpers (timing constants, `routeLine`) live in
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
