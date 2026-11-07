import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__'].includes(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function pairsForItems(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) pairs.push({ id: `pair-${pairs.length + 1}`, left: items[i].id, right: items[j].id });
  return pairs;
}
function promptFor(input, pair) {
  const named = id => { const item = input.items.find(item => item.id === id); return `[${id}] ${item.label}`; };
  return `${input.title}\nBatch ${input.batchId}: ${input.context}\nA ${named(pair.left)}\nB ${named(pair.right)}\nIn this context, may this pair share one batch? Compatible=may share; Conflicting=must separate; Unknown=unsure. Judge pairwise only.`;
}
export function validateInput(input) {
  if (!keys(input, ['batchId', 'title', 'context', 'items']) || !word(input.batchId) || input.batchId.length > 32
    || !line(input.title, 40) || !line(input.context, 100) || !Array.isArray(input.items) || input.items.length < 2 || input.items.length > 5) throw new Error('Supply a batch ID, title up to 40, context up to 100 and 2–5 work items.');
  const ids = new Set();
  for (const item of input.items) {
    if (!keys(item, ['id', 'label']) || !safeId(item.id) || ids.has(item.id) || !line(item.label, 60)) throw new Error('Items require unique safe IDs up to 12 characters and labels up to 60.');
    ids.add(item.id);
  }
  const result = structuredClone(input); result.items.sort((a, b) => compare(a.id, b.id));
  for (const pair of pairsForItems(result.items)) if (promptFor(result, pair).length > 500) throw new Error('Pair prompt exceeds 500 characters.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact operator UUID and label.');
  return structuredClone(config);
}
export function itemsFor(rawInput) { return pairsForItems(validateInput(rawInput).items); }
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput), pair = itemsFor(input).find(item => item.id === itemId); validateConfig(config);
  if (!pair || !isId(attemptId)) throw new Error('Invalid pair or attempt.');
  const key = `batches-${attemptId}`;
  return { prompt: promptFor(input, pair), context: `To ${config.participant.id}`,
    options: [['compatible', 'Compatible'], ['conflicting', 'Conflicting'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), item_id: pair.id, left: pair.left, right: pair.right, attempt_id: attemptId }, idempotencyKey: key };
}

function listOrder(a, b, comparator) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const order = comparator(a[i], b[i]); if (order) return order; }
  return a.length - b.length;
}
const partitionOrder = (a, b) => listOrder(a, b, (left, right) => listOrder(left, right, compare));

/** Assign each successive item to an existing block or the next new block exactly once. */
function partitions(ids) {
  const result = [];
  function visit(index, batches) {
    if (index === ids.length) { result.push(batches.map(batch => [...batch])); return; }
    for (let block = 0; block <= batches.length; block++) {
      if (block === batches.length) { batches.push([ids[index]]); visit(index + 1, batches); batches.pop(); }
      else { batches[block].push(ids[index]); visit(index + 1, batches); batches[block].pop(); }
    }
  }
  visit(0, []); return result;
}

export function analyzeBatches(rawInput, decisions) {
  const input = validateInput(rawInput), pairs = itemsFor(input), ids = input.items.map(item => item.id);
  if (!Array.isArray(decisions) || decisions.length !== pairs.length || new Set(decisions.map(d => d?.pairId)).size !== pairs.length
    || decisions.some(d => !keys(d, ['pairId', 'choice']) || !pairs.some(pair => pair.id === d.pairId) || !['compatible', 'conflicting'].includes(d.choice))) throw new Error('Every unordered pair needs exactly one Compatible or Conflicting answer before planning.');
  const conflictingPairs = pairs.filter(pair => decisions.find(d => d.pairId === pair.id).choice === 'conflicting');
  const evaluations = partitions(ids).map(batches => {
    const conflictingPairIds = conflictingPairs.filter(pair => batches.some(batch => batch.includes(pair.left) && batch.includes(pair.right))).map(pair => pair.id);
    return { batches, feasible: conflictingPairIds.length === 0, conflictingPairIds };
  }).sort((a, b) => a.batches.length - b.batches.length || partitionOrder(a.batches, b.batches));
  const feasible = evaluations.filter(entry => entry.feasible), minimumBatchCount = feasible[0].batches.length;
  const batches = feasible[0].batches;
  const result = { status: 'planned', batches, minimumBatchCount,
    tiedOptimalCount: feasible.filter(entry => entry.batches.length === minimumBatchCount).length,
    feasibleCountsByBatchCount: ids.map((id, index) => ({ batchCount: index + 1, count: feasible.filter(entry => entry.batches.length === index + 1).length })),
    conflictingPairs, evaluatedPartitionCount: evaluations.length, evaluations,
    batchEvidence: batches.map(itemIds => ({ itemIds, compatiblePairIds: pairs.filter(pair => itemIds.includes(pair.left) && itemIds.includes(pair.right)).map(pair => pair.id) })),
    tieBreak: 'lexicographic item-ID lists; shorter equal prefixes first; batches ordered by their smallest item ID',
    pairwiseOnly: true, jobsExecuted: false };
  return { ...result, analysisHash: hash(result) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed batch model. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved pair classification or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}


export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = itemsFor(input).map(item => {
    const attempt = state.attempts.find(attempt => attempt.itemId === item.id), answer = attempt?.observation?.answer;
    return { pairId: item.id, left: item.left, right: item.right,
      status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked', choice: answer?.value ?? null, label: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null, responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = answers.find(item => ['create_unknown', 'pending'].includes(item.status));
  const complete = answers.every(item => item.status === 'answered' && ['compatible', 'conflicting'].includes(item.choice));
  const status = active?.status ?? (answers.some(item => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  const analysis = complete ? analyzeBatches(input, answers.map(({ pairId, choice }) => ({ pairId, choice }))) : null;
  return { batchId: input.batchId, sourceHash: hash(input), source: input, participant: state.config.participant, room: state.room,
    configHash: hash(state.config), answers, status, analysis, planReady: complete,
    unknownPairIds: answers.filter(item => item.choice === 'unknown').map(item => item.pairId),
    pairwiseOnly: true, jobsExecuted: false, actionsExecuted: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved pair classification evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered pair classifications must not contain pair classification evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved configuration, room, or operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
