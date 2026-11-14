import type { Flags } from "../App";
import type { Health, RunListing } from "../lib";
export function RulesPage({ onFlags }: { onFlags: (f: Flags) => void }) {
  void onFlags;
  return <div className="empty">Rules: not built yet</div>;
}
