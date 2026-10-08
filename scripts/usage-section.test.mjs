/**
 * 队长 usage 段（C.2 难度评分卡）与工具参数判据摘要的行为测试。
 *
 * 覆盖：
 * - 原 10 条协议每一条逐字保留（评分卡只追加，不改写上游文字）；
 * - 评分卡段落含四档判据与三条硬规则；
 * - `create_task.difficulty`、`edit_plan.task_difficulty`、`create.plan.tasks.difficulty`
 *   三处 description 含英文判据摘要（create_task 与 create 共用 TASK_ROUTE_PARAMETERS）；
 * - profilesText 拼接位置与缺省省略不回归。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { usageSectionText } from '../lib/index.js'
import { TASK_ROUTE_PARAMETERS, registerAgentTeamsTools } from '../lib/tools.js'
import { TEAM_TOOL_NAMES } from '../lib/tool-names.js'
import { formatProfilesForPrompt } from '../lib/profiles.js'

const TOOL_NAMES = TEAM_TOOL_NAMES.join(', ')

/**
 * Capture the tool definitions this plugin registers.
 *
 * `registerAgentTeamsTools` only installs guards and registers tools, so a stub
 * context is enough — no Harness install, no state directory, no model runtime.
 * Every guard it installs is skipped by the same inert `subagents`/`effect`
 * surface, which is the documented degraded path for an unknown host contract.
 */
function registerForCapture(definitions) {
  const noop = () => {}
  const inert = () => noop
  registerAgentTeamsTools({
    on: inert,
    effect: setup => setup(),
    logger: { warn: noop, debug: noop },
    tools: { register: definition => definitions.push(definition) },
    subagents: {
      followup: async () => {}, start: async () => ({}), startContinuable: async () => ({}),
      sendMessage: async () => {},
      registerContinuableSetup: () => noop,
    },
  }, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {} })
}

/** The ten upstream protocol sentences, verbatim — the no-regression baseline. */
const PROTOCOL_LINES = [
  `1. Inspect current team state when needed, using agent_teams_status. Continue existing work without duplicating its roster/tasks. Create only when no current team exists, with the user's goal as description and approval="required"; automatic approval requires an explicit request to run immediately. Staged plans never spawn or schedule work.`,
  `2. Add each needed role once; members inherit your model route unless another is requested/needed. A requested profile goes to create({profile}); it supplies its roster. Seed profiles also supply tasks; captain-planning profiles require your DAG. Do not duplicate either.`,
  `3. Build the complete smallest useful DAG while staged. For an ordinary research/audit plan, pass the roster and dependency graph together in create({plan:{members,tasks}}) to avoid repeated setup rounds. Every task needs a subject; pass kind and assignee explicitly when the plan specifies them. Titles, descriptions and member roles do not set these fields. Dependencies represent prerequisites. Give every required contributor a task or explicit message. Present the plan and end your turn for review; never approve in that planning turn. Approve only after a later explicit user approval or the Web action.`,
  `4. Respect Web approve/return/discard control messages. On return, ask what to change before editing; after the answer, use one atomic agent_teams_edit_plan batch (edit downstream references before removals), summarize and await review again. Never inspect or edit .agent-teams state files or plugin source code to revise plans. Discard does not authorize a replacement.`,
  `5. The scheduler dispatches ready tasks after approval. Delegate; do not duplicate slow work or send messages merely to start a stage. Handle reports/user work, then yield when waiting is all that remains: reports wake you automatically. Use status after a delivery or user request, never busy-poll or wait for unassigned members.`,
  `6. Tasks carry attempt_id capabilities. Use the current attempt_id; stale means ownership changed. Pause members only on explicit request; later guidance via send_message continues that same attempt. Retry, transfer or take over through reassign_task first; it revokes the old attempt and waits for quiescence. Prefer a member. Captain implementation/review takeover requires a user request. Every takeover is one ready task at a time, finished in this turn; never yield with captain-owned work open.`,
  `7. In a running team, correct never-started pending tasks with edit_plan update_task; preserve dependency and ownership contracts instead of cancelling and recreating the graph. A captain can cancel a never-started pending task directly. Active attempts still require reassign_task. Quality kinds (requirements, implementation, verification, review, repair, integration) require objective + acceptance; implementation/repair also require inScope + verify. Derive paths/commands from the workspace/profile, never assume src/ or pnpm test. Review/requirements complete only with verdict=pass; needs_revision/reject fail with findings. Never approve your own implementation or ask for a deliberate failure. When a quality contract itself is wrong (a verify command that cannot pass, an inScope that forbids the file the objective requires), fix it with agent_teams_amend_task — captain-only, non-terminal tasks only, frozen after a passing review, and every amendment is recorded in the task's revisions ledger — instead of letting the worker dead-lock or game the gate.`,
  `8. When full quality mode is requested: requirements → implementation → verification → review → integration. Plan the entire DAG while staged, including implementation before requirements finishes and integration depending on review round 1. Failed review automatically adds repair + next review and rewires pending downstream gates. Do not recreate this loop, omit integration or depend on a failed task. Review acceptance judges the latest implementation. Do not put smoke-test scripts into task instructions.`,
  `9. Halted means the user stopped work (including the captain turn). Resume only on a later explicit user request with a reason, via agent_teams_resume or create_task({resume:true,resumeReason}); creating tasks alone never resumes. Escalated means the review loop hit its limit, not a halt. Deployment requires explicit user confirmation.`,
  `10. Wait for all required tasks to be terminal and members idle/ready, present results, then delete/archive unless the user wants to continue. Never discard unfinished work without authorization.`,
]

const SCORECARD_KEYWORDS = [
  'Difficulty scoring card',
  'mechanical execution, a single-point change',
  'one module or one method, with an explicit acceptance',
  'cross-module or cross-file, requires trade-offs, carries regression risk',
  'hard root cause, safety-critical, irreversible or a public contract',
  'score higher rather than lower',
  'the tier is a task property, not a member property',
  'inflating a tier burns money instead of buying insurance',
]

/** The one-line English criteria summary shared by every difficulty parameter. */
const SUMMARY_MARKER = 'Score by convergence, not topic'
const SUMMARY_TIERS = ['low = mechanical single-point change', 'medium = one module with explicit acceptance', 'high = cross-module with trade-offs and regression risk', 'max = hard root cause, safety-critical, irreversible or public contract']

test('原 10 条协议逐字保留', () => {
  const text = usageSectionText(TOOL_NAMES)
  assert.match(text, /^AgentTeams captain protocol:\n/)
  for (const line of PROTOCOL_LINES) assert.ok(text.includes(line), `protocol line missing or altered: ${line.slice(0, 40)}…`)
  // The card is appended after the protocol, never spliced into it.
  const tenthEnd = text.indexOf(PROTOCOL_LINES[9]) + PROTOCOL_LINES[9].length
  const cardStart = text.indexOf('Difficulty scoring card')
  assert.ok(cardStart > tenthEnd, 'scoring card must come after protocol line 10')
})

test('评分卡含四档判据与硬规则', () => {
  const text = usageSectionText(TOOL_NAMES)
  for (const keyword of SCORECARD_KEYWORDS) assert.ok(text.includes(keyword), `scoring card missing: ${keyword}`)
  for (const tier of ['low —', 'medium —', 'high —', 'max —']) assert.ok(text.includes(tier), `missing tier row: ${tier}`)
})

test('难度参数 description 含英文判据摘要', () => {
  const shared = TASK_ROUTE_PARAMETERS.difficulty.description
  assert.match(shared, /Task difficulty tier\. Missing means medium\./)
  assert.ok(shared.includes(SUMMARY_MARKER))
  for (const tier of SUMMARY_TIERS) assert.ok(shared.includes(tier), `shared difficulty description missing: ${tier}`)
  assert.match(shared, /When unsure, score higher rather than lower/)
})

test('create 与 edit_plan 的 difficulty 参数各含判据摘要', async () => {
  const definitions = []
  registerForCapture(definitions)
  const byName = new Map(definitions.map(definition => [definition.name, definition]))
  const create = byName.get('agent_teams_create')
  const editPlan = byName.get('agent_teams_edit_plan')
  assert.ok(create !== undefined, 'agent_teams_create not registered')
  assert.ok(editPlan !== undefined, 'agent_teams_edit_plan not registered')

  // Registration normalizes `parameters` into one JSON-Schema object.
  const planDifficulty = create.parameters.properties.plan.properties.tasks.items.properties.difficulty
  const taskDifficulty = editPlan.parameters.properties.operations.items.properties.task_difficulty
  for (const [where, parameter] of [['create.plan.tasks.difficulty', planDifficulty], ['edit_plan.task_difficulty', taskDifficulty]]) {
    assert.ok(parameter !== undefined, `${where} is not registered`)
    assert.deepEqual(parameter.enum, ['low', 'medium', 'high', 'max'])
    const description = parameter.description
    assert.ok(typeof description === 'string' && description.length > 0, `${where} has no description`)
    assert.ok(description.includes(SUMMARY_MARKER), `${where} missing criteria summary`)
    for (const tier of SUMMARY_TIERS) assert.ok(description.includes(tier), `${where} missing tier: ${tier}`)
    // Existing English wording kept; the summary is an appended sentence.
    assert.match(description, /^Task (difficulty tier|routing only: difficulty tier)\./)
  }
  // The shared descriptor is what agent_teams_create_task gets via TASK_ROUTE_PARAMETERS.
  const createTask = byName.get('agent_teams_create_task')
  assert.ok(createTask !== undefined, 'agent_teams_create_task not registered')
  assert.equal(createTask.parameters.properties.difficulty.description, TASK_ROUTE_PARAMETERS.difficulty.description)
  assert.deepEqual(createTask.parameters.properties.difficulty.enum, ['low', 'medium', 'high', 'max'])
})

test('profilesText 拼接不回归', () => {
  const bare = usageSectionText(TOOL_NAMES)
  assert.ok(bare.includes(`Tools: ${TOOL_NAMES}`))
  assert.equal(bare.endsWith(`Tools: ${TOOL_NAMES}`), true)

  const profiles = formatProfilesForPrompt({ demo: { taskPlanning: 'captain', members: [{ name: 'reviewer' }], protocol: 'Review prepared work independently.' } })
  assert.ok(profiles.length > 0)
  const withProfiles = usageSectionText(TOOL_NAMES, profiles)
  assert.ok(withProfiles.includes(`Tools: ${TOOL_NAMES}\n\n${profiles}`))
  // Only the tail differs: protocol + card stay byte-identical.
  const shared = PROTOCOL_LINES.join('\n')
  assert.ok(bare.includes(shared))
  assert.ok(withProfiles.includes(shared))
  assert.ok(withProfiles.includes('Difficulty scoring card'))

  assert.equal(usageSectionText(TOOL_NAMES, ''), bare)
})
