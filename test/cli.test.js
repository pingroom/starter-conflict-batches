import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const store = process.env.PROBE_STORE;
const questions = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const save = () => writeFileSync(store, JSON.stringify(questions));
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Unexpected network operation');
  const url = new URL(raw), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({method:init.method,path}) + '\n');
  const participant = '11111111-1111-4111-8111-111111111111';
  if (init.method === 'GET' && path === '/api/agent/rooms') return Response.json([
    {invite_code:'DEMO12345678',type:'standard',is_public:false,members:[{user_id:participant}]}
  ]);
  if (init.method === 'POST' && path === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    const question = {id:'01990000-0000-7000-8000-' + String(questions.length+1).padStart(12,'0'),
      kind:'question',is_handoff:false,prompt:body.prompt,context:body.context,
      options:body.options.map(({value,label})=>({value,label,primary:false,destructive:false})),
      text_input:null,responder_scope:'direct',target_user_id:participant,resolution_policy:'first',
      state:'pending',results:null,answer:null,expires_at:new Date(Date.parse(now)+900000).toISOString(),
      resolved_at:null,correlation_id:body.correlation_id,reply_to:null,data:body.data,created_at:now,
      room_code:'DEMO12345678',room:{code:'DEMO12345678'},asker:{type:'agent',id:'33333333-3333-4333-8333-333333333333'}};
    questions.push(question); save();
    if(process.env.PROBE_LOST === 'yes') throw new Error('Lost response after POST');
    return Response.json(question,{status:201});
  }
  if (init.method === 'GET' && path === '/api/agent/questions') return Response.json({questions});
  const q = questions.find(q=>path === '/api/agent/questions/' + q.id);
  if (init.method === 'GET' && q) {
    const value = process.env.PROBE_ANSWER;
    if (value && q.state === 'pending') {
      q.state='answered';q.resolved_at=new Date().toISOString();
      q.answer={value,label:q.options.find(o=>o.value===value)?.label??'Unsupported',text:null,responder:{id:process.env.PROBE_BAD_ATTR==='yes'?'22222222-2222-4222-8222-222222222222':participant},answered_at:q.resolved_at};save();
    }
    if(process.env.PROBE_CANCEL==='yes'){q.state='cancelled';q.resolved_at=new Date().toISOString();q.answer=null;save();}
    return Response.json(q);
  }
  throw new Error('Unexpected mock request');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'batches-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp(join(source,'src'),join(directory,'src'),{recursive:true});
  await cp(join(source,'package.json'),join(directory,'package.json'));
  await cp(join(source,'config.example.json'),join(directory,'config.json'));
  const input=JSON.parse(await readFile(join(source,'examples/model.json'),'utf8'));
  await writeFile(join(directory,'model.json'),JSON.stringify(input));
  await symlink(join(source,'node_modules'),join(directory,'node_modules'));
  await writeFile(join(directory,'preload.mjs'),preload);
  return directory;
}
function cli(directory,command='run',{answer='',lost=false,offline=false,argument,envOverride={}}={}) {
  const env={...process.env,PINGROOM_TOKEN:'offline-fixture-token',PINGROOM_ROOM:'DEMO12345678',
    PROBE_STORE:join(directory,'questions.json'),PROBE_LOG:join(directory,'requests.jsonl'),
    PROBE_ANSWER:answer,PROBE_LOST:lost?'yes':'no',PROBE_OFFLINE:offline?'yes':'no'};
  Object.assign(env,envOverride);
  for(const key of Object.keys(env))if(env[key]===undefined)delete env[key];
  delete env.NODE_OPTIONS;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',join(directory,'preload.mjs'),join(directory,'src/cli.js'),command,...(argument?[argument]:[])],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,json:stdout.trim().startsWith('{')?JSON.parse(stdout):null});});
  });
}
const requests=async directory=>(await readFile(join(directory,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const posts=async directory=>(await requests(directory)).filter(c=>c.method==='POST').length;

async function expect(directory,command,options,code,status) {
  const result=await cli(directory,command,options);
  assert.equal(result.code,code,result.stderr||result.stdout);assert.equal(result.json.status,status);return result.json;
}



async function complete(directory, values = Array(6).fill('compatible')) {
  let result;
  for (let i = 0; i < values.length; i++) {
    await expect(directory, 'run', {}, 3, 'pending');
    const last = i === values.length - 1, status = !last ? 'ready' : values.includes('unknown') ? 'incomplete' : 'complete';
    result = await expect(directory, 'run', { answer: values[i] }, last ? status === 'complete' ? 0 : 2 : 3, status);
  }
  return result;
}

test('CLI collects every unordered pair and exports a complete plan locally with provenance', async t => {
  const directory = await fixture(t), original = await readFile(join(directory, 'model.json'), 'utf8');
  const preview = await cli(directory, 'preview', { offline: true }); assert.equal(preview.code, 0, preview.stderr); assert.equal(preview.json.items.length, 4);
  const done = await complete(directory); assert.deepEqual(done.analysis.batches, [['alpha', 'beta', 'delta', 'gamma']]); assert.equal(await posts(directory), 6);
  await expect(directory, 'run', { offline: true }, 0, 'complete');
  const saved = await expect(directory, 'report', { offline: true }, 0, 'complete');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.batches/report.json'), 'utf8')), saved);
  const exported = await expect(directory, 'export', { offline: true, envOverride: { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined } }, 0, 'complete');
  const artifact = JSON.parse(await readFile(exported.path, 'utf8')); assert.deepEqual(artifact.source, done.source); assert.deepEqual(artifact.answers, done.answers); assert.deepEqual(artifact.analysis, done.analysis);
  assert.equal(exported.analysisHash, done.analysis.analysisHash); assert.equal(exported.sourceHash, done.sourceHash);
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.equal(await readFile(join(directory, 'model.json'), 'utf8'), original);
  assert.equal(artifact.jobsExecuted, false); assert.equal(artifact.pairwiseOnly, true);
});

test('CLI blocks incomplete evidence but exports all-conflicting answers as singleton batches', async t => {
  const directory = await fixture(t); assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  const incomplete = await complete(directory, [...Array(5).fill('compatible'), 'unknown']); assert.equal(incomplete.analysis, null); assert.equal(incomplete.planReady, false);
  assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  await assert.rejects(readFile(join(directory, '.batches/plan.json')), { code: 'ENOENT' });
  await expect(directory, 'run', { offline: true }, 2, 'incomplete'); assert.equal(await posts(directory), 6);
  const other = await fixture(t), completeResult = await complete(other, Array(6).fill('conflicting'));
  assert.equal(completeResult.planReady, true); assert.deepEqual(completeResult.analysis.batches, [['alpha'], ['beta'], ['delta'], ['gamma']]);
  const exported = await expect(other, 'export', { offline: true }, 0, 'complete');
  assert.deepEqual(JSON.parse(await readFile(exported.path, 'utf8')).analysis, completeResult.analysis); assert.equal(await posts(other), 6);
});

test('CLI recovers the original uncertain pair without creating another Question', async t => {
  const directory = await fixture(t);
  await expect(directory, 'run', { lost: true }, 4, 'create_unknown'); await expect(directory, 'run', { offline: true }, 4, 'create_unknown');
  const found = await expect(directory, 'find', {}, 4, 'create_unknown'); assert.equal(found.candidates.length, 1);
  const qid = found.candidates[0].id, ready = await expect(directory, 'recover', { argument: qid, answer: 'compatible' }, 3, 'ready');
  assert.equal(ready.answers[0].questionId, qid); assert.equal(ready.answers[0].choice, 'compatible'); assert.equal(await posts(directory), 1);
});

test('CLI rejects unsupported, misattributed and cancelled answers without replacing the original pair', async t => {
  for (const options of [{ answer: 'unsupported' }, { answer: 'compatible', envOverride: { PROBE_BAD_ATTR: 'yes' } }, { envOverride: { PROBE_CANCEL: 'yes' } }]) {
    const directory = await fixture(t); await expect(directory, 'run', {}, 3, 'pending');
    const result = await expect(directory, 'run', options, 2, 'ready'); assert.equal(result.analysis, null);
    assert.ok(['invalid_answer', 'cancelled'].includes(result.observedStatus)); assert.equal(await posts(directory), 1);
    assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  }
});

test('CLI rejects partial environment pairs; complete dotenv setup works', async t => {
  const directory = await fixture(t); await writeFile(join(directory, '.env'), 'PINGROOM_TOKEN=dotenv-fixture\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = await cli(directory, 'run', { envOverride: { PINGROOM_TOKEN: 'external-fixture', PINGROOM_ROOM: undefined } });
  assert.equal(partial.code, 1); assert.match(partial.stderr, /complete PINGROOM_TOKEN/); await assert.rejects(readFile(join(directory, 'requests.jsonl')), { code: 'ENOENT' });
  await expect(directory, 'run', { envOverride: { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined } }, 3, 'pending');
});

test('CLI rejects model drift, duplicate items and arbitrary file arguments before network', async t => {
  const directory = await fixture(t); await complete(directory); const before = (await requests(directory)).length;
  assert.equal((await cli(directory, 'export', { argument: '/etc/passwd', offline: true })).code, 1);
  const input = JSON.parse(await readFile(join(directory, 'model.json'), 'utf8')); input.items[0].label = 'Another meaning';
  await writeFile(join(directory, 'model.json'), JSON.stringify(input));
  assert.equal((await cli(directory, 'run')).code, 1); assert.equal((await cli(directory, 'export', { offline: true })).code, 1); assert.equal((await requests(directory)).length, before);
  const invalid = await fixture(t), bad = JSON.parse(await readFile(join(invalid, 'model.json'), 'utf8')); bad.items.push(bad.items[0]);
  await writeFile(join(invalid, 'model.json'), JSON.stringify(bad)); assert.equal((await cli(invalid, 'run', { offline: true })).code, 1);
  await assert.rejects(readFile(join(invalid, 'requests.jsonl')), { code: 'ENOENT' });
  assert.equal((await cli(invalid, 'recover', { argument: 'not-a-uuid', offline: true })).code, 1);
});
