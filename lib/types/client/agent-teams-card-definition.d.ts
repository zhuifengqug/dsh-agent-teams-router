/**
 * AgentTeams conversation card: a lightweight in-conversation summary shown
 * when a team is created — the captain's name, the member roster with whale
 * avatars, and an entry point that re-activates the top-right activity
 * panel (useful after the floater was closed, or when re-opening an old
 * session for review).
 *
 * The fold anchors to the Harness's durable `tool/call` + `tool/result`
 * records for `agent_teams_create`. Those are first-party session events, so
 * the card survives restarts without writing an out-of-repo event type.
 * @module dsh-agent-teams/client/card
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client';
/** Final keyed Chat payload for the team summary card. */
export interface AgentTeamsCardData {
    readonly teamId: string;
    /** The captain session that owns this team (panel follows it). */
    readonly captainSessionId: string;
    readonly teamName: string;
    readonly members: readonly {
        readonly id: string;
        readonly name: string;
        readonly role: string;
    }[];
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap {
        /** Lightweight team summary card anchoring the conversation. */
        'agent-teams': AgentTeamsCardData;
    }
}
/** One roster row folded from the create result. */
export interface AgentTeamsCardMember {
    readonly id: string;
    readonly name: string;
    readonly role: string;
}
/** Folded team record (the node's business state). */
export interface AgentTeamsNodeState {
    readonly teamId: string;
    readonly name: string;
    readonly accepted: boolean;
    readonly captainSessionId: string;
    readonly members: readonly AgentTeamsCardMember[];
}
/** Canonical team identity published by the host in tool-result metadata. */
export interface AgentTeamsCreateIdentity {
    readonly teamId: string;
    readonly captainSessionId: string;
    readonly members: readonly AgentTeamsCardMember[];
}
/** Mirror the host's Unicode key folding; the result metadata supplies exact ids. */
export declare function teamKeyFromName(name: string): string;
/** Parse the only create-call fields the historic card owns. */
export declare function parseAgentTeamsCreateArgs(value: string): {
    teamId: string;
    name: string;
} | undefined;
/** Read the canonical identity the host attaches to a successful create result. */
export declare function parseAgentTeamsCreateResult(meta: unknown): AgentTeamsCreateIdentity | undefined;
/** Recover the host's canonical id from legacy running or staged result text. */
export declare function teamIdFromCreateResultText(text: string): string | undefined;
/** Concatenate the text blocks of one durable tool-result message. */
export declare function resultText(message: {
    readonly content: readonly unknown[];
}): string;
/** Durable first-party tool events folded into one keyed Chat node. */
export declare const agentTeamsCardDefinition: ConversationNodeDefinition<AgentTeamsNodeState>;
/** V4 tool-role results carry isError directly; older logs nest tool-result blocks. */
export declare function toolResultFailed(message: {
    readonly content: readonly unknown[];
    readonly isError?: boolean;
}): boolean;
/** Keep summaries tied to the create turn, including multiple teams in one turn. */
export declare function teamCardsForTurn(nodes: Iterable<ChatConversationViewNode>, turn: number): ChatConversationViewNode[];
