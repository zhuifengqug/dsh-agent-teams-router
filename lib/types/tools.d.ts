/**
 * The `agent_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code AgentTeams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-agent-teams/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type TeamState, type TeamTask } from './types.ts';
export { steerCaptainReport } from './members.ts';
/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
    /** State directory name under the captain's workspace. */
    stateDir: string;
    /** Member subagent provider name. */
    memberProvider: string;
    /** Optional member model override. */
    memberModel?: string;
    /** Prompt injected into member personas and assignments. */
    executionPrompt?: string;
    /** Plugin fallback route. */
    fallback?: import('./profiles.ts').TeamModelFallbackConfig;
    /** Member delegation depth cap. */
    memberMaxDepth?: number;
    /** Team size cap (members). */
    maxMembers: number;
    /** Named team profiles from the active DSH profile. */
    profiles: Record<string, import('./profiles.ts').TeamProfileConfig>;
}
/** Browser/UI mutations allowed while a plan is waiting for approval. */
export type StagedPlanMutation = {
    action: 'update_member';
    memberName: string;
    role?: string | null;
    provider: string;
    model: string;
    reasoningEffort?: string | null;
    executionPrompt?: string | null;
} | {
    action: 'update_task';
    taskId: string;
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
    /** Task routing intent; absent fields leave the stored value untouched. */
    difficulty?: string | null;
    role?: string | null;
    route?: {
        provider?: string | null;
        model?: string | null;
        reasoning_effort?: string | null;
    } | null;
    /**
     * Provenance of an explicit `route`. The staged UI sends `user`; the
     * captain's tool path always means `captain`. Absent means `captain`.
     */
    routeSource?: 'user' | 'captain' | null;
} | {
    action: 'add_task';
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
    difficulty?: string | null;
    role?: string | null;
    route?: {
        provider?: string | null;
        model?: string | null;
        reasoning_effort?: string | null;
    } | null;
    routeSource?: 'user' | 'captain' | null;
} | {
    action: 'remove_task';
    taskId: string;
} | {
    action: 'remove_member';
    memberName: string;
};
/**
 * Route shape shared by tool arguments and the Web staging surface.
 *
 * `provider` + `model` together are an **explicit** route request; supplying
 * only one of them is an error rather than a silent partial route.
 */
export interface TaskRouteArguments {
    difficulty?: unknown;
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    reasoning_effort?: unknown;
}
/** Tool-argument descriptors for the task routing fields (spread into parameters). */
export declare const TASK_ROUTE_PARAMETERS: {
    difficulty: {
        type: "string";
        enum: string[];
        description: string;
    };
    role: {
        type: "string";
        description: string;
    };
    provider: {
        type: "string";
        description: string;
    };
    model: {
        type: "string";
        description: string;
    };
    reasoning_effort: {
        type: "string";
        description: string;
    };
};
/**
 * What happens when a **user** hard route cannot be dispatched.
 *
 * - `block-approval` — the staged path. A human is looking at the plan and can
 *   still fix or clear the route, so the whole approval is rejected.
 * - `queue` — the automatic creation path. There is no approval moment and
 *   nobody to intervene, so failing the whole team creation over one route would
 *   be the wrong trade. The task is left undispatchable instead: `routeStatus`
 *   recorded, no `resolvedRoute`, reason recorded as a runtime event.
 */
export type UserRouteUnavailablePolicy = 'block-approval' | 'queue';
/**
 * Re-resolve every task's routing intent against the live model catalog.
 *
 * Runs inside the caller's team lock, **before** anything is frozen onto
 * `team.json` and before any member is spawned. Behaviour:
 *
 * - Value Router absent → returns immediately; the team keeps its original
 *   behaviour and nothing about routing is recorded.
 * - A task resolves → `routeStatus` / `routeResolvedSource` / `resolvedRoute` /
 *   `routeAudit` are recorded on the task.
 * - A task whose **user** hard route is unavailable → `block-approval` rejects
 *   the approval. That is the one case where a human must intervene; the plan
 *   must not be approved with a route that cannot be dispatched. `queue` cannot
 *   reject anything and records the reason instead.
 * - Any other unresolvable task → left `pending` with a queue reason recorded as
 *   a runtime event, because an empty tier must not block an otherwise valid
 *   plan. It is never downgraded and never silently given a different model.
 *
 * Rotation is allocated per difficulty in plan order, so two tasks on the same
 * tier land on different routes deterministically.
 */
export declare function revalidateTaskRoutes(ctx: Context, fresh: TeamState, options?: {
    userRouteUnavailable?: UserRouteUnavailablePolicy;
}): Promise<void>;
/**
 * Shape the roster so every resolved task has a member that can actually run it.
 *
 * The rules are the contract, not heuristics:
 * - **Same reuse key reuses a member.** Tasks are grouped by `memberReuseKey`
 *   (`difficulty · role · provider · model · reasoning_effort`) and one member
 *   serves the whole group. Two tasks that resolve to the same provider/model but
 *   declare different difficulties are therefore **two** groups, not one:
 *   difficulty is part of slot identity and the unit of in-tier rotation.
 * - **A different reuse key needs a separate member.** Two groups never share one.
 * - **At `maxMembers` the excess merely queues.** Those tasks keep their resolved
 *   route — never downgraded, never handed a different model — and get a
 *   `queueReason` the activity panel renders.
 *
 * A member the captain already assigned to a group's tasks is honoured first;
 * otherwise an idle member whose frozen `routeKey` matches is reused.
 */
export declare function planMemberSlots(fresh: TeamState, maxMembers: number): void;
/** The unique resolved route shared by a member's resolved tasks, when they agree. */
export declare function frozenRouteOf(team: TeamState, memberName: string): {
    provider: string;
    model: string;
    reasoning_effort: string;
    difficulty: string;
    normalizedRole: string;
} | undefined;
/**
 * Map the captain's `task_*` operation fields onto a routing edit.
 *
 * Returns an empty object when the operation says nothing about routing, so the
 * stored difficulty/role/route stay untouched (and their resolution and audit
 * trail survive an unrelated edit). Sending `task_provider` **and** `task_model`
 * both empty clears an existing explicit route.
 */
export declare function taskRouteEditFrom(operation: {
    task_difficulty?: string | null;
    task_role?: string | null;
    task_provider?: string | null;
    task_model?: string | null;
    task_reasoning_effort?: string | null;
}, label?: string): {
    difficulty?: string | null;
    role?: string | null;
    route?: {
        provider: string;
        model: string;
        reasoning_effort: string;
    } | null;
    routeSource?: 'user' | 'captain';
};
/**
 * A routing edit as it arrives from either the tool layer (flat provider/model
 * arguments) or the Web staging surface (a nested `route` object).
 *
 * `route === null` clears an existing explicit route; `route === undefined`
 * leaves it untouched. The same distinction applies to `difficulty` and `role`.
 */
export interface RouteEdit {
    difficulty?: unknown;
    role?: unknown;
    route?: {
        provider?: unknown;
        model?: unknown;
        reasoning_effort?: unknown;
    } | null;
    routeSource?: 'user' | 'captain' | null;
}
/**
 * Fold flat tool arguments into a `RouteEdit`.
 *
 * Returns `route: undefined` when neither provider nor model was supplied, and
 * `route: null` when the caller explicitly asked to clear the route. Supplying
 * only one of provider/model is a hard error: a half route would otherwise be
 * dropped somewhere downstream, which is exactly the kind of quiet failure this
 * plugin must not have.
 */
export declare function routeEditFromArguments(args: TaskRouteArguments): RouteEdit;
/**
 * Apply a routing edit onto a task record.
 *
 * Absent fields leave the stored value untouched, so a partial edit can neither
 * reset difficulty nor silently drop an existing explicit route. Illegal values
 * raise instead of falling back to a default: a model that wrote
 * `difficulty: "URGENT"` must be told, not silently routed as medium.
 *
 * Any edit also **invalidates the previous resolution** (`routeStatus` /
 * `routeResolvedSource` / the audit trail are replaced by a fresh `validate`
 * entry): a stale `resolved` must never survive an edit, or approval could
 * commit a route nobody revalidated.
 */
export declare function applyRouteEdit(task: TeamTask, edit: RouteEdit): void;
/** Runtime bridge shared by model-facing tools and the Web staging surface. */
export interface AgentTeamsRuntime {
    isPendingMember(agent: Agent): boolean;
    updateStagedPlan(captain: Agent, teamId: string, mutation: StagedPlanMutation, signal?: AbortSignal): Promise<TeamState>;
    updateStagedPlanBatch(captain: Agent, teamId: string, mutations: readonly StagedPlanMutation[], signal?: AbortSignal): Promise<TeamState>;
    approveStagedTeam(captain: Agent, teamId: string, signal?: AbortSignal): Promise<{
        teamId: string;
        members: number;
        tasks: number;
    }>;
    continueStagedPlanning(captain: Agent, teamId: string): Promise<{
        teamId: string;
        alreadyWaiting: boolean;
    }>;
    discardStagedTeam(captain: Agent, teamId: string): Promise<{
        teamId: string;
    }>;
}
export declare function haltTeamWork(input: {
    ctx: Context;
    stateRoot: string;
    teamId: string;
    captain: Agent;
    signal?: AbortSignal;
}): Promise<{
    teamName: string;
    cancelledTasks: number;
    alreadyHalted: boolean;
}>;
/** Web approval has no tool result in the captain's conversation. */
export declare function stagedPlanApprovedContext(teamName: string): string;
/** Context queued after the human rejects a staged plan. */
export declare function stagedPlanDiscardContext(teamName: string): string;
/** Model-facing continuation that turns the review UI back into a conversation. */
export declare function stagedPlanFeedbackContext(teamName: string): string;
/**
 * Register every `agent_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 */
export declare function registerAgentTeamsTools(ctx: Context, config: ToolsConfig): AgentTeamsRuntime;
export declare function applyQualityFollowUp(team: TeamState, closed: TeamTask): {
    created: TeamTask[];
    escalated: boolean;
};
