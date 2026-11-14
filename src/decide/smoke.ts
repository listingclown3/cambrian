/**
 * pnpm smoke:drex [-- --provider drex|drex_mock] (owner: P2)
 *
 * End-to-end smoke test of the decision path: stub match -> one robot's view -> masked options
 * -> DecisionRequest -> provider -> validated DecisionResponse -> Intent.
 * Defaults to drex_mock so it runs with no API key. Exits non-zero on any contract violation.
 */
import "dotenv/config";
import { DecisionRequestSchema, DecisionResponseSchema, IntentSchema, ProviderIdSchema } from "../contracts";
import { buildObservationView, engine } from "../engine";
import { basicCyclePolicy, demoRobots, MatchRunner } from "../exec";
import { loadConfig } from "../util/config";
import { buildActionRequest, chosenOption } from "./ask";
import { IMPLEMENTED_PROVIDERS, getProvider } from "./registry";

const arg = process.argv.indexOf("--provider");
const providerId = ProviderIdSchema.parse(arg >= 0 ? process.argv[arg + 1] : "drex_mock");

const cfg = loadConfig();
const seed = cfg.seeds.dev[0] ?? 1;
const runner = new MatchRunner(engine, cfg, seed, demoRobots(cfg), { default: basicCyclePolicy });
while (runner.state.timeS < 35) runner.tick(); // into the first hub shift, so the state is interesting

const robotId = "B1";
const view = buildObservationView(runner.state, robotId);
const request = DecisionRequestSchema.parse(buildActionRequest(view, seed, "live"));
const provider = getProvider(providerId, cfg);
const response = DecisionResponseSchema.parse(await provider.decide(request));
const option = chosenOption(view.options, response);

console.log(`provider: ${response.meta.provider} (${response.meta.model})${response.meta.isMock ? "  [MOCK]" : ""}`);
console.log(`state text:\n${request.stateText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
console.log(`options offered: ${view.options.length}`);
console.log(`chosen: ${option?.label ?? "(none)"}${option ? ` - ${option.description}` : ""}`);
console.log(`meta: ${JSON.stringify(response.meta)}`);

if (!IMPLEMENTED_PROVIDERS.has(providerId)) {
  console.error(`\nFAIL: provider "${providerId}" is not implemented yet; the answer above is a fallback.`);
  process.exit(1);
}
if (!option) {
  console.error("\nFAIL: the provider did not choose one of the offered options.");
  process.exit(1);
}
IntentSchema.parse(option.intent);
const probabilities = response.answers.next_action?.probabilities;
if (probabilities) {
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) {
    console.error(`\nFAIL: probabilities sum to ${total}, not 1.`);
    process.exit(1);
  }
}
console.log(`\nOK: smoke test passed${response.meta.isMock ? " (mock provider: plumbing only, not a result)" : ""}.`);
