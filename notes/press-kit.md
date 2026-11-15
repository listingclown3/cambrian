# Press kit

Copy for GitHub, a portfolio, LinkedIn and a resume. Every number here is in the README with its
caveats; keep the caveats when you shorten something.

## GitHub

- **Repo name:** `cambrian` (rename `listingclown3/drex-hackathon`; GitHub redirects the old URL)
- **Description (about box):** Guided quirk discovery: cheap models steer the search for unintended
  behaviours in a simulated world, archive them as a graph, and chain them into strategies. An open
  idea with early experiments. First world: FRC REBUILT 2026.
- **Topics:** `open-endedness` `go-explore` `quality-diversity` `llm-agents` `reinforcement-learning`
  `simulation` `game-ai` `frc` `typescript`

## One line

Cambrian: guided search for the game-breaking quirks nobody planned, with cheap models doing the
steering instead of brute-force RL.

## Short (portfolio card, ~60 words)

Cambrian is an open research idea: find the quirks that break a game or simulation (behaviour the
designers never intended) by guiding the search with history, analogies from other fields and
cheap models, instead of brute-force RL. Quirks are archived as a graph and chained into
strategies. First world: an FRC robotics game simulator. Built at a hackathon, now open for others
to extend.

## Long (project page, ~170 words)

The best strategies in games often come from quirks: unintended behaviour that is useless alone
and dominant in combination. Reinforcement learning finds them by brute force; OpenAI's
hide-and-seek agents needed about 380 million episodes to find box surfing.

Cambrian tests a cheaper route. You state a goal in plain words and approve the metrics it becomes.
The system grounds itself in the domain's history and in analogous solutions from other fields
(paintball loaders for ball indexing in robotics). A small, fast model steers the exploration, and
every quirk found is archived with its start and end conditions. Quirks link into a graph and
chain into strategies; RL comes in only where precise execution matters.

The first world is FRC REBUILT 2026. Early results: guided ordering cut rollouts-to-best by 27.5%
across 39 scenarios (12.1% on the clear-cut ones, not yet significant). The search also exploited
a real simulator bug without noticing it, which is why the design includes a triage step. The
code, the decisions and the open problems are public for anyone who wants to push it further.

## LinkedIn / X post

We didn't win the Nace AI Hackathon, and I'm publishing the project anyway, because the idea
deserves more than the pitch we gave it.

Cambrian is about quirks: the unintended behaviours that end up defining how a game is played.
RL finds them by brute force. Our bet is that a cheap model with history, common sense and
analogies from other fields can steer that search far more efficiently, then chain the quirks it
finds into strategies nobody planned.

In one day we built the first world (an FRC robotics simulator), a steering model that was 7x
faster and about 19x cheaper per decision than a large model, and early signs that guided search
needs fewer rollouts. Our own search also found and used a simulator bug without flagging it,
which taught us the system needs a triage step.

It's an open idea, not a finished result. Code, decisions and open problems:
github.com/listingclown3/cambrian

## Resume bullets

- Co-built Cambrian, a guided quirk-discovery system (TypeScript, about 24k lines), at the Nace AI
  Hackathon: a small model steers search in a robotics game simulator, with a quirk graph, rule
  checks from documents and a swappable model-provider layer.
- Measured a 7.1x latency and about 19x cost reduction per decision against a 397B-parameter model,
  with paired-seed evaluation and 95% confidence intervals on every reported result.

## What we learned (for a hackathon write-up)

- Lead with the idea, not the first application. We pitched an FRC tool and hid the real thesis.
- Lead with the strongest result. Ours were speed, cost and guided-search savings; accuracy was a
  tie.
- Show one moment where the baseline visibly fails. Breadth didn't substitute for it.
- A random proposer with the same simulator check got about half our gain: always run the dumb
  baseline.
