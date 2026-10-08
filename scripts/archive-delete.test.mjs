import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { deleteArchivedTeam, listArchivedTeamIds } from '../lib/state.js'

const STATE_DIR = '.agent-teams'
const NOW = 1_700_000_000_000

const archivedTeam = (teamId, captainSessionId) => ({
  id: teamId,
  name: `Archived ${teamId}`,
  captainSessionId,
  createdAt: NOW,
  members: [],
  tasks: [],
  taskSeq: 0,
})

/** A workspace root with one live-shaped team dir plus an archive/ subtree. */
async function workspaceWithArchives(archives, rootPrefix = 'archive-delete-test-') {
  const root = await mkdtemp(join(tmpdir(), rootPrefix))
  const stateRoot = join(root, STATE_DIR)
  for (const { teamId, captainSessionId, corrupt = false } of archives) {
    const dir = join(stateRoot, 'archive', teamId)
    await mkdir(dir, { recursive: true })
    const body = corrupt ? '{"id": "TRUNCATED' : JSON.stringify(archivedTeam(teamId, captainSessionId), null, 2)
    await writeFile(join(dir, 'team.json'), body)
  }
  return { root, stateRoot }
}

test('deleteArchivedTeam removes the exact archived directory and its team.json', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'])
  const deleted = await deleteArchivedTeam(stateRoot, 'team-a')
  assert.equal(deleted, true)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), [])
  await assert.rejects(readFile(join(stateRoot, 'archive', 'team-a', 'team.json')), /ENOENT/)
})

test('deleteArchivedTeam is idempotent: a second call returns false without error', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await deleteArchivedTeam(stateRoot, 'team-a'), true)
  assert.equal(await deleteArchivedTeam(stateRoot, 'team-a'), false)
})

test('deleteArchivedTeam never deletes through a path that was not listed exactly', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  // Traversal-shaped ids are absent from the listing, so they must be refused
  // without any filesystem mutation.
  for (const crafted of ['../team-a', 'team-a/../team-b', '.hidden', 'team-a/..']) {
    assert.equal(await deleteArchivedTeam(stateRoot, crafted), false, crafted)
  }
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'], 'the real archive must survive')
})

test('deleteArchivedTeam leaves sibling archives untouched', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([
    { teamId: 'team-a', captainSessionId: 'cap-1' },
    { teamId: 'team-b', captainSessionId: 'cap-2' },
  ])
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await deleteArchivedTeam(stateRoot, 'team-a'), true)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-b'])
  const remaining = JSON.parse(await readFile(join(stateRoot, 'archive', 'team-b', 'team.json'), 'utf8'))
  assert.equal(remaining.id, 'team-b')
})

test('deleteArchivedTeam tolerates a missing archive root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'archive-delete-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, STATE_DIR)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), [])
  assert.equal(await deleteArchivedTeam(stateRoot, 'team-a'), false)
})

// ── route semantics: the handler logic against a stub host/registry ──

/**
 * Reimplementation-light harness: it builds the same workspace-root scan and
 * ownership check the registered route performs (via the real state-layer
 * functions) and answers with the same status codes. The registered route is
 * verified live by `pnpm verify:web-routes`; here the semantics are pinned
 * offline: auth gate ordering, 405, 400, ownership 404, success 200.
 */
function archiveDeleteHandler({ registry, deleteImpl = deleteArchivedTeam, listImpl = listArchivedTeamIds, readImpl, log = () => {} }) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
      res.end()
      return
    }
    let payload
    try {
      const raw = await new Promise((resolve, reject) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => resolve(body))
        req.on('error', reject)
      })
      payload = JSON.parse(raw || '{}')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'invalid request body' }))
      return
    }
    const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : ''
    const teamId = typeof payload['teamId'] === 'string' ? payload['teamId'].trim() : ''
    if (sessionId === '' || teamId === '') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'sessionId and teamId are required' }))
      return
    }
    const roots = registry.list().map((workspace) => join(workspace.path, STATE_DIR))
    for (const stateRoot of roots) {
      const archivedIds = await listImpl(stateRoot)
      if (!archivedIds.includes(teamId)) continue
      const archived = readImpl ? await readImpl(stateRoot, teamId) : { captainSessionId: 'cap-1' }
      if (archived === undefined || archived.captainSessionId !== sessionId) break
      try {
        await deleteImpl(stateRoot, teamId)
      } catch (error) {
        log(`archive delete failed for ${teamId}: ${String(error)}`)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'failed to delete the archived team' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, teamId }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'archived team not found for this session' }))
  }
}

async function serveHandler(handler, gate) {
  const server = createServer(async (req, res) => {
    // The authenticatedWebRoutes wrapper (verified live by verify:web-routes)
    // rejects unauthenticated calls before the handler runs; mirror that gate
    // ordering here so the offline tests exercise the same sequence.
    if (gate?.deny) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    await handler(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('route semantics: unauthenticated requests are rejected before any handler work', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = { list: () => [{ path: root }] }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry }), { deny: true })
  t.after(close)
  const response = await fetch(`${base}/plugins/dsh-agent-teams/archive-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'cap-1', teamId: 'team-a' }),
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'unauthorized' })
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'], 'nothing is deleted behind the auth gate')
})

test('route semantics: non-POST is 405 with the allow header', async (t) => {
  const { root } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = { list: () => [{ path: root }] }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry }))
  t.after(close)
  const response = await fetch(`${base}/plugins/dsh-agent-teams/archive-delete`, { method: 'GET' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
})

test('route semantics: missing or blank sessionId/teamId are 400', async (t) => {
  const { root } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = { list: () => [{ path: root }] }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry }))
  t.after(close)
  const url = `${base}/plugins/dsh-agent-teams/archive-delete`
  for (const body of [{}, { sessionId: 'cap-1' }, { teamId: 'team-a' }, { sessionId: '   ', teamId: 'team-a' }, { sessionId: 'cap-1', teamId: '' }]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await response.json()).error, 'sessionId and teamId are required')
  }
  const malformed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
  assert.equal(malformed.status, 400)
})

test('route semantics: ownership binding deletes only the matching captain session', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = { list: () => [{ path: root }] }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry }))
  t.after(close)
  const url = `${base}/plugins/dsh-agent-teams/archive-delete`
  const wrong = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-other', teamId: 'team-a' }) })
  assert.equal(wrong.status, 404, 'a mismatched session must not learn whether the archive exists')
  assert.equal((await wrong.json()).error, 'archived team not found for this session')
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'])
  const right = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-1', teamId: 'team-a' }) })
  assert.equal(right.status, 200)
  assert.deepEqual(await right.json(), { ok: true, teamId: 'team-a' })
  assert.deepEqual(await listArchivedTeamIds(stateRoot), [])
})

test('route semantics: unknown teamId and unknown workspace are 404 without side effects', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = { list: () => [{ path: root }] }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry }))
  t.after(close)
  const url = `${base}/plugins/dsh-agent-teams/archive-delete`
  const missing = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-1', teamId: 'team-zzz' }) })
  assert.equal(missing.status, 404)
  const emptyRegistry = { list: () => [] }
  const { base: base2, close: close2 } = await serveHandler(archiveDeleteHandler({ registry: emptyRegistry }))
  t.after(close2)
  const nowhere = await fetch(`${base2}/plugins/dsh-agent-teams/archive-delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-1', teamId: 'team-a' }) })
  assert.equal(nowhere.status, 404)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'])
})

test('route semantics: a scan that matches the id but fails ownership reports 404 for that workspace', async (t) => {
  // Ownership must consult the durable team.json: the route reads the archived
  // state and compares captainSessionId before deleting.
  const { root, stateRoot } = await workspaceWithArchives([
    { teamId: 'team-a', captainSessionId: 'cap-1' },
    { teamId: 'team-b', captainSessionId: 'cap-2', corrupt: false },
  ])
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = { list: () => [{ path: root }] }
  const readImpl = async (stateRootPath, teamId) => {
    const raw = await readFile(join(stateRootPath, 'archive', teamId, 'team.json'), 'utf8')
    return JSON.parse(raw)
  }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry, readImpl }))
  t.after(close)
  const url = `${base}/plugins/dsh-agent-teams/archive-delete`
  const wrongSession = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-2', teamId: 'team-a' }) })
  assert.equal(wrongSession.status, 404)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a', 'team-b'])
  const rightSession = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-2', teamId: 'team-b' }) })
  assert.equal(rightSession.status, 200)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'])
})

test('route semantics: delete failure surfaces 500 and leaves the archive in place', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  const warnings = []
  const registry = { list: () => [{ path: root }] }
  const failingDelete = async () => { throw new Error('EPERM lock') }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry, deleteImpl: failingDelete, log: (m) => warnings.push(m) }))
  t.after(close)
  const response = await fetch(`${base}/plugins/dsh-agent-teams/archive-delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-1', teamId: 'team-a' }) })
  assert.equal(response.status, 500)
  assert.equal((await response.json()).error, 'failed to delete the archived team')
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'])
  assert.equal(warnings.length, 1)
})

test('route semantics: crafted path-like teamId cannot escape the archive root', async (t) => {
  const { root, stateRoot } = await workspaceWithArchives([{ teamId: 'team-a', captainSessionId: 'cap-1' }])
  t.after(() => rm(root, { recursive: true, force: true }))
  // A sibling live team that a traversal attempt would try to reach.
  await mkdir(join(stateRoot, 'live-team'), { recursive: true })
  await writeFile(join(stateRoot, 'live-team', 'team.json'), JSON.stringify(archivedTeam('live-team', 'cap-1')))
  const registry = { list: () => [{ path: root }] }
  const { base, close } = await serveHandler(archiveDeleteHandler({ registry }))
  t.after(close)
  const response = await fetch(`${base}/plugins/dsh-agent-teams/archive-delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cap-1', teamId: '../live-team' }) })
  assert.equal(response.status, 404)
  assert.deepEqual(await listArchivedTeamIds(stateRoot), ['team-a'])
  const liveEntries = await readdir(join(stateRoot, 'live-team'))
  assert.deepEqual(liveEntries, ['team.json'], 'the live team must survive a traversal attempt')
})
