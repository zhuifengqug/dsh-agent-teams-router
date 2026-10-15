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
import type { ArtifactSnapshot } from './types.ts';
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
    /** LLM provider paired with the configured member model. */
    memberLlmProvider?: string;
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
    /**
     * Provenance of the member's `provider`/`model`. The staged UI sends
     * `user` (the human picked it); the captain's tool path sends `captain`.
     */
    routeSource?: 'user' | 'captain' | null;
} | {
    action: 'update_task';
    taskId: string;
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
    /** Task presentation fields; absent fields leave the stored value untouched. */
    difficulty?: string | null;
    role?: string | null;
} | {
    action: 'add_task';
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
    difficulty?: string | null;
    role?: string | null;
} | {
    action: 'remove_task';
    taskId: string;
} | {
    action: 'remove_member';
    memberName: string;
};
/**
 * Task presentation fields shared by tool arguments and the Web staging surface.
 *
 * 2026-10-10 去路由：这里**不再有** provider/model/reasoning_effort。任务不再
 * 承载任何线路信息——模型只属于成员。
 */
export interface TaskRouteArguments {
    difficulty?: unknown;
    role?: unknown;
}
/**
 * Tool-argument descriptors for the task presentation fields (spread into parameters).
 *
 * Difficulty is a **presentation attribute**: it describes how hard the task is
 * and never selects a member's model.
 */
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
};
/**
 * 任务展示字段（难度 / 角色）的一次编辑。
 *
 * 2026-10-10 去路由后，任务不再承载任何线路信息：本结构只有展示字段，
 * 因此不再有 `route`/`routeSource` 的清除与派生语义。
 */
export interface TaskPresentationEdit {
    difficulty?: unknown;
    role?: unknown;
}
/**
 * Apply a presentation edit onto a task record.
 *
 * Absent fields leave the stored value untouched, so a partial edit can neither
 * reset difficulty nor silently drop the stored role. Illegal values raise
 * instead of falling back to a default: a model that wrote
 * `difficulty: "URGENT"` must be told, not silently stored as medium.
 *
 * 本函数**只写展示字段**：不再有线路解析，因此也不需要"让上一次解析失效"
 * ——那是去路由后已消失的概念。
 */
export declare function applyTaskPresentationEdit(task: TeamTask, edit: TaskPresentationEdit): void;
/**
 * Map the captain's `task_*` operation fields onto a presentation edit.
 *
 * Returns an empty object when the operation says nothing about difficulty or
 * role, so an unrelated edit (subject, assignee) leaves the stored values
 * untouched. `task_provider` / `task_model` / `task_reasoning_effort` were the
 * retired task-level route fields and are ignored here — tasks no longer carry
 * a route of their own.
 */
export declare function taskPresentationEditFrom(operation: {
    task_difficulty?: string | null;
    task_role?: string | null;
}): {
    difficulty?: string | null;
    role?: string | null;
};
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
export declare function applyQualityFollowUp(team: TeamState, closed: TeamTask, snapshotPaths?: (paths: readonly string[]) => ArtifactSnapshot): {
    created: TeamTask[];
    escalated: boolean;
    reason?: string;
    excludedFindings?: string[];
};
