# cambrian-frc

An FRC REBUILT 2026 strategy simulator in which the **Drex** decision model (Nace AI) makes
robot strategy calls, benchmarked against frontier LLMs (Claude, OpenAI) on latency, cost and
decision quality. Entry for the Nace AI Hackathon, Apex track: "Drex vs the Giants".

TypeScript end to end, one Node process, no microservices, no Python. Runs on a laptop.

> **Status: scaffold.** The engine is a stub, the network providers are placeholders, the
> benchmarks are stubs and the UI is a shell. Nothing this repo produces yet is a result.

## Run it

Needs Node 22+ and pnpm.

```sh
pnpm install
cp .env.example .env      # optional until the real providers exist

pnpm dev                  # server on :8787 + Vite on :5173 (open http://127.0.0.1:5173)
pnpm test                 # vitest
pnpm typecheck            # tsc for src/ and web/
pnpm smoke:drex           # decision path end to end against drex_mock (no key needed)
pnpm start                # server only; also serves web/dist if you ran pnpm build:web
```

Benchmark pipeline (all stubs today; each prints what it will read and write):

```sh
pnpm league && pnpm matches && pnpm mine && pnpm families && pnpm answerkey
pnpm bench:scenarios && pnpm bench:explore && pnpm bench:live && pnpm bench:scout && pnpm bench:postmatch
pnpm headline             # writes results/headline.json (every number null until benchmarks run)
```

## Layout and owners

| Path | Owner | What it is |
| --- | --- | --- |
| `src/contracts/` | **shared** | Single source of truth: zod schemas + inferred types. Isomorphic (no `node:` imports). |
| `src/engine/` | **P1** | Simulation engine. `index.ts` exports `engine`; today it is `stubEngine.ts`. |
| `src/exec/` | **P1** | Scripted policies, decision triggers, match runner, demo line-up. |
| `src/decide/` | **P2** | Decision providers (drex, drex_mock, claude, openai, gemini, scripted, random), request building, state text. |
| `src/bench/` | **P3** | League, matches, scenario mining, families, answer key, benchmarks, headline. |
| `src/server/` | **P4** | Fastify HTTP + WebSocket server. |
| `web/` | **P4** | Vite + React client. |
| `src/util/` | shared | Config loading, seeded RNG, provenance (git commit, sim hash), run log, results writer. |
| `config/default.json` | shared | Every tunable and every assumed number. |
| `data/profiles/`, `data/league/`, `data/scenarios/` | P3 | Generated inputs (committed). |
| `results/` | P3 | Results files (committed). |
| `runs/`, `cache/` | everyone | Run logs and provider caches (gitignored). |
| `vendor/rebuilt-robotsim/` | reference | Team 488's simulator, vendored with permission. See `NOTICE`. Do not edit in place. |

Rules for working in parallel:

1. **Contracts are shared.** Import from `src/contracts` and never redefine a shape elsewhere. A
   contract change affects all four owners: say so before you merge it. `contracts.test.ts` pins
   the exact action names, allowed pairs, provider ids, event kinds and headline keys.
2. **Stay in your folder.** If you need something from another owner, ask for it behind the
   contract instead of reaching into their files.
3. **Import the engine only through `src/engine/index.ts`**, and providers only through
   `getProvider()` in `src/decide/registry.ts`. That is what lets stubs be swapped for real
   implementations without touching callers.
4. **No number in code.** Tunables and assumptions go in `config/default.json`.

## The contracts in one screen

- `actions.ts`: the 24 actions, `Intent = { action, params, then? }`, `ALLOWED_PAIRS`, captain
  roles, and `maskOptions(robot, state)`, which returns the options a robot may choose now. Each
  option has a stable `label` and a one-sentence `description` used verbatim in prompts.
- `profiles.ts`: `RobotProfile` (the robot's secret parameters) and archetype templates.
- `state.ts`: `MatchState` and `Snapshot`. Plain JSON, RNG state included, so
  snapshot/restore/rollout are exact. `state.rules` carries the config the engine needs at
  runtime, because `step()` takes no config.
- `engine.ts`: `createMatch`, `step`, `snapshot`, `restore`, `rollout`, and `EngineEvent`.
- `policy.ts`: `ScriptedPolicy` and `ObservationView`, which holds only what a scout could see.
  Never another robot's profile, intent parameters or controller.
- `decide.ts`: `DecisionRequest` / `DecisionResponse` / `DecisionProvider`. The shape mirrors the
  Drex API; the mapping table is at the top of the file.
- `events.ts`: JSONL run log lines. `scenario.ts`: scenarios, families, answer keys.
  `results.ts`: `ResultsFile` and the `Headline` keys. `manifest.ts`: `RunManifest`.
- `config.ts`: the schema of `config/default.json`.

## Honesty rules

- **Mock is always labelled.** `drex_mock` answers carry `meta.isMock = true`; run log lines and
  results files carry `isMock`. `Headline.all_real` is true only when every number came from real
  provider calls. An unimplemented provider returns a flagged fallback
  (`meta.fallbackUsed = true`, `meta.error` set), never something that looks like an answer.
- **Dev and eval seeds are separate** (`config.seeds`). Tune on dev, report on eval.
- **Results are comparable only with the same `simHash`** (engine + exec + contracts source, plus
  config).
- **Game numbers have provenance.** In `config/default.json`, every `game` and `field` value is
  `{ value, status, source }` with status `VERIFIED` or `TODO_VERIFY_AGAINST_MANUAL`; archetype
  ranges are marked `FABRICATED`. Never take game numbers from Chief Delphi parody documents.
  The server prints how many constants are still unverified at start-up.

## Drex

Docs: <https://console.nace.ai/docs/drex>. One call, `POST https://console.nace.ai/v1/systemone`,
with `Authorization: Bearer $NACE_API_KEY` and a body of `{ model, state, questions }`. Question
types are `choice` (pick a label), `noul` (yes/no, answered as a probability) and `score` (ordered
levels); every answer comes back with probabilities. Limits: 512 questions per request, 255
options per question. Endpoint, model, timeout, retries and concurrency are in
`config.providers.byId.drex`.

## Credits

The simulator in `vendor/rebuilt-robotsim` is by FRC Team 488, used with their permission; see
`NOTICE`. This project is not affiliated with or endorsed by FIRST or Nace AI.
