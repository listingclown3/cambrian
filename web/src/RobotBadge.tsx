/** Provenance badge (owner: P4): "REAL · N sourced fields" with a hover list of sources, or "FABRICATED". */
import { useApi } from "./lib";

export interface TeamRecord {
  profile: { id?: string; teamLabel?: string; archetype?: string };
  provenance?: Record<string, { source?: string; quote?: string }>;
  classifiedArchetype?: string;
}
export interface TeamsPayload {
  available: boolean;
  teams?: TeamRecord[];
}

/** Loads data/league/teams_from_docs.json through the server (empty until the file exists). */
export function useTeams(): TeamsPayload | null {
  return useApi<TeamsPayload>("/api/league/teams").data;
}

export function findTeam(teams: TeamsPayload | null, robot: { id: string; teamLabel: string }): TeamRecord | null {
  return teams?.teams?.find((t) => t.profile.teamLabel === robot.teamLabel || t.profile.id === robot.id) ?? null;
}

export function RobotBadge({ team }: { team: TeamRecord | null }) {
  const fields = team?.provenance ? Object.entries(team.provenance) : [];
  if (!team || fields.length === 0) return <span className="prov fab">FABRICATED</span>;
  return (
    <span className="prov real" tabIndex={0}>
      REAL · {fields.length} sourced fields
      <span className="tip">
        {fields.map(([field, p]) => (
          <span key={field} className="tipline"><b>{field}</b> {p.source ?? "no source recorded"}</span>
        ))}
      </span>
    </span>
  );
}
