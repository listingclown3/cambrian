# Cambrian

**Guided quirk discovery: find the strategies nobody planned, without brute-force RL.**

This repo is an idea and some early tries at it, published so others can explore it too. The
general idea is a hypothesis: nothing here proves it yet. Pick it up, break it, extend it.

## The idea

Breakthroughs in games and simulations often come from **quirks**: behaviour the designers never
intended. A quirk is often useless alone and dominant in combination. In Polytrack, flying off an
edge was the meta until someone found that riding the side curb and staying on the down-ramp
carried far more speed.

Reinforcement learning finds quirks by brute force. It spends most of its budget in places a model
with history and common sense would skip. OpenAI's hide-and-seek agents found "box surfing", a
physics exploit, but only after about 380 million episodes (Baker et al. 2020).

Cambrian tries to guide that search instead:

1. **Goal.** You state a goal in plain words ("max points", "don't get defended"). It becomes
   measurable metrics, and **you approve them before any search starts**.
2. **World.** Either *bring your own* (plug in an existing sim and its rules) or *built for you*
   (a capable model writes the world from your description and researched sources).
3. **History.** Past versions of the domain (older games, patches, known metas) seed the search.
4. **Borrow.** Ideas also come from other fields that solved an analogous problem. Example: the
   2026 FRC game asks "what is the best way to index balls?", and paintball loaders already feed
   round objects fast without jamming. Borrowed ideas become candidates with their source cited,
   and are tested like anything else.
5. **Explore.** A cheap, fast model makes the many steering decisions: what to try, what to vary,
   where to go back to.
6. **Notice.** A result is a quirk when it differs from what the prior predicted by more than the
   noise (outside the 95% confidence interval). This is Bayesian surprise (Itti & Baldi). Quirks
   that lose on their own still count.
7. **Archive.** Each quirk is stored with its start conditions, end state, effect, legality and
   reproducibility. The archive is a **graph**: quirk A links to quirk B when A's end state meets
   B's start conditions.
8. **Chain.** Paths through the graph combine quirks into strategies. A chain can start anywhere,
   skip links and run hundreds deep; its shape is up to you.
9. **Exploit.** The steering model returns to promising states. RL is used only where precise
   execution matters, and starts from archived quirk states.
10. **Triage.** Real quirk, or a bug in the world? In a sim of something real, most "quirks" will
    be sim bugs. The cause is traced in the world code and checked against the sources.
11. **Credit back.** Quirks that keep appearing in winning chains gain value even when they are
    useless alone ("stepping stones"), and the next round searches near them.

Quirks come at two levels: **play** (how to act: a route, a timing, a rule edge) and **design**
(what to build: a mechanism, a robot archetype). Design quirks change which play quirks are
reachable.

### Two kinds of world

- **Tier 1, the sim is the game** (video games, puzzles). Quirks are real by definition, and
  history (patch notes, speedrun records) supplies known answers to test against. This is where
  discovery can be proven.
- **Tier 2, the sim models reality** (robots, physics). A quirk only matters if it would work for
  real. The first world here, FRC REBUILT 2026, is Tier 2, and it already contains a sim bug the
  search exploited without noticing (see below). That is the case for the Triage step.

### Model tiers

| Tier | Model | Job | How often |
|---|---|---|---|
| World builder | Most capable model available | Builds the world; turns the goal into metrics | Once per world |
| Judge | Small models | Flags quirks, rates chains, checks legality | Often |
| Steering | Small, fast decision model (Drex today) | Picks the next action, link or state to revisit | Constantly |
| Execution | RL from archived states | Precise control where it matters | Only where needed |

Every model and service sits behind an interface, so no vendor is required. Any OpenAI-compatible
server works for steering and judging, including vLLM on your own GPU (see [Run it](#run-it)).

### Ways the steering model can help RL

| Mode | What it does | Status |
|---|---|---|
| Steer | Picks the state to return to and the parameter to vary | Has early data (below) |
| Confine | Masks *pointless* actions for RL; masks illegal ones only when rules are enforced, since illegal-looking actions are where quirks live | Idea |
| Shape | Bonus reward near likely quirks | Idea |
| Find, then refine | The search finds a quirk; RL starts from its archived states and hammers it down | Next to build |

## Status

What exists and what doesn't:

| Part | State |
|---|---|
| First world: FRC REBUILT 2026, bring your own, forked from Team 488's sim ([src/world/worlds/rebuilt](src/world/worlds/rebuilt)) | Working |
| World adapter interface ([src/world/types.ts](src/world/types.ts)) | Working; REBUILT implements it |
| History: Keenable web research, NDI document ingest (rules with page citations, robot pages, scouting sheets) | Working (needs keys) |
| Steering and judge providers: Drex, DeepInfra, any OpenAI-compatible server | Working |
| Search and document roles: Keenable, local text files | Working; NDI not yet wrapped as a role |
| Strategy proposals via Intern, legality checks via Drex ([src/search/proposals](src/search/proposals)) | Working; Intern needs Linux, macOS or WSL |
| Quirk archive graph: linking by conditions, chains, credit-back ([src/archive](src/archive)) | Working, minimal. Seeded with 11 quirks from the hackathon runs; those runs recorded no end states, so there are no links yet |
| Quirk test (surprise) | Working as a function; not yet wired into a search loop |
| Goal approval gate ([src/goal](src/goal)) | Working; turning words into metrics with a model is not built |
| Rules modes `off` / `flag` / `enforce`, defaults per world tier ([src/rules](src/rules)) | Working as functions; not yet wired into a search loop |
| Single cost unit in USD ([src/util/cost.ts](src/util/cost.ts)) | Working; not yet applied to the old benchmarks |
| **The end-to-end loop** (explore, notice, archive, chain, exploit) | **Not built** |
| Parametric actions, so discovery isn't just picking from a menu | Not built |
| Cross-domain borrowing | Not built |
| World built by a model from a description | Not built |
| RL from archived states ([src/rl](src/rl)) | Interface only |
| Baselines at equal cost; math validation | Planned (v2) |

## Early evidence (FRC REBUILT, Nov 14 2026)

These results come from logged runs in tag `nace-2026-submission` and hold within our simulator
only. Confidence intervals are 95%. Where we found problems after the event, they are stated
here, not hidden.

- **Guided search may be cheaper.** Ordering options by Drex's probabilities needed **27.5% fewer
  rollouts** to find the best one [13.5, 40.7] across 39 scenarios. On the 20 scenarios with a
  clear best option the saving was **12.1% [-4.6, 28.7]**, which could be zero.
  The large model (Qwen3.5-397B on DeepInfra, reasoning off) did no better than random ordering,
  but it was only asked for its top pick, not a full ranking. That comparison isn't fair yet.
- **Cheap steering.** Drex: 94 ms per decision at match size and $0.026 per 1,000 decisions,
  against 671 ms and $0.48 for the large model (7.1x faster, about 19x cheaper).
- **Decision quality was a tie.** Mean regret 15.3 vs 16.1 on 57 scenarios; paired difference
  -0.8 +/- 4.8. Alone, neither model beat the hand-written policy in full matches.
- **The simulator check did most of the work.** When quick rollouts checked each proposal in
  real-time matches, Drex reached a match margin of +122.9 +/- 49.2. A random proposer with the
  same check reached +67.6 +/- 26.2 (8 paired seeds; Drex minus random +55.3 +/- 44.4).
- **Proposed strategies.** Intern proposed 5; 2 could be tested and both beat the scripted
  baseline: "shoot on the move through the left trench, then refill" (+141.3 +/- 48.6, 10 seeds)
  and "spin out, then shadow-defend" (+66.2 +/- 36.7). The other 3 never triggered.
- **Rules from documents.** Drex matched human-reviewed labels on 59 of 60 generated rule incidents. NDI
  recovered 245 of 248 fields, with none wrong, from 24 deliberately messy generated scouting sheets.
- **Not evidence yet: the tower post-up.** Reading only the rules, Drex rated it RISKY (0.63 chance
  it breaks G210; 0.83 that its value depends on drawing opponent fouls). The sim showed 0 fouls
  and 0 points, but the opponent policy never defends, so no foul could happen. It needs a rerun
  against a defending opponent.

### The known quirk: G407

The engine on `main` doesn't enforce rule G407 (launch only from your own alliance zone), so
robots can score from the neutral side of the hub. The trench strategy above partly relies on it.
On branch `g407`, with the rule enforced, the trench strategy drops to +103.7 +/- 21.3. The gap is
kept on purpose as the first **rediscovery test**: with rules mode `off` and the goal "max points",
the system should find it, and in `flag` mode it should label it a likely world bug.

## Next tests

One unknown at a time. Each reports found / close / missed against thresholds set before the run
(definitions in [notes/decisions.md](notes/decisions.md)), with cost in one USD figure.

1. **Search only.** In the REBUILT world, with known answers: rediscover the G407 gap and
   trench shoot-on-the-move, starting from actions that don't already encode them.
2. **The math (v2).** On a synthetic "combination lock" world, check the core claim. If a quirk
   needs a chain of `d` specific steps, each taken with probability `p`, random search costs about
   `p^-d`, archive-and-return about `d/p`, and good priors raise `p`. The rollout savings would
   also be framed as best-arm identification with a prior.
3. **History and chains.** In a Tier 1 world, give only the history from before a known discovery
   and check whether the known trick is found.
4. **World building.** A model builds the world from a description; known quirks should appear,
   and none should come from world bugs.
5. **Baselines at equal cost.** Random search, novelty search and Go-Explore with no language
   model; an every-step large-model loop (Intelligent Go-Explore); RL from scratch as a cost
   reference.

## Extend it

- **Add a world:** implement `WorldAdapter` ([src/world/types.ts](src/world/types.ts)): seeded
  episodes, metrics, a version hash, a tier. REBUILT's
  [adapter](src/world/worlds/rebuilt/adapter.ts) is the example.
- **Use your own model:** set `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_MODEL`, then use
  provider `openai_compatible`. That works for vLLM or SGLang on a rented GPU, Ollama, OpenRouter
  and similar.
- **Add quirks:** build `QuirkNode`s with start conditions and end states and add them to a
  `QuirkArchive`. Links and chains follow from the conditions.
- **Open problems worth taking on:** the end-to-end loop; parametric actions; a fair ranking
  comparison for the large model; cross-domain borrowing; triage that traces a quirk to world code;
  RL from archived states.

## Run it

Needs Node 22+ and pnpm. Intern (the strategy proposer) needs Linux or macOS; on Windows, run it
inside WSL.

```sh
pnpm i
cp .env.example .env    # add the keys you have; everything below except research/ingest/lab runs without keys
pnpm dev                # server on :8787, web on :5173
pnpm test
pnpm typecheck
pnpm keys               # one tiny real call per configured key; prints status, never values
pnpm match              # one seeded REBUILT match with scripted policies
pnpm archive            # seed the quirk archive from the hackathon results -> results/archive.json
pnpm explore            # rollouts-to-best by search order, from the saved scenario picks
pnpm research           # Keenable web research (key needed)
pnpm ingest             # NDI document ingest (key needed)
pnpm quirks             # judge lab proposals against the rules (Drex key needed)
pnpm lab                # Intern proposes strategies, the simulator tests them
```

Helper scripts use the prefixes `history:`, `world:`, `steer:`, `proposals:` and `server:`. The
hackathon benchmark is under `nace:`; see [experiments/nace-2026](experiments/nace-2026).

## Layout

| Path | What it is |
|---|---|
| `src/contracts/` | Every shared shape (zod schemas and types); the single source of truth |
| `src/world/` | World adapter interface; `worlds/rebuilt/` holds the REBUILT engine, match runner and field |
| `src/goal/`, `src/rules/` | Goal approval gate; rules modes |
| `src/history/` | Keenable research and NDI document ingest |
| `src/search/` | `steer/`: decision requests and controllers; `proposals/`: the Intern strategy lab and legality checks |
| `src/archive/` | Quirk graph, surprise test, seeding |
| `src/providers/` | Decision providers (Drex, DeepInfra, OpenAI-compatible, baselines), search and document roles |
| `src/rl/` | RL interface (not implemented) |
| `src/ledger/`, `src/server/`, `src/util/`, `web/` | Usage ledger, HTTP/WebSocket server, utilities, React viewer |
| `experiments/nace-2026/` | The hackathon benchmark code and its original README |
| `results/` | Result files (committed); `notes/` holds decisions and incident notes |

## Origin

Built in one day by two people for the Nace AI Hackathon (San Francisco, Nov 14 2026, Apex track),
where it was pitched as an FRC strategy lab. It didn't win. The pitch hid the real idea, and the
strongest results weren't the headline. This README is the idea as it should have been stated.
The submitted state is tag `nace-2026-submission`.

## Related work

The pieces are not new; the combination is what's being tested. Narrowly, we claim: splitting the
work across model tiers by cost, a quirk graph with explicit start and end conditions so quirks
chain, triage of real quirks against world bugs, and cross-domain borrowing as a source of
candidates.

**Exploration with archives**
- Ecoffet, Huizinga, Lehman, Stanley, Clune. "First return, then explore." *Nature* 590:580-586,
  2021. [doi:10.1038/s41586-020-03157-9](https://www.nature.com/articles/s41586-020-03157-9)
- Lu, Hu, Clune. "Intelligent Go-Explore: Standing on the Shoulders of Giant Foundation Models."
  ICLR 2025. [arXiv:2405.15143](https://arxiv.org/abs/2405.15143). One large model at every step;
  Cambrian splits that work across cheaper tiers.
- Lehman, Stanley. "Abandoning Objectives: Evolution Through the Search for Novelty Alone."
  *Evolutionary Computation* 19(2):189-223, 2011.
- Mouret, Clune. "Illuminating search spaces by mapping elites." 2015.
  [arXiv:1504.04909](https://arxiv.org/abs/1504.04909)

**Models of interestingness, and generated worlds**
- Zhang, Lehman, Stanley, Clune. "OMNI: Open-endedness via Models of human Notions of
  Interestingness." ICLR 2024. [arXiv:2306.01711](https://arxiv.org/abs/2306.01711)
- Faldor, Zhang, Cully, Clune. "OMNI-EPIC: Open-endedness via Models of human Notions of
  Interestingness with Environments Programmed in Code." ICLR 2025.
  [arXiv:2405.15568](https://arxiv.org/abs/2405.15568)
- Ma et al. "Eureka: Human-Level Reward Design via Coding Large Language Models." ICLR 2024.
  [arXiv:2310.12931](https://arxiv.org/abs/2310.12931)
- Wang et al. "Voyager: An Open-Ended Embodied Agent with Large Language Models." TMLR 2024.
  [arXiv:2305.16291](https://arxiv.org/abs/2305.16291)

**Chaining skills**
- Sutton, Precup, Singh. "Between MDPs and semi-MDPs: A framework for temporal abstraction in
  reinforcement learning." *Artificial Intelligence* 112:181-211, 1999.
- Konidaris, Barto. "Skill Discovery in Continuous Reinforcement Learning Domains using Skill
  Chaining." NeurIPS 2009.
  [proceedings](https://proceedings.neurips.cc/paper/2009/hash/e0cf1f47118daebc5b16269099ad7347-Abstract.html) <!-- secret-scan:allow (paper URL hash) -->

**Surprise**
- Itti, Baldi. "Bayesian surprise attracts human attention." NIPS 2005; *Vision Research*
  49(10):1295-1306, 2009. [doi:10.1016/j.visres.2008.09.007](https://doi.org/10.1016/j.visres.2008.09.007)

**Quirks, exploits and sim bugs**
- Lehman et al. "The Surprising Creativity of Digital Evolution." *Artificial Life* 26(2):274-306,
  2020. [doi:10.1162/artl_a_00319](https://doi.org/10.1162/artl_a_00319)
- Krakovna et al. "Specification gaming: the flip side of AI ingenuity." DeepMind blog, April 2020.
  [link](https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4)
- Chrabaszcz, Loshchilov, Hutter. "Back to Basics: Benchmarking Canonical Evolution Strategies for
  Playing Atari." IJCAI 2018. [arXiv:1802.08842](https://arxiv.org/abs/1802.08842). Includes two
  Q*bert bugs, one of them previously unknown.
- Baker et al. "Emergent Tool Use From Multi-Agent Autocurricula." ICLR 2020.
  [arXiv:1909.07528](https://arxiv.org/abs/1909.07528)

**Cross-domain analogy**
- Hope, Chan, Kittur, Shahaf. "Accelerating Innovation Through Analogy Mining." KDD 2017.
  [doi:10.1145/3097983.3098038](https://doi.org/10.1145/3097983.3098038)
- Kittur et al. "Scaling up analogical innovation with crowds and AI." *PNAS* 116(6):1870-1877,
  2019. [doi:10.1073/pnas.1807185116](https://doi.org/10.1073/pnas.1807185116)

**Language models helping RL**
- Du et al. "Guiding Pretraining in Reinforcement Learning with Large Language Models." ICML 2023.
  [arXiv:2302.06692](https://arxiv.org/abs/2302.06692)
- Klissarov, D'Oro et al. "Motif: Intrinsic Motivation from Artificial Intelligence Feedback."
  ICLR 2024. [arXiv:2310.00166](https://arxiv.org/abs/2310.00166)
- Alshiekh et al. "Safe Reinforcement Learning via Shielding." AAAI 2018.
  [doi:10.1609/aaai.v32i1.11797](https://doi.org/10.1609/aaai.v32i1.11797)
- Salimans, Chen. "Learning Montezuma's Revenge from a Single Demonstration." 2018.
  [arXiv:1812.03381](https://arxiv.org/abs/1812.03381)

**A model proposes, an evaluator checks**
- Romera-Paredes et al. "Mathematical discoveries from program search with large language models."
  *Nature* 625:468-475, 2024. [doi:10.1038/s41586-023-06924-6](https://doi.org/10.1038/s41586-023-06924-6)
- Novikov et al. "AlphaEvolve: A coding agent for scientific and algorithmic discovery." 2025.
  [arXiv:2506.13131](https://arxiv.org/abs/2506.13131)

These assume the evaluator is given; Cambrian aims to build it from documents.

**Math for v2**
- Bubeck, Liu. "Prior-free and prior-dependent regret bounds for Thompson Sampling." NeurIPS 2013.
  [arXiv:1304.5758](https://arxiv.org/abs/1304.5758)
- Audibert, Bubeck, Munos. "Best Arm Identification in Multi-Armed Bandits." COLT 2010.

## Team

Christopher Luk, Sri Vatsa Vuddanti

## Credits and license

MIT ([LICENSE](LICENSE)). The REBUILT simulator in `vendor/rebuilt-robotsim` is by FRC Team 488,
used with their permission ([NOTICE](NOTICE)). Not affiliated with or endorsed by FIRST or Nace AI.
