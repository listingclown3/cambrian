import type { Flags } from "../App";
import type { Health, RunListing } from "../lib";
export function ScenarioPage({ health, onFlags }: { health: Health | null; onFlags: (f: Flags) => void }) {
  void onFlags;
  return <div className="empty">Scenario: not built yet</div>;
}
