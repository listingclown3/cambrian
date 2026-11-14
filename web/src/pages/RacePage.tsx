import type { Flags } from "../App";
import type { Health, RunListing } from "../lib";
export function RacePage({ health, onFlags }: { health: Health | null; onFlags: (f: Flags) => void }) {
  void onFlags;
  return <div className="empty">Race: not built yet</div>;
}
