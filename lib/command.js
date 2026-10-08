import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { parseProfileInvocation, resolveProfileTaskPlanning } from "./profiles.js";
export const AGENT_TEAMS_COMMAND = 'agent-teams';
const PROFILE_COMMAND_PREFIX = `${AGENT_TEAMS_COMMAND}-`;
const GESTURE = /^\/agent-teams(?=$|[\t\n\r ])/u;
/**
 * Convert a configured profile key into a stable, closed-namespace command
 * suffix. Only lowercase ASCII letters, digits and dashes are representable;
 * this deliberately prevents accidental command aliases for ambiguous profile
 * names such as `foo bar`, `foo_bar`, or non-ASCII keys.
 */
export function profileCommandName(profileName) {
    const normalized = profileName.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized))
        return undefined;
    return `${PROFILE_COMMAND_PREFIX}${normalized}`;
}
/** Resolve a profile command only when it maps uniquely to a live profile. */
function profileForCommand(commandName, profiles) {
    const matches = Object.keys(profiles).filter((profileName) => profileCommandName(profileName) === commandName);
    return matches.length === 1 ? matches[0] : undefined;
}
/**
 * Walk the front of an activation line and eat a standalone `--agency` flag.
 *
 * Same three shapes as the upstream `--profile` flag (`--agency x`,
 * `--agency=x`, `agency=x`); the first ordinary token stops the scan so a
 * mid-sentence `agency=` stays in the goal.
 */
function parseLeadingAgencyFlag(token, nextToken) {
    if (token === '--agency') {
        if (nextToken === undefined)
            throw new Error('--agency flag is missing a team id or name');
        return { name: readAgencyToken(nextToken), consumed: 2 };
    }
    if (token.startsWith('--agency='))
        return { name: readAgencyToken(token.slice('--agency='.length)), consumed: 1 };
    if (token.startsWith('agency='))
        return { name: readAgencyToken(token.slice('agency='.length)), consumed: 1 };
    return undefined;
}
function readAgencyToken(raw) {
    // One matching quote pair is stripped, exactly like the profile flag does.
    const name = raw.length >= 2 && raw.at(0) === raw.at(-1) && (raw.at(0) === '"' || raw.at(0) === "'")
        ? raw.slice(1, -1).trim()
        : raw.trim();
    if (name === '')
        throw new Error('--agency flag is missing a team id or name');
    return name;
}
/** Parse the generic command or one generated profile alias, plus `--agency`. */
function parseCommandText(text, profiles) {
    const trimmed = text.trimStart();
    if (GESTURE.test(trimmed))
        return parseAgentTeamsLine(trimmed.slice(AGENT_TEAMS_COMMAND.length + 1).trim());
    if (!trimmed.startsWith(`/${PROFILE_COMMAND_PREFIX}`))
        return undefined;
    const tokenEnd = trimmed.search(/[\t\n\r ]/u);
    const commandName = trimmed.slice(1, tokenEnd === -1 ? undefined : tokenEnd);
    const profile = profileForCommand(commandName, profiles);
    if (profile === undefined)
        return undefined;
    return { profile, goal: (tokenEnd === -1 ? '' : trimmed.slice(tokenEnd)).trim() };
}
/**
 * Split a `/agent-teams` tail into flags and the remaining goal.
 *
 * `--profile` keeps its upstream parser (including its own errors);
 * `--agency` is recognized here. **The two are mutually exclusive** — the
 * roster has exactly one owner (DESIGN.md A.2 conflict matrix).
 */
export function parseAgentTeamsLine(rawInput) {
    const trimmed = rawInput.trim();
    const tokens = trimmed === '' ? [] : trimmed.split(/\s+/u);
    // Pass 1: eat every leading `--agency` flag.
    let index = 0;
    let agency;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === undefined)
            break;
        const parsed = parseLeadingAgencyFlag(token, tokens[index + 1]);
        if (parsed === undefined)
            break;
        if (agency !== undefined)
            throw new Error('duplicate AgentTeams agency flag');
        agency = parsed.name;
        index += parsed.consumed;
    }
    // Pass 2: the remainder goes to the upstream `--profile` parser unchanged.
    const parsed = parseProfileInvocation(tokens.slice(index).join(' '));
    // Pass 3: a line that leads with `--profile` may still carry a trailing
    // `--agency`; pull it off the goal so either order is rejected identically.
    // Duplicates can no longer appear here — pass 1 already refused a second one.
    if (agency === undefined && parsed.goal !== '') {
        const rest = parsed.goal.split(/\s+/u);
        const head = rest[0];
        const trailing = head === undefined ? undefined : parseLeadingAgencyFlag(head, rest[1]);
        if (trailing !== undefined) {
            agency = trailing.name;
            parsed.goal = rest.slice(trailing.consumed).join(' ');
            const second = rest[trailing.consumed];
            if (second !== undefined && parseLeadingAgencyFlag(second, rest[trailing.consumed + 1]) !== undefined) {
                throw new Error('duplicate AgentTeams agency flag');
            }
        }
    }
    if (parsed.profile !== undefined && agency !== undefined) {
        throw new Error('choose either --profile or --agency — the roster has one owner');
    }
    return agency === undefined ? parsed : { goal: parsed.goal, agency };
}
export function invokedAgentTeamsInvocation(messages, getProfiles = () => ({})) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === undefined || message.source.kind !== 'user')
            continue;
        for (const block of message.content) {
            if (block.type !== 'text')
                continue;
            const invocation = parseCommandText(block.text, getProfiles());
            if (invocation !== undefined)
                return invocation;
        }
    }
    return undefined;
}
export function invokedAgentTeamsGoal(messages) {
    return invokedAgentTeamsInvocation(messages)?.goal;
}
export function buildActivationDirective(goal, profile, taskPlanning = 'seed', agency) {
    const lines = [
        'The user invoked an AgentTeams slash command. Follow the AgentTeams protocol already in your system instructions. Inspect existing team state with agent_teams_status when needed.',
        'Respect the current team state. Continue an existing plan or team without recreating it. Only when no current team exists, call agent_teams_create with approval="required". Build the complete staged roster and DAG, then stop and ask the user to review the Web plan. Do not approve or start it in this same turn.',
    ];
    // An agency roster arrives with the whole roster already decided, and its
    // coordinator briefing comes back in the create response for the captain to
    // adopt. If the bridge is unavailable, create rejects the parameter with its
    // own reason — nothing here needs to pre-check that.
    if (agency !== undefined) {
        lines.push(`Use agencyTeam="${agency}" when creating a new team; it supplies the whole roster.`, 'Do not pass profile or plan.members alongside it, and do not recreate those members yourself.', 'Adopt the agency coordinator briefing that create returns (coordinator / constraints / delivery_requirements) when you judge member reports and synthesize the result.');
    }
    if (profile !== undefined) {
        lines.push(`Use profile="${profile}" when creating a new team.`);
        if (taskPlanning === 'captain') {
            lines.push('This profile supplies the roster and guardrails. After create, do not recreate members.', 'Derive the smallest useful task graph from the goal while the team is staged; do not ask the user whether to split, merge, serialize, or parallelize.', 'Independent supplemental work must become separate ready tasks so idle members can run in parallel. Add dependencies only for genuine prerequisites and later synthesis.');
        }
        else {
            lines.push('Do not recreate the same members or seed tasks manually.');
        }
    }
    lines.push(goal === '' ? 'The goal was not given — ask the user what the team should accomplish.' : `Goal: ${goal}`);
    return lines.join('\n');
}
export function registerAgentTeamsCommand(ctx, getProfiles = () => ({})) {
    ctx.effect(() => {
        const dispose = [];
        dispose.push(ctx.commands.register({
            name: AGENT_TEAMS_COMMAND,
            description: 'run a goal with a multi-agent team (you become the captain)',
            input: { hint: '[--profile <name> | --agency <team>] <goal>' },
            handler(invocation) {
                let parsed;
                try {
                    parsed = parseAgentTeamsLine(invocation.rawInput.trim());
                }
                catch (error) {
                    return { kind: 'error', text: String(error) };
                }
                if (parsed.profile !== undefined && !Object.keys(getProfiles()).some(key => key.trim() === parsed.profile))
                    return { kind: 'error', text: `unknown AgentTeams profile "${parsed.profile}"` };
                if (parsed.profile === undefined && parsed.agency === undefined && parsed.goal === '')
                    return { kind: 'error', text: `Usage: /${AGENT_TEAMS_COMMAND} [--profile <name> | --agency <team>] <goal>` };
                invocation.agent.followup(createUserMessage({ content: [{ type: 'text', text: `/${AGENT_TEAMS_COMMAND}${invocation.rawInput}` }], source: { kind: 'user' } }));
                const suffix = parsed.agency !== undefined
                    ? ` with agency team ${parsed.agency}`
                    : parsed.profile === undefined ? '' : ` with profile ${parsed.profile}`;
                return { kind: 'success', text: `AgentTeams activated${suffix} — the captain will assemble the team.` };
            },
        }));
        for (const profileName of Object.keys(getProfiles())) {
            const commandName = profileCommandName(profileName);
            if (commandName === undefined)
                continue;
            dispose.push(ctx.commands.register({
                name: commandName,
                description: `run a goal with the AgentTeams ${profileName} profile`,
                input: { hint: '<goal>' },
                handler(invocation) {
                    const profile = profileForCommand(commandName, getProfiles());
                    if (profile === undefined)
                        return { kind: 'error', text: `AgentTeams profile command "/${commandName}" is unavailable` };
                    invocation.agent.followup(createUserMessage({ content: [{ type: 'text', text: `/${commandName}${invocation.rawInput}` }], source: { kind: 'user' } }));
                    return { kind: 'success', text: `AgentTeams activated with profile ${profile} — the captain will assemble the team.` };
                },
            }));
        }
        return () => {
            for (const unregister of dispose.reverse())
                unregister();
        };
    }, 'agent-teams: slash commands');
}
export function installAgentTeamsGestureBoundary(ctx, getProfiles = () => ({})) {
    ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        let invocation;
        try {
            invocation = invokedAgentTeamsInvocation(messages, getProfiles);
        }
        catch (error) {
            return { kind: 'enter', messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: `AgentTeams parsing failed: ${String(error)}` }], source: { kind: 'agent-teams-command' } })] };
        }
        if (invocation === undefined)
            return decision;
        signal.throwIfAborted();
        const profiles = getProfiles();
        const matched = invocation.profile === undefined
            ? undefined
            : Object.entries(profiles).find(([key]) => key.trim() === invocation.profile);
        const known = invocation.profile === undefined || matched !== undefined;
        const text = !known
            ? `AgentTeams profile "${invocation.profile}" does not exist. Available profiles: ${Object.keys(profiles).join(', ') || '(none)'}. Do not create a team.`
            : buildActivationDirective(invocation.goal, invocation.profile, resolveProfileTaskPlanning(matched?.[1]), invocation.agency);
        return { kind: 'enter', messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-teams-command', ...invocation.goal === '' ? {} : { goal: invocation.goal }, ...invocation.profile === undefined ? {} : { profile: invocation.profile }, ...invocation.agency === undefined ? {} : { agency: invocation.agency } } })] };
    });
}
