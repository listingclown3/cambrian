import { describe, expect, it } from "vitest";
import { parseProposals } from "./lab";

const good = {
  id: "stage_before_shift",
  title: "Stage before the shift",
  kind: "option_variant",
  rationale: "Fuel staged at the hub during an inactive shift can be scored the moment the hub turns active.",
  sourceUrls: ["https://example.com/strategy"],
  situation: "Our hub is inactive for more than 10 s and the neutral zone has fuel.",
  intent: { action: "collect", params: { source: "neutral" }, then: { action: "stage_fuel", params: { spotId: "hub_close" } } },
};

describe("parseProposals", () => {
  it("accepts a valid proposal", () => {
    const { accepted, rejected } = parseProposals({ proposals: [good] });
    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("rejects proposals that break the Intent contract, lack a source, or repeat an id", () => {
    const badPair = { ...good, id: "bad_pair", intent: { action: "collect", params: { source: "neutral" }, then: { action: "climb", params: { level: 1 } } } };
    const badAction = { ...good, id: "bad_action", intent: { action: "teleport", params: {} } };
    const noSource = { ...good, id: "no_source", sourceUrls: [] };
    const { accepted, rejected } = parseProposals({ proposals: [good, badPair, badAction, noSource, good] });
    expect(accepted.map((p) => p.id)).toEqual(["stage_before_shift"]);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
  });

  it("keeps at most five and rejects a malformed file", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...good, id: `proposal_${i}` }));
    expect(parseProposals({ proposals: many }).accepted).toHaveLength(5);
    expect(parseProposals("rm -rf /").accepted).toEqual([]);
    expect(parseProposals(null).rejected).toHaveLength(1);
  });
});
