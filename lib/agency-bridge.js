/**
 * agency-agents 可选桥——整团装配需要三个服务，个人专家只需要 library + persona。
 *
 * ## 边界
 *
 * - **本插件完全不强依赖 agency-agents**：所需服务缺席（未安装、未启用、版本不匹配、
 *   形状不认识）时由调用方回落；个人专家发现只依赖 library，绑定才读取 persona。
 * - **三个服务只通过 `ctx.get()` 在调用时探测**：模块级 `inject` 是**硬依赖**——
 *   写进 `inject` 数组会让 agency-agents 缺席时本插件整体不激活，与可选桥的约定相反。
 * - **本模块全部是纯函数式形状**：服务句柄与方法返回值都以入参承接并自行校验形状，
 *   只有服务 owner 探测 ctx（只读 `get`），便于用 stub 做单测。
 *
 * ## 核实过的服务形状（`@michengai/dsh-agency-agents@1.0.11`，实读其构建产物）
 *
 * | 服务名 | 这里用到的方法（2026-10-09 活体核实） | 备注 |
 * | --- | --- | --- |
 * | `agencyAgentsTeams` | `snapshot()`（异步 → `{teams,…}`）、`get(id)`（异步，未命中抛错）；**没有 `list()`** | team 成员是「角色 + 职责 + 指令」，**不是** persona 正文 |
 * | `agencyAgentsLibrary` | `catalog()`（**异步** → `{experts,…}`） | 只查 expert 的 `division`，不预加载全量 persona 正文 |
 * | `agencyAgentsPersona` | `getPrompt(slug, division, locale)`（异步 → `{prompt}`） | persona 正文按需读，且只读本团这几个成员 |
 *
 * 服务名/形状随版本演进由 {@link agencyServicesOf} 的最小方法集校验吸收：
 * 缺方法即视为缺席，整体回落。
 *
 * > 2026-10-09 活体走查修正：早先按「同步 `list()`/`catalog()`、persona 返回裸字符串」
 * > 实现，与 1.0.11 真实形状不符——异步方法被当同步用、`list` 根本不存在、persona
 * > 返回对象被读成 undefined。三处按真实形状收敛（见上表），并补真实形状回归测试。
 *
 * @module dsh-agent-teams/agency-bridge
 */
import { validateTaskRouteFields } from "./router.js";
import { normalizeRole } from "./router.js";
export const AGENCY_SERVICE_KEYS = {
    teams: 'agencyAgentsTeams',
    library: 'agencyAgentsLibrary',
    persona: 'agencyAgentsPersona',
};
/** 单个成员 persona 正文的字符上限（超出截断并记 diagnostics）。 */
export const PERSONA_MAX_CHARS = 8000;
/** locale 读不到时的缺省值。 */
export const DEFAULT_LOCALE = 'zh';
/** team 不存在时列在报错里的可用 id 上限（避免超长报错）。 */
const MAX_LISTED_TEAM_IDS = 20;
/**
 * 能力探测：三个服务都在且方法都是函数就返回句柄，否则返回缺席。
 *
 * **永不抛错**（DESIGN A.4：服务缺失时必须功能完全回落，无异常日志）。
 */
export function agencyServicesOf(ctx) {
    if (ctx === undefined) {
        return { available: false, missing: Object.values(AGENCY_SERVICE_KEYS), unrecognized: [] };
    }
    const missing = [];
    const read = (key) => {
        const service = ctx.get(key);
        if (service === undefined || service === null || typeof service !== 'object') {
            missing.push(key);
            return undefined;
        }
        return service;
    };
    const teams = read(AGENCY_SERVICE_KEYS.teams);
    const library = read(AGENCY_SERVICE_KEYS.library);
    const persona = read(AGENCY_SERVICE_KEYS.persona);
    if (missing.length > 0)
        return { available: false, missing, unrecognized: [] };
    const candidate = {
        teams: teams,
        library: library,
        persona: persona,
    };
    // 最小方法集：少任何一个都当作「版本不认识」，整体回落而不是运行时炸。
    // 0.1.22 老实现要求 teams.list()，而 1.0.11 真实只提供 snapshot()/get()——
    // 用 `list ?? snapshot` 两根候选，缺一即可，不再把「形状不认识」误报成「未注册」。
    const unrecognized = [];
    const hasTeamLookup = typeof candidate.teams.snapshot === 'function'
        || typeof candidate.teams.list === 'function'
        || typeof candidate.teams.get === 'function';
    if (!hasTeamLookup)
        unrecognized.push(AGENCY_SERVICE_KEYS.teams);
    if (typeof candidate.library.catalog !== 'function')
        unrecognized.push(AGENCY_SERVICE_KEYS.library);
    if (typeof candidate.persona.getPrompt !== 'function')
        unrecognized.push(AGENCY_SERVICE_KEYS.persona);
    if (unrecognized.length > 0)
        return { available: false, missing: [], unrecognized };
    return { available: true, services: candidate };
}
/**
 * 读客户端 locale（`ctx.locale.getLocale().active`），读不到返回 undefined。
 *
 * `locale` 是 client-plane 服务（headless/工具侧常常不在），所以这里沿用
 * `ctx.get()` 的探测纪律：**不在 `inject` 里声明，读不到就当没有**，由调用方落到
 * {@link DEFAULT_LOCALE}。任何异常（形状不同、getter 抛错）都必须静默回落，
 * 不能让 locale 探测影响建团。
 */
export function clientLocaleOf(ctx) {
    if (ctx === undefined)
        return undefined;
    try {
        const runtime = ctx.get('locale');
        if (runtime === undefined || runtime === null || typeof runtime.getLocale !== 'function')
            return undefined;
        const active = runtime.getLocale()?.active;
        return typeof active === 'string' && active.trim() !== '' ? active.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
/** 服务缺席时给调用方的可读原因。 */
export function agencyUnavailableReason(outcome) {
    const parts = [];
    if (outcome.missing.length > 0)
        parts.push(`these services are not registered: ${outcome.missing.join(', ')}`);
    if (outcome.unrecognized.length > 0) {
        parts.push(`these services are registered but expose an unrecognized shape: ${outcome.unrecognized.join(', ')}`);
    }
    if (parts.length === 0)
        parts.push('the required services are unavailable');
    return `the agency-agents bridge is unavailable — ${parts.join('; ')}`;
}
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function optionalText(value) {
    const trimmed = text(value);
    return trimmed === '' ? undefined : trimmed;
}
/** 收敛一行 agency member；缺 expertSlug 的行整体跳过（由调用方决定人数是否够）。 */
function readMemberRow(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const row = value;
    const slug = text(row['expertSlug']);
    if (slug === '')
        return undefined;
    return {
        expertSlug: slug,
        ...optionalText(row['duty']) === undefined ? {} : { duty: optionalText(row['duty']) },
        ...optionalText(row['instructions']) === undefined ? {} : { instructions: optionalText(row['instructions']) },
    };
}
/** 收敛一条 catalog expert（只需要 slug + division）。 */
function readExpert(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const row = value;
    const slug = text(row['slug']);
    if (slug === '')
        return undefined;
    return {
        slug,
        ...optionalText(row['division']) === undefined ? {} : { division: optionalText(row['division']) },
        ...optionalText(row['description']) === undefined ? {} : { description: optionalText(row['description']) },
    };
}
/**
 * 调用一个可能同步、也可能异步的服务方法并 await 其结果。
 *
 * 真实服务多为 `async`；早期按同步实现会把 Promise 当成返回值用坏（活体走查抓到）。
 * 方法缺失返回 undefined。
 */
async function readMaybeAsync(fn, ...args) {
    if (typeof fn !== 'function')
        return undefined;
    try {
        return await fn.apply(undefined, args);
    }
    catch (error) {
        // 单个成员读取失败不应炸掉整个装配：交给调用方按"缺 persona"兜底。
        return undefined;
    }
}
/**
 * 从 persona 服务返回值里取正文。
 *
 * 真实形状是 `{prompt: string}`（异步返回）；同时兼容更早的裸字符串形状。
 */
function readPersonaText(value) {
    if (typeof value === 'string')
        return optionalText(value);
    if (typeof value === 'object' && value !== null) {
        return optionalText(value['prompt']);
    }
    return undefined;
}
/** catalog 的真实形状：专家数组加顶层 enabled slug 列表。 */
function coerceCatalog(value) {
    const experts = coerceExperts(value);
    if (experts === undefined || typeof value !== 'object' || value === null)
        return undefined;
    const enabled = value['enabled'];
    if (!Array.isArray(enabled) || !enabled.every(item => typeof item === 'string'))
        return undefined;
    return { experts, enabled };
}
/** 把服务返回收敛成 expert 数组；形状不认识返回 undefined（= catalog 不可用）。 */
function coerceExperts(value) {
    if (Array.isArray(value)) {
        return value.map(readExpert).filter((expert) => expert !== undefined);
    }
    if (typeof value === 'object' && value !== null) {
        const nested = value['experts'];
        if (Array.isArray(nested)) {
            return nested.map(readExpert).filter((expert) => expert !== undefined);
        }
    }
    return undefined;
}
/** 取 team 上的主理人字段（缺哪个不带哪个）。 */
function coordinatorFieldsOf(team) {
    return {
        ...optionalText(team.coordinatorPrompt) === undefined ? {} : { coordinatorPrompt: optionalText(team.coordinatorPrompt) },
        ...optionalText(team.constraints) === undefined ? {} : { constraints: optionalText(team.constraints) },
        ...optionalText(team.deliveryRequirements) === undefined ? {} : { deliveryRequirements: optionalText(team.deliveryRequirements) },
        ...optionalText(team.goal) === undefined ? {} : { goal: optionalText(team.goal) },
    };
}
/** team 的显示名：name → id → 兜底占位。 */
function teamLabel(team) {
    return text(team.name) || text(team.id) || '(unnamed)';
}
/**
 * 从 `agencyAgentsTeams` 取一个团队（按 id 或 name 匹配）。
 *
 * 真实形状（2026-10-09 活体核实）：`snapshot()` 是异步且返回 `{teams, …}`，
 * `get(id)` 是异步、**未命中抛错**、只认 id。所以顺序是：
 * ① `snapshot()` 拿全量清单，先按 id 再按 name 精确匹配（也给得到"可用 id"清单）；
 * ② 清单不可用/不命中时退回 `get(idOrName)`（吞掉未命中异常）；
 * ③ 仍不命中就报错并**列出可用 team id**（DESIGN A.3：不静默回落）。
 */
export async function resolveAgencyTeam(services, idOrName) {
    const key = idOrName.trim();
    if (key === '')
        return { ok: false, error: 'agencyTeam must be a non-empty id or team name' };
    const teams = await readAgencyTeamList(services.teams);
    const listed = teams.find((candidate) => text(candidate.id) === key)
        ?? teams.find((candidate) => text(candidate.name) === key);
    if (listed !== undefined)
        return { ok: true, team: listed };
    if (typeof services.teams.get === 'function') {
        try {
            const direct = await services.teams.get(key);
            if (typeof direct === 'object' && direct !== null)
                return { ok: true, team: direct };
        }
        catch {
            // 真实服务未命中会抛错——这里吞掉，落到下面的可读报错（含可用清单）。
        }
    }
    const available = teams
        .map((candidate) => text(candidate.id) || text(candidate.name))
        .filter((entry) => entry !== '');
    const shown = available.length === 0
        ? '(none)'
        : available.slice(0, MAX_LISTED_TEAM_IDS).join(', ')
            + (available.length > MAX_LISTED_TEAM_IDS ? `, … (+${available.length - MAX_LISTED_TEAM_IDS} more)` : '');
    return { ok: false, error: `unknown agency team "${key}" — available teams: ${shown}` };
}
/** 读团队清单：`snapshot()`（真实，`{teams}` 或数组）优先，`list()` 作旧版兼容。 */
async function readAgencyTeamList(teams) {
    const readFrom = (value) => {
        const rows = Array.isArray(value)
            ? value
            : typeof value === 'object' && value !== null
                ? value['teams']
                : undefined;
        return Array.isArray(rows)
            ? rows.filter((entry) => typeof entry === 'object' && entry !== null)
            : [];
    };
    for (const method of [teams.snapshot, teams.list]) {
        if (typeof method !== 'function')
            continue;
        try {
            const parsed = readFrom(await method.call(teams));
            if (parsed.length > 0)
                return parsed;
        }
        catch {
            // 列举失败就当这一路不可用，继续下一路；两条都失败则回落到 get()。
        }
    }
    return [];
}
/**
 * 合成一个成员的 `executionPrompt`：persona 正文 + 「## 本次职责」+「## 补充指令」。
 *
 * 缺哪个 section 省哪个，不补占位文字；persona 缺时只剩后两段（由调用方记 diagnostics）。
 */
export function composeExecutionPrompt(persona, duty, instructions) {
    const sections = [];
    if (persona !== undefined && persona !== '')
        sections.push(persona);
    if (duty !== undefined && duty !== '')
        sections.push(`## 本次职责\n${duty}`);
    if (instructions !== undefined && instructions !== '')
        sections.push(`## 补充指令\n${instructions}`);
    return sections.join('\n\n');
}
/**
 * 把 agency team 装配成 AgentTeams 成员候补。
 *
 * 纪律（DESIGN A.2 / A.3）：
 * - `name` = expertSlug；**同一 slug 重复出现时加 `-2`/`-3` 后缀**并记 diagnostics
 *   （persona 仍按原 slug 拉取，改名不影响正文）；
 * - `provider`/`model`/`reasoningEffort` **全部留空** → 由用户在计划面板选定；
 * - persona 正文按需读，且**只读本团这几个成员**，不预加载全量 catalog 正文；
 * - persona 超 {@link PERSONA_MAX_CHARS} 截断 + diagnostics；
 *   缺 persona 用 duty + instructions 兜底 + diagnostics；
 * - 阵容超 `maxMembers` **明确报错，不静默截断**。
 */
export async function assembleAgencyTeam(input) {
    const rows = Array.isArray(input.team.members)
        ? input.team.members.map(readMemberRow).filter((row) => row !== undefined)
        : [];
    if (rows.length === 0) {
        return { ok: false, error: `agency team "${teamLabel(input.team)}" has no usable members (every row needs a non-empty expertSlug)` };
    }
    if (rows.length > input.maxMembers) {
        return {
            ok: false,
            error: `agency team "${teamLabel(input.team)}" has ${rows.length} members but maxMembers is ${input.maxMembers}; `
                + 'raise the plugin\'s maxMembers config or shrink the team — the roster is never silently truncated',
        };
    }
    const locale = text(input.locale) === '' ? DEFAULT_LOCALE : text(input.locale);
    // catalog 只读一次：它只有 metadata（slug/division），不是 persona 正文。
    // 真实服务是异步（`async catalog()` → `{experts,…}`），必须 await。
    const experts = coerceExperts(await readMaybeAsync(input.services.library.catalog));
    const divisionOf = new Map();
    for (const expert of experts ?? []) {
        if (expert.slug === undefined)
            continue;
        divisionOf.set(expert.slug, expert.division ?? '');
    }
    const members = [];
    const diagnostics = [];
    const used = new Map();
    for (const row of rows) {
        const slug = row.expertSlug;
        const occurrence = (used.get(slug) ?? 0) + 1;
        used.set(slug, occurrence);
        // 首次出现用原 slug；重复出现加 -2/-3 后缀，保证团内成员名唯一。
        const name = occurrence === 1 ? slug : `${slug}-${occurrence}`;
        if (occurrence > 1) {
            diagnostics.push({
                member: name,
                code: 'name-collision',
                detail: `expertSlug "${slug}" appears ${occurrence} times in this agency team; its persona is still read by the original slug`,
            });
        }
        const rowDiagnostics = [];
        if (experts !== undefined && !divisionOf.has(slug)) {
            const detail = `expert "${slug}" is not in the agency catalog; reading its persona without a division`;
            diagnostics.push({ member: name, code: 'expert-unknown', detail });
            rowDiagnostics.push({ member: name, code: 'expert-unknown', detail });
        }
        const raw = await readMaybeAsync(input.services.persona.getPrompt, slug, divisionOf.get(slug) ?? '', locale);
        const persona = readPersonaText(raw);
        if (persona === undefined) {
            const detail = `no persona text for expert "${slug}"; falling back to duty + instructions`;
            diagnostics.push({ member: name, code: 'persona-missing', detail });
            rowDiagnostics.push({ member: name, code: 'persona-missing', detail });
        }
        else if (persona.length > PERSONA_MAX_CHARS) {
            const detail = `persona for expert "${slug}" is ${persona.length} chars; truncated to ${PERSONA_MAX_CHARS}`;
            diagnostics.push({ member: name, code: 'persona-truncated', detail });
            rowDiagnostics.push({ member: name, code: 'persona-truncated', detail });
        }
        members.push({
            name,
            provider: undefined,
            model: undefined,
            reasoningEffort: undefined,
            executionPrompt: composeExecutionPrompt(persona === undefined ? undefined : persona.slice(0, PERSONA_MAX_CHARS), row.duty, row.instructions),
            diagnostics: rowDiagnostics,
        });
    }
    return {
        ok: true,
        result: {
            members,
            diagnostics,
            coordinator: coordinatorFieldsOf(input.team),
            ...text(input.team.name) === '' ? {} : { teamName: text(input.team.name) },
        },
    };
}
/**
 * The agency conflict matrix, kept pure so it can be asserted without a studio.
 *
 * - `agencyTeam` × `profile` → error（roster 只能有一个 owner）
 * - `agencyTeam` × `plan.members` → error
 * - `agencyTeam` × `plan.tasks` → **allowed**（任务图与阵容正交）
 * - 三者都不给 → 现有行为（captain 自组队）
 *
 * Blank optional strings count as omissions, exactly like `profile` (issue #99).
 *
 * @returns the trimmed agency reference, plus the inline task rows it is
 *   allowed to ride along with (an empty array when there are none).
 */
export function resolveAgencyCreateRequest(args) {
    const ref = text(args.agencyTeam);
    const profileName = text(args.profile);
    if (ref === '')
        return { ok: true };
    if (profileName !== '') {
        return { ok: false, error: 'choose either agencyTeam or a configured profile — the agency team supplies the whole roster' };
    }
    if (args.plan !== undefined && args.plan !== null && args.plan.members !== undefined) {
        return { ok: false, error: 'agencyTeam supplies the roster; omit plan.members (plan.tasks may stay)' };
    }
    return { ok: true, agencyTeam: ref };
}
/** 个人专家只探测当次需要的服务，不探测 teams。 */
function agencyExpertServiceOf(ctx, key, method) {
    try {
        const service = ctx?.get(key);
        if (typeof service !== 'object' || service === null) {
            return { available: false, reason: agencyUnavailableReason({ available: false, missing: [key], unrecognized: [] }) };
        }
        const candidate = service;
        if (typeof candidate[method] !== 'function') {
            return { available: false, reason: agencyUnavailableReason({ available: false, missing: [], unrecognized: [key] }) };
        }
        return { available: true, service: candidate };
    }
    catch {
        return { available: false, reason: agencyUnavailableReason({ available: false, missing: [key], unrecognized: [] }) };
    }
}
/** 个人专家目录的共用 owner：只读 library，不预读 persona 正文。 */
async function readAgencyExpertCatalog(ctx) {
    const outcome = agencyExpertServiceOf(ctx, AGENCY_SERVICE_KEYS.library, 'catalog');
    if (!outcome.available)
        return outcome;
    const library = outcome.service;
    const catalog = coerceCatalog(await readMaybeAsync(library.catalog?.bind(library)));
    if (catalog === undefined)
        return { available: false, reason: 'the agency catalog is unavailable' };
    const enabled = new Set(catalog.enabled);
    return {
        available: true,
        experts: catalog.experts
            .filter((expert) => expert.slug !== undefined)
            .map(expert => ({
            slug: expert.slug,
            division: expert.division ?? '',
            description: expert.description ?? '',
            enabled: enabled.has(expert.slug),
        })),
    };
}
/** 列出完整专家目录与启用状态，只依赖 library；不读 teams 或 persona。 */
export async function listAgencyExperts(ctx) {
    return await readAgencyExpertCatalog(ctx);
}
/** 保留旧清单契约，只返回已启用项；与完整清单共用目录 owner。 */
export async function listEnabledExperts(ctx) {
    const listed = await listAgencyExperts(ctx);
    if (!listed.available)
        return listed;
    return {
        available: true,
        experts: listed.experts
            .filter(expert => expert.enabled)
            .map(({ slug, division, description }) => ({ slug, division, description })),
    };
}
/** 严格解析单个专家；既有调用方仍能区分未知、停用、缺正文。 */
export async function resolveExpertPersona(input) {
    const slug = text(input.slug);
    if (slug === '')
        return { ok: false, error: 'expert slug must not be empty' };
    const catalog = await readAgencyExpertCatalog(input.ctx);
    if (!catalog.available)
        return { ok: false, error: catalog.reason };
    const expert = catalog.experts.find(candidate => candidate.slug === slug);
    if (expert === undefined)
        return { ok: false, error: `expert "${slug}" is not in the agency catalog` };
    if (!expert.enabled) {
        return { ok: false, error: `expert "${slug}" is not enabled; enable it in Agency settings or pick another` };
    }
    const outcome = agencyExpertServiceOf(input.ctx, AGENCY_SERVICE_KEYS.persona, 'getPrompt');
    if (!outcome.available)
        return { ok: false, error: outcome.reason };
    const service = outcome.service;
    const locale = text(input.locale) === '' ? DEFAULT_LOCALE : text(input.locale);
    const persona = readPersonaText(await readMaybeAsync(service.getPrompt?.bind(service), slug, expert.division, locale));
    if (persona === undefined)
        return { ok: false, error: `no persona text for expert "${slug}"` };
    return { ok: true, slug, executionPrompt: persona.slice(0, PERSONA_MAX_CHARS) };
}
/** 建队员时只解析明确选中的一个 slug；未绑定时静默使用普通队员。 */
export async function resolveOptionalExpertPersona(input) {
    const slug = text(input.slug);
    if (slug === '')
        return undefined;
    try {
        const resolved = await resolveExpertPersona({ ...input, slug });
        return resolved.ok ? { slug: resolved.slug, executionPrompt: resolved.executionPrompt } : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 一次性走完「探测 → 取团 → 装配」（整团工具入口）。
 *
 * 服务缺席返回 `available:false`，调用方据此处理 `agencyTeam` 参数；
 * 其余失败（team 不存在 / 阵容超 maxMembers）返回可读英文 error。
 */
export async function loadAgencyTeam(input) {
    const outcome = agencyServicesOf(input.ctx);
    if (!outcome.available)
        return { ok: false, available: false, reason: agencyUnavailableReason(outcome) };
    const team = await resolveAgencyTeam(outcome.services, input.idOrName);
    if (!team.ok)
        return { ok: false, available: false, reason: team.error };
    const assembled = await assembleAgencyTeam({
        services: outcome.services,
        team: team.team,
        maxMembers: input.maxMembers,
        locale: input.locale,
    });
    if (!assembled.ok)
        return { ok: false, available: false, reason: assembled.error };
    return { ok: true, available: true, assembly: assembled.result };
}
/**
 * 校验并拓扑排序 `create({agencyTeam, plan.tasks})` 里的任务行。
 *
 * 阵容来自 agency 团队，这里只管 DAG 那一半：本地 `id` 引用、subject、依赖与路由
 * 意图（`router.ts` 的 `validateTaskRouteFields` 是唯一判官）。`plan.tasks` 与
 * `agencyTeam` 允许共存正是因为二者正交——任务图不描述人。
 *
 * 入参是 `unknown`：这些值跨模型工具边界进来，形状一律在此收敛。
 */
export function normalizeAgencyPlanTasks(tasks) {
    if (tasks.length === 0)
        return [];
    const rows = [];
    const byId = new Map();
    const byKey = new Map();
    for (let index = 0; index < tasks.length; index += 1) {
        const row = normalizeAgencyPlanTask(tasks[index], index);
        const colliding = byKey.get(sanitize(row.id));
        if (colliding !== undefined) {
            throw new Error(`plan tasks "${colliding}" and "${row.id}" collapse to the same task id`);
        }
        byId.set(row.id, row);
        byKey.set(sanitize(row.id), row.id);
        rows.push(row);
    }
    return topoSortAgencyPlanTasks(rows, byId);
}
function normalizeAgencyPlanTask(value, index) {
    const path = `plan.tasks[${index}]`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    const raw = value;
    const id = requiredText(raw['id'], `${path}.id`, 'plan task id must not be empty');
    const subject = requiredText(raw['subject'], `${path}.subject`, `plan task "${id}" is missing a subject`);
    const description = optionalRawText(raw['description'], `${path}.description`);
    const assignee = optionalRawText(raw['assignee'], `${path}.assignee`);
    const dependencies = readDependencies(raw['dependencies'], `${path}.dependencies`);
    // 2026-10-10 去路由：`provider`/`model`/`reasoning_effort` 不再是任务字段，
    // 这里只校验难度/角色这两个展示字段。
    const routing = validateTaskRouteFields({
        difficulty: raw['difficulty'],
        role: raw['role'],
    });
    if (!routing.ok)
        throw new Error(`plan task "${id}": ${routing.errors.join('; ')}`);
    return {
        id,
        subject,
        ...description === undefined ? {} : { description },
        ...assignee === undefined ? {} : { assignee },
        dependencies,
        difficulty: routing.fields.difficulty,
        role: routing.fields.role,
        normalizedRole: normalizeRole(routing.fields.role),
    };
}
function readDependencies(value, path) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${path} must be an array of task ids`);
    const seen = new Set();
    const ids = [];
    for (const item of value) {
        if (typeof item !== 'string')
            throw new Error(`${path} must contain only task ids`);
        const id = item.trim();
        if (id === '')
            throw new Error(`${path} must not contain empty task ids`);
        if (seen.has(id))
            throw new Error(`${path} lists "${id}" more than once`);
        seen.add(id);
        ids.push(id);
    }
    return ids;
}
/** Kahn-free DFS：拓扑序 + 环检测 + 未知依赖提示。 */
function topoSortAgencyPlanTasks(rows, byId) {
    const permanent = new Set();
    const temporary = new Set();
    const ordered = [];
    const visit = (row, trail) => {
        if (permanent.has(row.id))
            return;
        if (temporary.has(row.id)) {
            throw new Error(`plan tasks ${trail.map(id => `"${id}"`).join(', ')} form a dependency cycle`);
        }
        temporary.add(row.id);
        for (const dependency of row.dependencies) {
            const next = byId.get(dependency);
            if (next === undefined)
                throw new Error(`plan task "${row.id}" depends on unknown task "${dependency}"`);
            visit(next, [...trail, dependency]);
        }
        temporary.delete(row.id);
        permanent.add(row.id);
        ordered.push(row);
    };
    for (const row of rows)
        visit(row, [row.id]);
    return ordered;
}
function sanitize(value) {
    return value.trim().toLowerCase();
}
function requiredText(value, path, emptyMessage) {
    if (typeof value !== 'string')
        throw new Error(`${path} must be a string`);
    const trimmed = value.trim();
    if (trimmed === '')
        throw new Error(emptyMessage);
    return trimmed;
}
function optionalRawText(value, path) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`${path} must be a string`);
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
