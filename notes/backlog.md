# Backlog: settle before we submit

## FIRST AFTER SUBMISSION: enforce G407 in the engine

Found 2:44 PM by the owner watching the replay. G407 (manual line "Only score while in your ALLIANCE ZONE"): a robot may launch into its hub only while its bumpers are partly or fully inside its alliance zone. `fire` and `inShotRange` in src/engine/engine.ts check hub distance only (max shot distance up to 5.5 m, hub at x 4.626 m, zone depth 4.028 m), so shots from the neutral side score. Fix: require the bumper footprint to overlap the alliance zone in both functions and in the shot-spot generator, then rerun the answer key, bench:scenarios, bench:live, the check-mode run, lab:sim and quirks, since the simulator hash changes. Not fixed before the deadline because it would have invalidated every published number.


Things that are known to be open. Check each off, or cut the claim that depends on it.

## Cut order if behind (planner, 12:05 PM). First cut first.

1. OpenAI baseline
2. Exploration race PAGE (keep bench:explore data if it already ran)
3. Game pack and `pnpm newgame` (planner item 13)
4. My Robot panel (keep the bench)
5. Strategy Lab SIMULATION of proposals (keep the lab run itself)

NEVER cut: bench:scenarios, bench:live, the lab run, the usage ledger, the Rules & Sources
page, the Live Match page.

## Confirm before quoting numbers

- [x] **Drex price.** Confirmed by Chris from the Nace console usage export (2026-11-14): $0.03
      per 1M input tokens, output tokens free, same for drex-v2.0 and drex-latest. Config
      updated. Cost ratios may be quoted from the benchmarks.
- [ ] **Keenable price.** No price is configured, so Keenable cost shows as $0. Fill it in or say
      "free tier" explicitly.
- [ ] **Which Drex model the headline uses.** In-match calls use `drex-v2.0` (about 48 ms
      evaluation); the organizers' id `drex-latest` is `drex-max-v1.1` (about 150 to 190 ms).
      The planner should confirm this choice, and the write-up should name the model.

## Game constants still unverified (config says TODO_VERIFY_AGAINST_MANUAL)

- [x] `game.fuelMassKg` (0.23): not in the manual; now marked EXTERNAL_SOURCE (Wikipedia, about 0.5 lb).
- [ ] `game.fuelStart.neutral` (360): derived from the manual's 504 total, not stated directly.
- [ ] `field.allianceZoneDepthM` (4.03): NDI gave 158.6 in with no page citation.
- [ ] `field.blueElements`, `field.blueLaneY`, `field.laneLengthM`: placeholder geometry.
- [ ] Seven constants came back from NDI without a page citation (transition shift, fuel points
      in an active hub, tower level 1 points, foul points). Running NDI Ground on them would
      raise `ndi_rules_verified_pct` above 68%.

## Data quality to review

- [ ] **Incident labels.** Chris reviews them himself using notes/incident-review.md (start with
      inc_14, inc_16, inc_35). When done, apply his calls to data/rules/incidents.template.json,
      set `labels_human_verified` to true, re-run `pnpm ingest:judge` for both models, and update
      the 57/60 and 59/60 figures in description.txt. If not done by 2:20 the wording stays
      "agreement with AI-drafted labels (not yet human-verified)".
- [ ] **Archetype skew.** Planner ruled it a classifier problem. Being re-run with a shooter-type
      question plus a shoot-on-move question, a required quote, and "unknown" under 0.5.
- [ ] **Strategy notes.** Some of the 71 notes come from 2020 and 2022 game pages, and a few
      describe robot features rather than match strategy. Skim before feeding them to the lab.
- [ ] **Real-team profiles are mostly assumptions.** Each has 3 to 10 fields read from a page;
      every other field is the archetype template value. Say so wherever they are shown.

## Description (description.txt)

- [ ] Run `pnpm headline && pnpm describe`; every `{{placeholder}}` it lists as not measured
      must be filled by a real run or its sentence cut.
- [ ] Cut or reword sentences for anything not built by submission: the 24 scouting sheets,
      rule judging, archetype classification of real robots, the Data Health page, Strategy Lab
      proposals, "used Intern as a coding agent for part of the build".

## Repo

- [ ] Nothing is pushed yet. The history holds a 10:53 scaffold commit; decide how to handle it
      with the organizers, then `pnpm prepush && git push -u origin main`.
- [ ] `NOTICE`: record who at Team 488 granted permission, when, and through which channel.
- [ ] OpenAI and Gemini model ids are still `TODO_SET_...` (optional baselines; fine to leave).
