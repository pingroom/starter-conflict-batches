import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportPlan } from './engine.js';
import { readJson } from './storage.js';
import { itemsFor } from './model.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/model.json', import.meta.url), 65536), pairCount = itemsFor(input).length;
for (const scenario of [
  { name: 'One conflicting pair', choices: ['conflicting', ...Array(pairCount - 1).fill('compatible')], expected: 2 },
  { name: 'Every pair conflicts', choices: Array(pairCount).fill('conflicting'), expected: input.items.length },
  { name: 'Unknown pair withholds the plan', choices: [...Array(pairCount - 1).fill('compatible'), 'unknown'], expected: null }
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-batches-demo-'));
  try {
    const now = () => '2026-11-07T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const choice of scenario.choices) {
      result = await step(options); api.answer(result.answers.find(answer => answer.status === 'pending').questionId, choice); result = await step(options);
    }
    assert.equal(result.analysis?.minimumBatchCount ?? null, scenario.expected);
    if (result.planReady) { const exported = await exportPlan(directory, input); assert.deepEqual((await readJson(exported.path)).analysis, result.analysis); }
    else await assert.rejects(exportPlan(directory, input));
    console.log(JSON.stringify({ scenario: scenario.name, status: result.status, planReady: result.planReady,
      analysis: result.analysis && { batches: result.analysis.batches, minimumBatchCount: result.analysis.minimumBatchCount, tiedOptimalCount: result.analysis.tiedOptimalCount }, jobsExecuted: false }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline SDK mock demo only. No live pings or jobs executed. Batch order is not an execution schedule.');
