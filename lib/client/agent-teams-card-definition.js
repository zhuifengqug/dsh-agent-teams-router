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
/** Mirror the host's Unicode key folding; the result metadata supplies exact ids. */
export function teamKeyFromName(name) {
    const cleaned = name.normalize('NFC').trim().toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned === '' ? 'team' : cleaned;
}
/** Parse the only create-call fields the historic card owns. */
export function parseAgentTeamsCreateArgs(value) {
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || typeof parsed.name !== 'string') {
            return undefined;
        }
        const name = parsed.name.trim();
        if (name === '')
            return undefined;
        return { teamId: teamKeyFromName(name), name };
    }
    catch {
        return undefined;
    }
}
/** Read the canonical identity the host attaches to a successful create result. */
export function parseAgentTeamsCreateResult(meta) {
    if (typeof meta !== 'object' || meta === null)
        return undefined;
    const record = meta;
    const teamId = typeof record.team_id === 'string' ? record.team_id.trim() : '';
    if (teamId === '')
        return undefined;
    const captainSessionId = typeof record.captain_session_id === 'string' ? record.captain_session_id.trim() : '';
    const members = [];
    if (Array.isArray(record.members)) {
        for (const entry of record.members) {
            if (typeof entry !== 'object' || entry === null)
                continue;
            const member = entry;
            const name = typeof member.name === 'string' ? member.name : '';
            if (name === '')
                continue;
            members.push({
                id: typeof member.id === 'string' ? member.id : '',
                name,
                role: typeof member.role === 'string' ? member.role : '',
            });
        }
    }
    return { teamId, captainSessionId, members };
}
/** Recover the host's canonical id from legacy running or staged result text. */
export function teamIdFromCreateResultText(text) {
    const created = [...text.matchAll(/" created \(id ([^()\s]+)\) under /gu)].at(-1)?.[1];
    if (created !== undefined && created !== '')
        return created;
    const stagedPath = [...text.matchAll(/plan created under (.+?)\. It is staged: /gu)].at(-1)?.[1];
    if (stagedPath === undefined)
        return undefined;
    const segment = stagedPath.split(/[\\/]/u).filter(part => part !== '').at(-1);
    return segment === undefined || segment === '' ? undefined : segment;
}
/** Concatenate the text blocks of one durable tool-result message. */
export function resultText(message) {
    return message.content
        .filter((block) => typeof block === 'object' && block !== null
        && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string')
        .map(block => block.text)
        .join("\n");
}
/** Durable first-party tool events folded into one keyed Chat node. */
export const agentTeamsCardDefinition = {
    kind: 'agent-teams',
    target: 'chat',
    match: (event) => {
        if (event.type === 'tool/call' && event.data.name === 'agent_teams_create') {
            return parseAgentTeamsCreateArgs(event.data.arguments) === undefined
                ? null
                : { id: String(event.data.callId), role: 'start' };
        }
        if (event.type === 'tool/result' && event.data.message.source.kind === 'tool') {
            return { id: String(event.data.message.source.callId), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'tool/call') {
            throw new Error('agent-teams card start requires agent_teams_create tool/call');
        }
        const parsed = parseAgentTeamsCreateArgs(match.event.data.arguments);
        if (parsed === undefined)
            throw new Error('agent-teams card start requires valid create arguments');
        return { ...parsed, accepted: false, captainSessionId: '', members: [] };
    },
    update: (context, match) => {
        if (match.event.type !== 'tool/result')
            return context.state;
        const failed = match.event.data.error !== undefined
            || toolResultFailed(match.event.data.message);
        if (failed)
            return context.state;
        const canonical = parseAgentTeamsCreateResult(match.event.data.meta);
        const legacyId = canonical === undefined
            ? teamIdFromCreateResultText(resultText(match.event.data.message))
            : undefined;
        if (canonical === undefined && legacyId === undefined)
            return { ...context.state, accepted: true };
        return {
            ...context.state,
            accepted: true,
            teamId: canonical?.teamId ?? legacyId ?? context.state.teamId,
            captainSessionId: canonical?.captainSessionId ?? '',
            members: canonical?.members ?? [],
        };
    },
    buildViewNode: (context) => {
        if (context.start === undefined)
            return null;
        const state = context.state;
        if (!state.accepted)
            return null;
        return {
            key: context.key,
            kind: 'agent-teams',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data: {
                teamId: state.teamId,
                captainSessionId: state.captainSessionId,
                teamName: state.name,
                members: state.members,
            },
        };
    },
};
/** V4 tool-role results carry isError directly; older logs nest tool-result blocks. */
export function toolResultFailed(message) {
    return message.isError === true || message.content.some(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool-result'
        && 'isError' in block && block.isError === true);
}
/** Keep summaries tied to the create turn, including multiple teams in one turn. */
export function teamCardsForTurn(nodes, turn) {
    return [...nodes].filter(node => node.kind === 'agent-teams'
        && (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn.turn === turn);
}
