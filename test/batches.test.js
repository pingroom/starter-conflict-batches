import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportPlan } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, analyzeBatches, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-batches-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later pair classifications; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'compatible'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a pair classification', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'compatible'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'compatible'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and across pair classifications', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'compatible'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'compatible');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'compatible'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'compatible'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing reviewer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'compatible');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'compatible'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});


const batchInput = ids => ({ batchId: 'fixture', title: 'Batch model', context: 'Group mock tasks by pairwise compatibility.', items: ids.map(id => ({ id, label: `Work ${id}` })) });
const decisionsFor = (input, conflicts = []) => itemsFor(input).map(pair => ({ pairId: pair.id,
  choice: conflicts.some(([a, b]) => [pair.left, pair.right].includes(a) && [pair.left, pair.right].includes(b)) ? 'conflicting' : 'compatible' }));
const lex = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = Array.isArray(a[i]) ? lex(a[i], b[i]) : a[i] < b[i] ? -1 : a[i] > b[i] ? 1 : 0;
    if (order) return order;
  }
  return a.length - b.length;
};

// Independent oracle: enumerate n^n labeled color assignments, reject equal colors
// on conflict edges, then discard color-label permutations and unused colors.
function colorOracle(input, conflicts) {
  const ids = input.items.map(item => item.id).sort(), n = ids.length, found = new Map();
  for (let code = 0; code < n ** n; code++) {
    let remaining = code; const colors = ids.map(() => { const color = remaining % n; remaining = Math.floor(remaining / n); return color; });
    if (conflicts.some(([a, b]) => colors[ids.indexOf(a)] === colors[ids.indexOf(b)])) continue;
    const groups = Array.from({ length: n }, (_, color) => ids.filter((id, i) => colors[i] === color)).filter(group => group.length).sort((a, b) => a[0] < b[0] ? -1 : 1);
    found.set(JSON.stringify(groups), groups);
  }
  const partitions = [...found.values()].sort((a, b) => a.length - b.length || lex(a, b));
  return { batches: partitions[0], tiedOptimalCount: partitions.filter(p => p.length === partitions[0].length).length,
    counts: ids.map((id, i) => ({ batchCount: i + 1, count: partitions.filter(p => p.length === i + 1).length })), partitions };
}
function checkPartition(input, decisions, result) {
  const ids = input.items.map(item => item.id).sort(); assert.deepEqual(result.batches.flat().sort(), ids);
  assert.equal(new Set(result.batches.flat()).size, ids.length); assert.ok(result.batches.every(batch => batch.length));
  const pairs = itemsFor(input);
  for (const batch of result.batchEvidence) {
    assert.deepEqual(batch.compatiblePairIds, pairs.filter(pair => batch.itemIds.includes(pair.left) && batch.itemIds.includes(pair.right)).map(pair => pair.id));
    for (const pairId of batch.compatiblePairIds) assert.equal(decisions.find(d => d.pairId === pairId).choice, 'compatible');
  }
  for (const pair of result.conflictingPairs) assert.ok(!result.batches.some(batch => batch.includes(pair.left) && batch.includes(pair.right)));
  for (const evaluation of result.evaluations) {
    const rejected = result.conflictingPairs.filter(pair => evaluation.batches.some(batch => batch.includes(pair.left) && batch.includes(pair.right))).map(pair => pair.id);
    assert.deepEqual(evaluation.conflictingPairIds, rejected); assert.equal(evaluation.feasible, rejected.length === 0);
  }
}

test('all 1098 simple conflict graphs on two through five items match independent labeled-color assignments', () => {
  let graphs = 0;
  for (let n = 2; n <= 5; n++) {
    const input = batchInput(['a', 'b', 'c', 'd', 'e'].slice(0, n)), pairs = itemsFor(input);
    for (let mask = 0; mask < 2 ** pairs.length; mask++) {
      const conflicts = pairs.filter((pair, i) => mask & 1 << i).map(pair => [pair.left, pair.right]), decisions = decisionsFor(input, conflicts);
      const expected = colorOracle(input, conflicts), actual = analyzeBatches(input, decisions);
      assert.deepEqual(actual.batches, expected.batches); assert.equal(actual.minimumBatchCount, expected.batches.length);
      assert.equal(actual.tiedOptimalCount, expected.tiedOptimalCount); assert.deepEqual(actual.feasibleCountsByBatchCount, expected.counts);
      assert.deepEqual(actual.evaluations.filter(e => e.feasible).map(e => e.batches), expected.partitions);
      checkPartition(input, decisions, actual); graphs++;
    }
  }
  assert.equal(graphs, 1098);
});

test('all-compatible, all-conflicting, odd cycles, isolates and optimum ties remain explicit', () => {
  const input = batchInput(['a', 'b', 'c', 'd', 'e']);
  const compatible = analyzeBatches(input, decisionsFor(input)); assert.equal(compatible.minimumBatchCount, 1); assert.equal(compatible.evaluatedPartitionCount, 52);
  assert.deepEqual(compatible.feasibleCountsByBatchCount.map(x => x.count), [1, 15, 25, 10, 1]); assert.equal(compatible.tiedOptimalCount, 1);
  const complete = itemsFor(input).map(pair => [pair.left, pair.right]), separated = analyzeBatches(input, decisionsFor(input, complete));
  assert.deepEqual(separated.batches, [['a'], ['b'], ['c'], ['d'], ['e']]); assert.equal(separated.minimumBatchCount, 5); assert.equal(separated.tiedOptimalCount, 1);
  const cycle = analyzeBatches(input, decisionsFor(input, [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'a']]));
  assert.equal(cycle.minimumBatchCount, 3); assert.equal(cycle.tiedOptimalCount, 5);
  const isolated = analyzeBatches(input, decisionsFor(input, [['a', 'b'], ['c', 'd']])); assert.equal(isolated.minimumBatchCount, 2); assert.equal(isolated.tiedOptimalCount, 4);
  const three = batchInput(['a', 'b', 'c']), tied = analyzeBatches(three, decisionsFor(three, [['a', 'b']]));
  assert.deepEqual(tied.batches, [['a'], ['b', 'c']]); assert.equal(tied.tiedOptimalCount, 2);
});

test('canonical item and answer order preserve pair identity, tie selection, source and analysis hashes', async t => {
  const input = simple(), reversed = simple(); reversed.items.reverse();
  assert.deepEqual(validateInput(input), validateInput(reversed)); assert.deepEqual(itemsFor(input), itemsFor(reversed));
  const decisions = decisionsFor(input, [['alpha', 'beta']]); assert.deepEqual(analyzeBatches(input, decisions), analyzeBatches(reversed, decisions.reverse()));
  const s = await setup(t); await s.run(); const count = s.api.calls.length;
  for (const mutate of [x => { x.items[0].label = 'Changed meaning'; }, x => { x.context = 'Different batch scope'; }, x => { x.items[0].id = 'renamed'; }]) {
    const changed = simple(); mutate(changed); await assert.rejects(s.run({ input: changed })); assert.equal(s.api.calls.length, count);
  }
  assert.equal((await s.run({ input: reversed })).status, 'pending');
});

test('real SDK mock collects all ten pairs before producing a bounded complete plan and private export', async t => {
  const input = batchInput(['a', 'b', 'c', 'd', 'e']), decisions = decisionsFor(input, [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'a']]);
  const s = await setup(t, input), result = await decide(s, decisions.map(d => d.choice));
  assert.equal(result.status, 'complete'); assert.equal(result.planReady, true); assert.equal(result.analysis.minimumBatchCount, 3); assert.equal(sends(s.api), 10);
  assert.deepEqual(result.analysis, analyzeBatches(input, decisions)); checkPartition(input, decisions, result.analysis);
  const exported = await exportPlan(s.directory, input), artifact = await readJson(exported.path);
  assert.deepEqual(artifact.source, validateInput(input)); assert.deepEqual(artifact.answers, result.answers); assert.deepEqual(artifact.analysis, result.analysis);
  assert.equal(artifact.jobsExecuted, false); assert.equal(artifact.pairwiseOnly, true); assert.equal(exported.analysisHash, result.analysis.analysisHash);
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.ok(Buffer.byteLength(JSON.stringify(artifact)) < 100000);
  const before = s.api.calls.length; await exportPlan(s.directory, input); assert.equal(s.api.calls.length, before);
  assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 10);
});

test('all-conflicting answers are complete; Unknown, unsupported, missing and terminal answers block a plan', async t => {
  const count = itemsFor(example).length, s = await setup(t); const separated = await decide(s, Array(count).fill('conflicting'));
  assert.equal(separated.status, 'complete'); assert.equal(separated.analysis.minimumBatchCount, example.items.length);
  for (const choice of ['unknown', 'unsupported']) {
    const other = await setup(t); const result = await decide(other, [...Array(count - 1).fill('compatible'), choice]);
    assert.equal(result.status, 'incomplete'); assert.equal(result.planReady, false); assert.equal(result.analysis, null); await assert.rejects(exportPlan(other.directory, example));
    assert.equal((await other.run()).status, 'incomplete'); assert.equal(sends(other.api), count);
  }
  const missing = await setup(t); await missing.run(); await assert.rejects(exportPlan(missing.directory, example));
  for (const terminal of ['expired', 'cancelled']) {
    const other = await setup(t); for (let i = 0; i < count; i++) { await other.run(); other.api.terminal(id(i + 1), terminal); if (terminal === 'expired') other.clock.value = new Date(Date.parse(other.clock.value) + 900000).toISOString(); await other.run(); }
    assert.equal((await localReport(other.directory, example)).analysis, null); await assert.rejects(exportPlan(other.directory, example));
  }
});

test('strict exact schemas, ID/text boundaries and complete unique pair answers reject invalid inputs', async t => {
  for (const mutate of [x => { x.extra = true; }, x => { x.items[0].extra = true; }, x => { x.items = x.items.slice(0, 1); },
    x => { x.items = Array(6).fill(x.items[0]); }, x => { x.items.push(x.items[0]); }, x => { x.items[0].id = '__proto__'; }, x => { x.items[0].id = 'constructor'; },
    x => { x.items[0].id = 'a'.repeat(13); }, x => { x.items[0].label = 'x'.repeat(61); }, x => { x.items[0].label = '\ud800'; },
    x => { x.batchId = 'x'.repeat(33); }, x => { x.title = 'x'.repeat(41); }, x => { x.context = 'x'.repeat(101); },
    x => { x.title = 'line\nbreak'; }, x => { x.context = 'bad\u202e'; }, x => { x.title = ' space'; }
  ]) { const invalid = simple(); mutate(invalid); assert.throws(() => validateInput(invalid)); }
  const s = await setup(t); for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => validateConnection({ token: 'token' + ending, room: ROOM_CODE })); assert.throws(() => iso(s.options.now() + ending)); assert.equal(isId(CONFIG.participant.id + ending), false);
  }
  assert.throws(() => validateConfig({ ...CONFIG, extra: true })); assert.throws(() => analyzeBatches(example, []));
  for (const mutate of [d => { d[0].choice = 'unknown'; }, d => { d[0].extra = true; }, d => { d[1] = d[0]; }, d => { d[0].pairId = 'pair-999'; }, d => { d.pop(); }, d => { d.push(d[0]); }]) {
    const invalid = decisionsFor(example); mutate(invalid); assert.throws(() => analyzeBatches(example, invalid));
  }
  assert.equal(s.api.calls.length, 0);
});

test('maximum Unicode prompts contain full labels, IDs and context for every pair within 500 characters', () => {
  const input = batchInput(Array.from({ length: 5 }, (_, i) => `i${i}`.padEnd(12, 'z')));
  input.batchId = 'b'.repeat(32); input.title = '😀'.repeat(20); input.context = '🦉'.repeat(50); input.items.forEach(item => { item.label = '🦉'.repeat(30); });
  const valid = validateInput(input), pairs = itemsFor(valid); assert.equal(pairs.length, 10);
  for (const pair of pairs) {
    const request = requestFor(valid, CONFIG, pair.id, id(1)); assert.ok(request.prompt.length <= 500);
    assert.ok(request.prompt.includes(input.context)); assert.ok(request.prompt.includes(input.title));
    for (const itemId of [pair.left, pair.right]) assert.ok(request.prompt.includes(`[${itemId}] ${input.items.find(item => item.id === itemId).label}`));
    assert.equal(request.context.length, 39); assert.deepEqual(request.options.map(o => o.value), ['compatible', 'conflicting', 'unknown']);
  }
});

test('locked, changed and corrupt exports preserve a previous plan; creation without a plan fails', async t => {
  const s = await setup(t); await assert.rejects(exportPlan(s.directory, example)); await decide(s, Array(itemsFor(example).length).fill('compatible'));
  const exported = await exportPlan(s.directory, example), before = await readFile(exported.path, 'utf8'), saved = await s.saved();
  const release = await acquireLock(s.directory); await assert.rejects(exportPlan(s.directory, example), /lock exists/); await release();
  const changed = simple(); changed.title = 'Changed'; await assert.rejects(exportPlan(s.directory, changed));
  saved.attempts[0].observation.answer.responderId = OTHER; await atomicJson(s.directory, 'state.json', saved);
  await assert.rejects(exportPlan(s.directory, example)); assert.equal(await readFile(exported.path, 'utf8'), before);
});
