import type { Flags } from "../App";
import type { Health, RunListing } from "../lib";
export function ComparePage({ runs, onFlags }: { runs: RunListing[]; onFlags: (f: Flags) => void }) {
  void onFlags;
  return <div className="empty">Compare: not built yet</div>;
}
