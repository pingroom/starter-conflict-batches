# Conflict-free batches with PingRoom

Ask a named operator which work items can share a batch, then compute the fewest batches that respect every reported conflict. This starter collects **Compatible**, **Conflicting** or **Unknown** for every unordered pair through the official PingRoom SDK. Application code enumerates the partitions and exports a deterministic plan; it never runs the jobs.

Use this for a small work list whose pairwise restrictions are known to an operator but missing from its data. The demo uses harmless paper tasks to cover one conflict, every pair conflicting, and an unresolved pair.

## Run offline

Requires Node.js 22 or newer and npm. Choose **Use this template**, clone your copy, then run:

```sh
npm ci
npm test
npm run demo
```

Tests and demo use the real pinned `@pingroom/sdk` with mock transports. After installation, they need no network, credentials, phone or account. The lockfile is committed; `.npmrc` requests a 14-day minimum release age on npm versions that support it.

## Define the work

```sh
cp examples/model.json model.json
cp config.example.json config.json
npm run preview
```

Edit `model.json` before starting:

- `batchId`: up to 32 ASCII characters, beginning with a lowercase letter, followed by lowercase letters, digits, `_` or `-`.
- `title`: up to 40 UTF-16 code units; `context`: up to 100. Describe what sharing a batch means for this work.
- `items`: 2–5 distinct `{ "id", "label" }` records. IDs start with a lowercase letter, use lowercase letters, digits, `_` or `-`, and have at most 12 characters. Labels allow 60 UTF-16 code units and should describe the whole work item.

Extra fields, duplicate/reserved IDs, blank text, unpaired surrogates, control/format characters, line breaks and surrounding whitespace are rejected. Each prompt must fit the full labels and context within 500 characters. Code generates every unordered pair: two items need one Question; five need ten. Unanswered pairs cannot be omitted or assumed compatible.

## Connect and collect answers

Install [PingRoom](https://pingroom.io/i) and create a private standard room containing the operator.

```sh
npm run connect
npm run inspect
```

Open the printed pairing link, approve the connection and grant the room. Verify the person in the app, then put their exact member UUID and a descriptive label in `config.json`; a name alone is insufficient. For an existing granted connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial credential pairs are rejected.

```sh
npm start
```

Each invocation creates at most one direct, 15-minute Question or reads the existing one. After the operator answers, run `npm start` to record the response, then again for the next pair. Each prompt includes the title, batch context, both IDs and both full labels.

- **Compatible:** this pair may share a batch in the stated context.
- **Conflicting:** this pair must be separated.
- **Unknown:** the operator cannot decide.

Every pair needs Compatible or Conflicting before planning. Unknown, missing, expired, cancelled, unsupported or misattributed answers block the plan. Conflicting is complete: even when every pair conflicts, one batch per item is feasible. Answer evidence must match the original request, room, operator, asking registration and time window.

## Read the plan

```sh
npm run status
npm run report
npm run export
```

These commands are local. `report` writes `.batches/report.json`; `export` requires complete answers and writes `.batches/plan.json`. Read `planReady`, `analysis.batches`, `analysis.minimumBatchCount` and `analysis.tiedOptimalCount`.

The artifact includes the frozen source, answer provenance, conflict pairs and the compatible pair IDs within each chosen batch. `evaluations` records every tested partition and the conflicts that reject it; `feasibleCountsByBatchCount` shows how many partitions work at each batch count. Every item appears exactly once.

Items are vertices and conflicts are edges. A valid batch is a color class; minimizing batches is minimum vertex coloring, as described in [Wolfram's graph-coloring documentation](https://reference.wolfram.com/language/ref/FindVertexColoring.html). Code checks every partition, at most 52 for five items. It minimizes batch count, then breaks ties lexicographically using sorted item-ID lists: shorter equal prefixes come first, and batches are ordered by their smallest item ID. `tiedOptimalCount` counts distinct partitions, not permutations of batch names.

**Canonical batch order is serialization only. It expresses no priority, timing or execution sequence.** This is a pairwise model: compatible pairs do not establish compatibility of a larger group. The starter handles no capacities, durations, precedence, resource totals or other higher-order constraints. A correct calculation does not verify the operator's judgments or make the plan safe to execute.

To adapt it, put your work list in `model.json`, make the batch context explicit, and pass the exported ID groups to your planning process. Check constraints outside this model before adding execution code.

## Resume safely

Root inputs, credentials, state and exports are ignored by Git. Keep `.batches/` and `.pingroom/` private and intact. Source, participant and connection are fixed for a session. Reordering items is harmless; other model changes require a new session. Input/config limits are 64/16 KiB. Writes are atomic under a local lock; invalid evidence preserves existing exports.

A lost creation response leaves `create_unknown`, with the original intent saved. It is never automatically resent:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. No match in a bounded search does not prove creation failed; keep state and inspect PingRoom if uncertain. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending file. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for a revised model; never delete state to retry.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence; `2` incomplete/failed answer; `3` pending/ready/interrupted; `4` uncertain creation.

Tests compare every conflict graph on two through five items with an independent labeled-color oracle, plus SDK/CLI, identity, recovery, storage and export checks. GitHub Actions runs tests and demo on Node.js 22 and 24. Live phone delivery is not tested.

MIT licensed.
