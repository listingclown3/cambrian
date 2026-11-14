/**
 * Turning a robot's view into a DecisionRequest and a DecisionResponse back into an Intent
 * (owner: P2).
 */
import type { DecisionRequest, DecisionResponse, Intent, IntentOption, ObservationView } from "../contracts";
import { renderStateText } from "./stateText";

/** Id of the question that asks a robot what to do next. */
export const ACTION_QUESTION_ID = "next_action";

/** Build the standard "what should this robot do next?" request from a view. */
export function buildActionRequest(view: ObservationView, seed: number, mode: DecisionRequest["mode"]): DecisionRequest {
  return {
    stateText: renderStateText(view),
    questions: [
      {
        id: ACTION_QUESTION_ID,
        kind: "choice",
        instructions: `Choose the single best next action for robot ${view.self.id} to maximise its alliance's final score margin.`,
        options: view.options.map(({ label, description }) => ({ label, description })),
      },
    ],
    seed,
    mode,
  };
}

/** The option the provider chose, or undefined if it chose nothing or an unknown label. */
export function chosenOption(options: readonly IntentOption[], res: DecisionResponse, questionId: string = ACTION_QUESTION_ID): IntentOption | undefined {
  const label = res.answers[questionId]?.chosen;
  return label === undefined ? undefined : options.find((o) => o.label === label);
}

/** The intent the provider chose, or undefined (leave the robot's current intent running). */
export function chosenIntent(options: readonly IntentOption[], res: DecisionResponse, questionId?: string): Intent | undefined {
  return chosenOption(options, res, questionId)?.intent;
}
