/**
 * Turning robots' views into a DecisionRequest and a DecisionResponse back into Intents
 * (owner: P2). Shared by every provider: whatever is built here goes verbatim to Drex and to the
 * LLMs alike.
 */
import { CAPTAIN_ROLE_NAMES, type CaptainRole, type DecisionRequest, type DecisionResponse, type Intent, type IntentOption, type ObservationView, type QuestionOption } from "../contracts";
import { liveOptions, type OptionRules } from "./options";
import { renderSelfText, renderSharedStateText, renderStateText } from "./stateText";

/** Id of the question that asks a robot what to do next. */
export const ACTION_QUESTION_ID = "next_action";

/** Question id for one robot's next action inside a batched request. */
export const actionQuestionId = (robotId: string) => `next_action_${robotId}`;

const actionInstructions = (robotId: string) => `Choose the single best next action for robot ${robotId} to maximise its alliance's final score margin.`;

/** Build the standard "what should this robot do next?" request from a view. */
/**
 * How a request presents a robot's options.
 *   rules given  -> live play: curateOptions (at most maxOptions, default 10) with
 *                   describeWithFacts descriptions (see options.ts, PROMPT_VERSION)
 *   no rules     -> the full masked list with plain descriptions (legacy / analysis)
 */
export interface OptionPresentation {
  rules?: OptionRules;
  maxOptions?: number;
}

function presentOptions(view: ObservationView, p: OptionPresentation): { label: string; description: string }[] {
  return p.rules ? liveOptions(view, p.rules, p.maxOptions ?? 10) : view.options.map(({ label, description }) => ({ label, description }));
}

export function buildActionRequest(view: ObservationView, seed: number, mode: DecisionRequest["mode"], present: OptionPresentation = {}): DecisionRequest {
  return {
    stateText: renderStateText(view),
    questions: [
      {
        id: ACTION_QUESTION_ID,
        kind: "choice",
        instructions: actionInstructions(view.self.id),
        options: presentOptions(view, present),
      },
    ],
    seed,
    mode,
  };
}

/**
 * One request for several robots of ONE alliance at one moment: the shared state text, plus one
 * question per robot whose instructions carry that robot's own state (and its captain role,
 * when one is assigned). Question ids are actionQuestionId(robotId).
 */
export function buildBatchActionRequest(
  views: readonly ObservationView[],
  seed: number,
  mode: DecisionRequest["mode"],
  roles: Readonly<Record<string, CaptainRole | undefined>> = {},
  present: OptionPresentation = {},
): DecisionRequest {
  return {
    stateText: renderSharedStateText(views),
    questions: views.map((v) => {
      const role = roles[v.self.id];
      const extra = role ? [`Captain's role for ${v.self.id} this shift: ${describeRole(role)}`] : [];
      return {
        id: actionQuestionId(v.self.id),
        kind: "choice" as const,
        instructions: `${renderSelfText(v, extra)}\n${actionInstructions(v.self.id)}`,
        options: presentOptions(v, present),
      };
    }),
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

// ── captain roles ────────────────────────────────────────────────────────────

const ROLE_WORDS: Record<(typeof CAPTAIN_ROLE_NAMES)[number], string> = {
  scorer: "primary fuel scorer.",
  feeder: "moves fuel to partners by passing.",
  stager: "stages fuel at shot spots ahead of our next active shift.",
  collector: "gathers loose fuel.",
  defender: "defends one opposing robot.",
  climber: "heads for the tower to climb.",
};

/** Stable label for a role: the role name, or "defender:<target>". */
export function roleLabel(role: CaptainRole): string {
  return role.role === "defender" ? `defender:${role.target}` : role.role;
}

/** One plain-English sentence for a role. */
export function describeRole(role: CaptainRole): string {
  return role.role === "defender" ? `defender: play defense on opposing robot ${role.target}.` : `${role.role}: ${ROLE_WORDS[role.role]}`;
}

/** Every role a captain may assign, given the opposing robot ids (defender expands per target). */
export function captainRoleOptions(opponentIds: readonly string[]): { option: QuestionOption; role: CaptainRole }[] {
  const roles: CaptainRole[] = CAPTAIN_ROLE_NAMES.flatMap((name): CaptainRole[] =>
    name === "defender" ? opponentIds.map((target) => ({ role: "defender", target })) : [{ role: name }],
  );
  return roles.map((role) => ({ role, option: { label: roleLabel(role), description: `${describeRole(role).charAt(0).toUpperCase()}${describeRole(role).slice(1)}` } }));
}

/** Question id for the captain's role choice for one robot. */
export const captainQuestionId = (robotId: string) => `captain_role_${robotId}`;

/**
 * The captain's question for one robot, given the roles already assigned this shift (the
 * captain step is sequential: each assignment sees the ones before it). The state text is the
 * shared alliance text, so the captain sees robots only in their observed form.
 */
export function buildCaptainRequest(
  views: readonly ObservationView[],
  robotId: string,
  assigned: Readonly<Record<string, CaptainRole>>,
  seed: number,
  mode: DecisionRequest["mode"],
): DecisionRequest {
  const first = views[0]!;
  const opponents = first.robots.filter((r) => !r.isPartner).map((r) => r.id).sort();
  const done = Object.entries(assigned);
  return {
    stateText: renderSharedStateText(views),
    questions: [
      {
        id: captainQuestionId(robotId),
        kind: "choice",
        instructions: [
          `You are the alliance captain assigning roles for this hub shift.`,
          done.length > 0 ? `Already assigned: ${done.map(([id, r]) => `${id} ${roleLabel(r)}`).join(", ")}.` : "No roles assigned yet this shift.",
          `Choose the role for robot ${robotId} that maximises our alliance's final score margin.`,
        ]
          .filter(Boolean)
          .join("\n"),
        options: captainRoleOptions(opponents).map((o) => o.option),
      },
    ],
    seed,
    mode,
  };
}
