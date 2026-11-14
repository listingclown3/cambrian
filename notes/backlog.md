# Backlog: settle before we submit

Things that are known to be open. Check each off, or cut the claim that depends on it.

## Confirm before quoting numbers

- [ ] **Drex v2.0 price.** Config has `drex-v2.0` at $0.06 per 1M input tokens. That is the price
      DeepInfra lists for the same model; the Nace pricing page did not show it. Confirm on the
      Nace console billing page, then update `pricesPerMTokUsd.byModel["drex-v2.0"]` in
      `config/default.json`. Until then, do not quote a Drex cost or a cost ratio.
- [ ] **Keenable price.** No price is configured, so Keenable cost shows as $0. Fill it in or say
      "free tier" explicitly.
- [ ] **Which Drex model the headline uses.** In-match calls use `drex-v2.0` (about 48 ms
      evaluation); the organizers' id `drex-latest` is `drex-max-v1.1` (about 150 to 190 ms).
      The planner should confirm this choice, and the write-up should name the model.

## Game constants still unverified (config says TODO_VERIFY_AGAINST_MANUAL)

- [ ] `game.fuelMassKg` (0.23): NDI did not find it in the manual.
- [ ] `game.fuelStart.neutral` (360): derived from the manual's 504 total, not stated directly.
- [ ] `field.allianceZoneDepthM` (4.03): NDI gave 158.6 in with no page citation.
- [ ] `field.blueElements`, `field.blueLaneY`, `field.laneLengthM`: placeholder geometry.
- [ ] Seven constants came back from NDI without a page citation (transition shift, fuel points
      in an active hub, tower level 1 points, foul points). Running NDI Ground on them would
      raise `ndi_rules_verified_pct` above 68%.

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
