/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member. A resident member that becomes idle while it
 * still owns an open attempt is parked: only an explicit captain reassignment
 * may rotate that capability. Automatic retry is reserved for cold recovery,
 * when this process has not observed the durable owner settle its open attempt.
 * @module dsh-agent-teams/scheduler
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TeamTask } from './types.ts';
/** Per-dependency output cap in the assignment prompt. */
export declare const DEPENDENCY_OUTPUT_MAX_CHARS = 2000;
/** Combined dependency-output budget in the assignment prompt. */
export declare const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12000;
/**
 * Sliding no-progress window before a stalled capability may be recovered.
 *
 * This is a *progress* window, not a deadline: any observed progress (a running
 * edge, a fresh dispatch, a member that settles its own attempt) resets it, so a
 * legitimately long turn is never rotated by elapsed time alone. The window only
 * starts once the member has stopped being observed as running.
 */
export declare const NO_PROGRESS_WINDOW_MS = 120000;
/** Automatic recoveries allowed per task generation; beyond this only a captain rotates it. */
export declare const MAX_AUTO_RECOVERIES = 2;
/**
 * How often the sliding window is re-evaluated.
 *
 * Every scheduler decision is event-driven, but a stall produces no event: the
 * member already went quiet. Without a sweep the window could only ever be
 * checked during unrelated activity, so a wedged task might wait indefinitely.
 * The sweep is bounded (one sweep for the whole team) and only ever frees a
 * stalled capability; the normal dispatch path does the actual work.
 */
export declare const NO_PROGRESS_SWEEP_MS = 30000;
export interface SchedulerConfig {
    readonly stateDir: string;
    readonly executionPrompt?: string;
    readonly dispatch?: (captain: Agent, teamId: string, memberName: string, text: string, signal: AbortSignal, mode: 'queue' | 'steer', attemptId?: string) => Promise<boolean>;
}
export interface TeamScheduler {
    /** Try to give every genuinely idle/ready member one unit of ready work. */
    kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>;
    /** Try to flush fallback mail or give one member one ready task. */
    kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>;
}
/** One completed recursive dependency shown to the assignee. */
export interface DependencyOutput {
    readonly id: string;
    readonly subject: string;
    readonly profileSeedId?: string;
    readonly output?: string;
}
export interface DispatchTicket {
    readonly taskId: string;
    readonly memberName: string;
    readonly memberId: string;
    readonly attempt: number;
    readonly attemptId: string;
    readonly previousAssignee?: string;
    /** True when this ticket rotates an unobserved durable open attempt. */
    readonly recoveredOwned: boolean;
    /** Original task generation, used to restore a failed automatic recovery. */
    readonly previousStatus?: 'claimed' | 'in_progress';
    readonly previousAttempt?: number;
    readonly previousAttemptId?: string;
    readonly previousResult?: Pick<TeamTask, 'output' | 'verdict' | 'findings' | 'changedPaths' | 'acceptanceResults' | 'commandsRun' | 'evidenceAttemptId'>;
    readonly subject: string;
    readonly description?: string;
    readonly teamDescription?: string;
    readonly profileProtocol?: string;
    readonly profileSeedId?: string;
    readonly dependencyOutputs: readonly DependencyOutput[];
    readonly executionPrompt?: string;
    readonly kind?: string;
    readonly round?: number;
    readonly objective?: string;
    readonly inScope?: readonly string[];
    readonly outOfScope?: readonly string[];
    readonly acceptance?: readonly string[];
    readonly verify?: readonly string[];
    readonly reviewedTaskId?: string;
}
/**
 * Recursively collect `status=completed` ancestors of `taskId` in topological
 * order (dependencies before dependents). Cycles stop that branch only.
 */
export declare function collectCompletedDependencyOutputs(tasks: readonly TeamTask[], taskId: string, warn?: (message: string) => void): DependencyOutput[];
/** Format completed-dependency outputs with per-item and total truncation. */
export declare function formatDependencyOutputs(items: readonly DependencyOutput[]): string;
export declare function nextReadyTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined;
export declare function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string;
/** Install one scheduler and its member activity observer. */
export declare function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler;
