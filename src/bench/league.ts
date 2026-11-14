/**
 * pnpm league (owner: P3)
 * Build data/league/league.json: config.league.teams FABRICATED teams sampled from the archetype
 * templates (seeded Rng, profileFromTemplate, archetype drawn by config.league.archetypeWeights)
 * plus the REAL teams from data/league/teams_from_docs.json (profile + provenance per sourced
 * field; every unsourced field of a real team is the archetype template value).
 */
import { ARCHETYPES, profileFromTemplate, type Archetype } from "../contracts";
import { loadConfig } from "../util/config";
import { Rng } from "../util/rng";
import { LeagueFileSchema, readJson, writeJson, type LeagueTeam } from "./common";

const cfg = loadConfig();
const rng = Rng.fromSeed(cfg.league.seed);
const weights = cfg.league.archetypeWeights as Record<string, number>;
const archetypes = ARCHETYPES.filter((a) => (weights[a] ?? 0) > 0);
const totalW = archetypes.reduce((s, a) => s + weights[a]!, 0);

function drawArchetype(): Archetype {
  let u = rng.next() * totalW;
  for (const a of archetypes) {
    u -= weights[a]!;
    if (u < 0) return a;
  }
  return archetypes[archetypes.length - 1]!;
}

const teams: LeagueTeam[] = [];
for (let i = 1; i <= cfg.league.teams; i++) {
  const archetype = drawArchetype();
  const id = `fab_${String(i).padStart(2, "0")}`;
  const profile = profileFromTemplate(archetype, cfg.archetypes.templates[archetype], { id, teamLabel: `Fabricated ${i} (${archetype})` }, cfg.game.fuelMassKg.value, () => rng.next());
  teams.push({ profile, origin: "fabricated", sourcedFieldCount: 0, provenance: {} });
}

const real = readJson<{ teams: { profile: unknown; provenance: Record<string, unknown>; classifiedArchetype?: unknown }[] }>("data", "league", "teams_from_docs.json");
for (const t of real?.teams ?? []) {
  teams.push({ profile: t.profile as LeagueTeam["profile"], origin: "real", sourcedFieldCount: Object.keys(t.provenance ?? {}).length, provenance: t.provenance ?? {}, classifiedArchetype: t.classifiedArchetype ?? null });
}

const league = LeagueFileSchema.parse({
  generatedTs: new Date().toISOString(),
  note:
    "origin fabricated = sampled from FABRICATED archetype templates (config.archetypes); origin real = a real team whose sourcedFieldCount fields were read from a public page (see provenance), every other field is the archetype template value (an assumption).",
  seed: cfg.league.seed,
  teams,
});
const file = writeJson(league, "data", "league", "league.json");
const counts = Object.fromEntries(archetypes.map((a) => [a, teams.filter((t) => t.profile.archetype === a).length]));
console.log(`[league] ${teams.length} teams (${cfg.league.teams} fabricated, ${real?.teams.length ?? 0} real) -> ${file}`);
console.log(`[league] by archetype: ${JSON.stringify(counts)}`);
