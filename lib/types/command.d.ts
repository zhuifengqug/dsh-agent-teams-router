import type { Context } from '@deepseek-ai/cordis';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import { type TeamProfileConfig } from './profiles.ts';
export declare const AGENT_TEAMS_COMMAND = "agent-teams";
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'agent-teams-command': {
            readonly kind: 'agent-teams-command';
            readonly goal?: string;
            readonly profile?: string;
            readonly agency?: string;
        };
    }
}
/**
 * One parsed activation line. `profile` comes from `profiles.ts`; `agency` is
 * this file's own `--agency` flag and lives here rather than upstream because
 * the agency bridge is optional and must not change that module's shape.
 */
export interface AgentTeamsInvocationWithAgency {
    goal: string;
    profile?: string;
    agency?: string;
}
/**
 * Convert a configured profile key into a stable, closed-namespace command
 * suffix. Only lowercase ASCII letters, digits and dashes are representable;
 * this deliberately prevents accidental command aliases for ambiguous profile
 * names such as `foo bar`, `foo_bar`, or non-ASCII keys.
 */
export declare function profileCommandName(profileName: string): string | undefined;
/**
 * Split a `/agent-teams` tail into flags and the remaining goal.
 *
 * `--profile` keeps its upstream parser (including its own errors);
 * `--agency` is recognized here. **The two are mutually exclusive** — the
 * roster has exactly one owner (DESIGN.md A.2 conflict matrix).
 */
export declare function parseAgentTeamsLine(rawInput: string): AgentTeamsInvocationWithAgency;
export declare function invokedAgentTeamsInvocation(messages: readonly UserMessage[], getProfiles?: () => Record<string, TeamProfileConfig>): AgentTeamsInvocationWithAgency | undefined;
export declare function invokedAgentTeamsGoal(messages: readonly UserMessage[]): string | undefined;
export declare function buildActivationDirective(goal: string, profile?: string, taskPlanning?: 'captain' | 'seed', agency?: string): string;
export declare function registerAgentTeamsCommand(ctx: Context, getProfiles?: () => Record<string, TeamProfileConfig>): void;
export declare function installAgentTeamsGestureBoundary(ctx: Context, getProfiles?: () => Record<string, TeamProfileConfig>): void;
