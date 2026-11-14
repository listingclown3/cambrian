import type { Flags } from "../App";
export function HeadlinePage({ onFlags }: { onFlags: (f: Flags) => void }) {
  void onFlags;
  return <div className="empty">Headline: not built yet</div>;
}
