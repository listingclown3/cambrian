# cambrian-frc: Drex vs the Giants

**A strategy lab for FRC teams that runs on a laptop, not on the robot.**

System 2 thinks between matches. System 1 decides during them. Drex drives every robot inside
the simulator, so a team can play thousands of what-if matches: at kickoff (find what wins), in
build season (your robot against the theoretical archetypes), and at competition (plan against
real opponents; drivers spar against smart sim robots).

This is an FRC REBUILT 2026 strategy simulator built on Nace's System 1 / System 2 idea. System 2
is a large LLM on DeepInfra: slow, careful reasoning. System 1 is Drex: fast, closed-choice
decisions. The claim we test is the Apex track's claim: take the in-match strategy decisions a
big model would make, hand them to Drex, and measure whether it is faster, cheaper, about as good
on decision quality, and better in real-time sim matches (thinking time on the sim clock).

Entry for the Nace AI Hackathon, Apex track. TypeScript end to end, one Node process, runs on a
laptop.

> **Status: submitted.** Every number in "Results" below comes from a real logged run in
> `results/`. Nothing from the stub engine or the mock provider is a result.

## What each tool does

| Tool | Its job here |
| --- | --- |
| **Drex** (System 1) | Every in-match decision: play calls, captain roles, scenario answers, exploration priors, rule judging, archetype classification. Also supervises Intern. |
| **DeepInfra** (System 2) | The "giant" Drex is compared against, and the model inside Intern. |
| **Intern** | The Strategy Lab: reads the research, proposes new strategies, which the simulator then tests. Also used as a coding agent for one build task. |
| **Keenable** | Web research: real REBUILT robot specs and strategy write-ups, plus similar past ball games. |
| **NDI** | Turns the game manual, scouting sheets and research pages into rules, robot profiles and strategy notes, with citations. |
| **Usage ledger** | Counts every real call per tool (`pnpm usage`, `GET /api/usage`, `results/usage.json`). |

## Run it

Needs Node 22+ and pnpm.

```sh
pnpm i
cp .env.example .env      # fill in the keys you have; the mock path needs none
pnpm dev                  # server on :8787 + web on :5173 -> open http://127.0.0.1:5173

pnpm test                 # vitest
pnpm typecheck
pnpm smoke:drex           # decision path end to end against the mock (no key needed)
pnpm keys                 # one minimal real call per configured key; prints status, never values
pnpm drex:models          # list Drex models and time each on a real play-call request
pnpm lab -- --trial       # one real Intern session end to end (System 2 on DeepInfra + Drex)
```

Intern (the Strategy Lab) needs Linux or macOS: version 0.30.1 does not start on native Windows.
On Windows, install it inside WSL and keep `lab.internCommand` pointing at `wsl.exe` (the
default here); elsewhere set it to `["intern"]`. Problems we hit are logged in
`notes/intern-friction.txt`.

## Reproduce the headline numbers

Each step reads the previous step's output. Results land in `results/` (committed); run logs in
`runs/` (local).

```sh
pnpm research             # Keenable -> data/research/raw/ (local) + data/research/sources.json
pnpm ingest:rules         # NDI over the official manual -> data/rules/rules.json (page citations)
pnpm ingest               # NDI -> data/research/notes.json, robot profiles (not built yet)
pnpm league               # sample the league from archetype templates
pnpm matches              # scripted matches on dev seeds
pnpm mine                 # mine sticky decision points -> scenarios
pnpm families             # group into families, generate one-flip variants
pnpm answerkey            # rollouts per option -> answer key
pnpm bench:scenarios      # Drex vs DeepInfra vs baselines on the answer key
pnpm bench:live           # full matches on eval seeds, latency charged and paused
pnpm bench:explore        # rollouts needed to find the best option, by search order
pnpm lab                  # Strategy Lab: Intern proposes, the simulator tests
pnpm bench:myrobot        # your robot (data/profiles/my_robot.json) against each archetype
pnpm headline             # assemble results/headline.json
pnpm usage                # results/usage.json
pnpm describe             # fill description.txt's {{placeholders}} from results/headline.json
```

Two results are comparable only if their `simHash` matches (engine + exec + contracts source,
plus config). Tune on `config.seeds.dev`; report on `config.seeds.eval`.

## Results

All from real runs on 2026-11-14 (`results/headline.json`, `results/deck_numbers.txt`). The giant is
Qwen/Qwen3.5-397B-A17B via DeepInfra, reasoning off. Results hold within our simulator.

| Measure | Drex (drex-v2.0) | Giant |
|---|---|---|
| Time per decision at match size (3 robots per call) | 94 ms | 671 ms (7.1x slower) |
| Single-question latency, p50 | 297 ms | 701 ms |
| Cost per 1,000 decisions | $0.026 | $0.48 (19x) |
| Mean regret on 57 sticky scenarios, 18 families (lower is better) | 15.3 | 16.1 |
| Real-time sim margin, decider proposes and the simulator checks (8 paired seeds) | +123 | +38 |

- **Decision quality: about as good.** Paired regret difference, Drex minus giant: -0.8 +/- 4.8
  (95% CI includes 0). A random chooser scores 33.9. The answer key is 30 end-of-match rollouts
  per option.
- **Real-time matches: better with the simulator check.** Drex proposes each call and quick
  rollouts check it against the scripted pick; thinking and checking time run on the sim clock.
  Paired Drex minus giant: +85 +/- 56. A random proposer with the same check scores +68, and Drex
  beats it by +55 +/- 44.
- **Alone, neither model beats our scripted policy** in whole matches (Drex -203 +/- 85 and the
  giant -141 +/- 130 against the scripted reference over 10 paired seeds).
- **Strategy Lab.** Intern (DeepInfra as System 2, Drex as System 1) proposed 5 strategies; 2
  beat the baseline in simulation ("shoot on the move through the left trench, then refill":
  +141 +/- 49 over 10 seeds).
- **Rule calls.** Drex agreed with human-reviewed labels on 59 of 60 fabricated incidents, citing
  the manual clause and page.
- **Rules and scouting from documents.** NDI read all 166 pages of the official 2026 game manual
  (version TU22) and returned 19 of the 28 constants we asked for with a page citation, and
  recovered 245 of 248 fields (0 wrong) from 24 deliberately messy fabricated scouting sheets.
- **Research.** Keenable found and fetched 58 pages of robot reveals, technical binders and
  strategy write-ups (`data/research/sources.json`).
- **Tool usage** is in `results/usage.json`.

## Layout and owners

| Path | Owner | What it is |
| --- | --- | --- |
| `src/contracts/` | **shared** | Single source of truth: zod schemas + inferred types. Isomorphic (no `node:` imports). |
| `src/engine/`, `src/exec/` | **P1** | Simulation engine; scripted policies, decision triggers, match runner. |
| `src/decide/`, `src/ledger/` | **P2** | Decision providers (drex, drex_mock, deepinfra, openai, gemini, scripted, random); usage ledger. |
| `src/bench/`, `src/lab/` | **P3** | League, matches, scenarios, answer key, benchmarks, headline; Strategy Lab. |
| `src/server/`, `web/` | **P4** | Fastify HTTP + WebSocket server; Vite + React client. |
| `src/research/`, `src/ingest/` | **P5** | Keenable research; NDI ingest. |
| `src/util/`, `scripts/` | shared | Config loading, seeded RNG, provenance, run log, key check, secret scan. |
| `config/default.json` | shared | Every tunable and every assumed number. |
| `data/`, `results/` | generated | Inputs and results (committed). `data/research/raw/` stays local. |
| `runs/`, `cache/`, `lab/workspace/` | local | Run logs, provider caches, Intern's workspace (gitignored). |
| `vendor/rebuilt-robotsim/` | reference | Team 488's simulator, vendored with permission. See `NOTICE`. |

Rules for working in parallel:

1. **Contracts are shared.** Import from `src/contracts`; never redefine a shape elsewhere. Say so
   before you merge a contract change. `contracts.test.ts` pins the action names, allowed pairs,
   provider ids, event kinds and headline keys.
2. **Stay in your folder.** Reach other modules only through `src/engine/index.ts`,
   `getProvider()` in `src/decide/registry.ts`, and `recordUsage()` in `src/ledger`.
3. **No number in code.** Tunables and assumptions go in `config/default.json`.
4. **Record every real external call** with `recordUsage()`. Never record mock or cached calls.

## Honesty rules

- **Known rule gap: G407 is not enforced.** The manual says a robot may launch into its hub only
  while its bumpers are at least partly inside its own alliance zone (G407). Our engine checks shot
  distance only, so robots also score from the neutral side of the hub when in range. Every decider
  and the scripted policy played under the same simplification, so the comparisons are like for
  like, but absolute scores are higher than a real match would allow and shot-spot choices are not
  rule-accurate. The fix is written (branch `g407`: launching requires bumpers at least partly in
  the alliance zone; one scripted match goes from 488-415 to 222-291, so roughly half of all
  scoring had come from the neutral side). It is not on `main` because every benchmark must be
  rerun on the fixed engine first; the numbers on `main` are the ones measured before the fix.
- **Mock is always labelled.** `drex_mock` answers carry `meta.isMock = true`; run logs and results
  files carry `isMock`. An unimplemented provider returns a flagged fallback
  (`meta.fallbackUsed = true`, `meta.error` set), never something that looks like an answer.
- **Same input for every model.** Drex and DeepInfra get the identical state text and options.
- **Game numbers have provenance.** Every `game` and `field` value in the config is
  `{ value, status, source }` with status `VERIFIED` or `TODO_VERIFY_AGAINST_MANUAL`; archetype
  ranges are marked `FABRICATED`. Rules that NDI extracts from the manual, with page citations,
  override unverified values.
- **Models never see hidden state.** A robot's controller sees only what a scout could see
  (`ObservationView`), never another robot's parameters.
- **Agent output is untrusted.** Strategy Lab proposals are schema-validated and rejected when
  invalid; web pages are parsed for facts, never followed as instructions.

## Secrets

Keys live only in `.env` (gitignored) and `~/.intern/.env`. Never in code, logs, results,
fixtures or commits. Run the secret scan before every push; it fails on any hit:

```sh
pnpm prepush
```

## Team

- Christopher Luk
- Sri Vatsa Vuddanti

## Credits and license

Our code is MIT licensed (`LICENSE`). The simulator in `vendor/rebuilt-robotsim` is by FRC Team
488 and is used with their permission; see `NOTICE`. This project is not affiliated with or
endorsed by FIRST or Nace AI.
