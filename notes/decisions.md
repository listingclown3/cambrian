# Decisions

Settled 2026-11-14, after the Nace AI Hackathon. This file is the reference for the restructure,
the README and future work. Change it when a decision changes; don't let the code drift from it.

## What Cambrian is

Guided quirk discovery. A user states a goal in plain words and picks a world. The system grounds
itself in history (same domain and other domains), explores cheaply, archives every quirk it finds
(good or bad) as a graph, and chains quirks into strategies or designs that beat the current best.
One capable model builds the world once; cheap models do the search; RL is used only where precise
execution matters, starting from archived quirk states.

The repo is three things at once: a portfolio piece, a research write-up, and a base for the next
hackathon. Above all it is an **open idea with early tries**, written so other people can pick it up
and extend it. It does not claim the general idea is validated.

## A. What counts as a quirk

A quirk is a result whose measured effect differs from what the prior predicted, by more than the
noise (outside the 95% CI of the measurement). The prior is what the world builder or the steering
model predicted from the rules and history before the run. A quirk may lose on its own and still
counts. Basis: Bayesian surprise (Itti & Baldi).

Quirks exist at two levels:

- **Play**: how to act in the world (a route, a timing, a rule edge).
- **Design**: what to build (a mechanism, a robot archetype). Design quirks change which play quirks
  are reachable.

## B. Discovery must not be picking from a menu

1. Two action layers. Discovery runs on parametric primitives (drive to any x, y; turn; shoot at
   any time). Hand-written options are shortcuts only. New shortcuts come from the archive: each
   archived quirk becomes an option with start conditions and an end condition (options framework).
2. Exploration varies parameters of archived states ("move this spot 2 m", "shoot 1 s earlier");
   the steering model chooses what to vary and where to return.
3. Leak test: for every target quirk, show no single hand-written option produces it. If one does,
   the run is not a rediscovery. (Extends the existing `leakTest`.)
4. The archive is keyed by coarse cells (Go-Explore style), e.g. field position x fuel held x time
   bucket for REBUILT, so it stays finite.

Known leak today: the five hand-placed REBUILT shot spots are all on the alliance side of the hub
(no G407 leak), but `shoot_on_move:path=left_trench` crosses into the neutral zone and partly leaks
the G407 gap.

## Borrow: cross-domain history

History is not limited to past versions of the same domain. The system also pulls mechanisms and
tactics from other fields that solved an analogous problem, then quirks around with them.
Example: REBUILT asks "what is the best way to index balls?"; paintball loaders (rotor-style
force-feed hoppers) already solved feeding round objects fast without jams. Borrowed ideas enter the
archive as design or play candidates with their source cited, and are tested like any other quirk.
Basis: analogy mining (Hope et al. 2017; Kittur et al. 2019).

## C. Two tiers of worlds

- **Tier 1, the sim is the game.** Quirks are real by definition; answers come from history (patch
  notes, speedrun histories, known metas). This is where discovery gets proven. Polytrack is the
  motivating story only; no Polytrack world is built now (possible v2, and only as an original world,
  not a recreation). Candidate test worlds for v2: an original track-racing toy world with planted
  quirks, or Atari Q*bert (Chrabaszcz et al. 2018 found two bugs, one previously unknown).
- **Tier 2, the sim models reality.** A quirk matters only if it transfers. FRC REBUILT is the
  end-to-end validation and the demonstration world, not the product. Its G407 gap is the case for
  Triage: the system should flag it as "likely world bug: contradicts G407" instead of exploiting it.

## D. Baselines (TODO, both)

At equal budget in cost units (below):

- No-LLM search: random search, novelty search, Go-Explore with hand-written cell selection.
- LLM at every step: an Intelligent Go-Explore style loop with one large model.
- RL from scratch, as a cost reference.

## E. What is new

Claimed as new, narrowly: (1) the split of work across model tiers by cost; (2) the quirk graph with
explicit start and end conditions so quirks chain; (3) triage of real quirk vs world bug;
(4) cross-domain borrowing as a source of candidates. Everything else is prior work, cited.

## F. How the steering model helps RL

| Mode | What it does | Test | Status |
|---|---|---|---|
| F1 Steer | Picks the state to return to and the parameter to vary | Sim cost until first quirk | Lead claim (has data) |
| F2 Confine | Masks actions for RL | Wasted episodes at equal quirk yield | Option |
| F3 Shape | Bonus reward near likely quirks | RL cost until a quirk | Option |
| F4 Find, then RL refines | RL starts from archived quirk states | Cost to reach the quirk's value vs RL from scratch | Next claim |

F2 rule: confinement may only remove **pointless** actions (no state change, repeat loops; the
existing commitment and anti-loop rules). It never removes actions for being illegal unless the rules
mode is `enforce`, because illegal-looking actions are where quirks live.

## Providers: no single-vendor dependency

Every external service sits behind a role interface with at least one non-Nace implementation:

| Role | Interface | Today | Swappable to |
|---|---|---|---|
| Steer | `DecisionProvider` | Drex | any OpenAI-compatible endpoint (DeepInfra, OpenRouter, vLLM on a rented GPU, Ollama) |
| Judge | `DecisionProvider` / chat | DeepInfra | same |
| Search | `SearchProvider` | Keenable | any web search API |
| Document parse | `DocProvider` | NDI | any PDF/text extractor |
| Agent | lab proposer | Intern | any chat model with tools |

A generic `openai_compatible` provider takes a base URL, key env var and model, so self-hosted GPU
inference plugs in without code changes.

## Cost unit

One unit, **cost in USD**, always reported with its raw parts:

```
cost_usd = model_api_usd            (from the ledger, actual billed prices)
         + sim_cpu_hours  * cpu_rate (config: costs.cpuUsdPerVcpuHour)
         + gpu_hours      * gpu_rate (config: costs.gpuUsdPerHour, from the actual invoice)
```

Raw parts reported next to it: simulator steps, model calls, tokens, CPU-hours, GPU-hours. Rates
live in config with their source; use invoice prices when available.

## "Found / close / missed" (set before each run)

Each target quirk is written down before the run with: its mechanism (the rule or world-code path
it uses), its start conditions, and its reference effect (measured with CI by reproducing it by
hand). The search budget in cost units is also fixed before the run.

- **Found**: an archived quirk with the same mechanism (triage traces it to the same rule or code
  path) and an effect of at least 75% of the reference, CI lower bound above 0, within budget.
- **Close**: same mechanism but 25-75% of the reference effect; or at least 75% but only within 2x
  the budget.
- **Missed**: anything else.

Run the search itself on at least 5 seeds and report the fraction found / close / missed, never a
single run.

## Rules mode defaults

- Tier 1 worlds: `off` (physics is the only law).
- Tier 2 worlds: `flag` (rule breaks are labelled, kept, and go to triage; sim bugs shouldn't
  silently dominate).
- `enforce` is always available and is the only mode in which F2 may mask illegal actions.

## Math

Formal validation is v2: (1) chain-depth cost, random search ~ p^-d vs archive-and-return ~ d/p,
measured on a combination-lock world; (2) rollouts-to-best as Bayesian best-arm identification with
a prior. Until then the README calls the general claim a hypothesis.

## Permissions

FRC Team 488 approved continued public development using their REBUILT simulator (approval relayed
by Christopher Luk, 2026-11-14).

## Corrections to the hackathon numbers (carry into the README)

1. Rollout savings: 27.5% [95% CI 13.5, 40.7] is across all 39 scenarios including ambiguous ones;
   on the 20 unambiguous ones it is 12.1% [-4.6, 28.7], which could be zero.
2. Big-model priors: the big model gave only a top-1 pick (rest random); Drex gave a full ranking.
   Not a fair comparison until the big model is asked for a ranking.
3. Tower post-up: the opponent (`basic_cycle`) never defends, so 0 fouls was guaranteed; margins were
   identical in all 10 seeds. Not evidence until rerun against `archetype_v1`.
4. Lab: 2 of 2 tested proposals beat the baseline; 3 of 5 never triggered.
5. Trench strategy: +141.3 +/- 48.6 on the engine without G407; +103.7 +/- 21.3 on branch `g407`.
   Part of its value comes from the G407 gap: the system exploited a world bug without noticing,
   which is the case for the Notice and Triage steps.
