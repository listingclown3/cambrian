/**
 * Builds the ObservationView for one robot (owner: P1).
 * This is the ONLY place state is turned into what a controller may see. It must never leak
 * another robot's profile, intent parameters, `then` step or controller id.
 */
import {
  getRobot,
  maskOptions,
  otherAlliance,
  type EngineEvent,
  type MatchState,
  type ObservationView,
  type ObservedRobot,
  type RobotState,
} from "../../../../contracts";

function observe(robot: RobotState, observerAlliance: string): ObservedRobot {
  const p = robot.profile;
  const step = robot.intent === null ? null : robot.intentStage === "then" && robot.intent.then ? robot.intent.then : robot.intent;
  return {
    id: robot.id,
    alliance: robot.alliance,
    isPartner: robot.alliance === observerAlliance,
    pose: { ...robot.pose },
    velocity: { ...robot.velocity },
    fuelLevel: robot.fuelHeld === 0 ? "empty" : robot.fuelHeld >= p.capacity ? "full" : "partial",
    apparentAction: step?.action ?? null,
    climbLevel: robot.climb.level,
    inContactWith: robot.contact.withRobotId,
    traits: {
      teamLabel: p.teamLabel,
      heightClass: p.heightClass,
      drivetrain: p.drivetrain,
      shooterType: p.shooterType,
      aimMethod: p.aimMethod,
      lanes: p.lanes,
      intakeWidth: p.intakeWidth,
      fitsUnderTrench: p.fitsUnderTrench,
      shootsOnMove: p.shootOnMove,
    },
  };
}

/** True when an event concerns this robot or everyone. */
export function eventConcerns(event: EngineEvent, robotId: string): boolean {
  return !("robotId" in event) || event.robotId === null || event.robotId === robotId;
}

/**
 * What `robotId` can see right now. `recentEvents` should be the events since the robot's
 * previous decision; they are filtered to those that concern it.
 */
export function buildObservationView(state: MatchState, robotId: string, recentEvents: readonly EngineEvent[] = []): ObservationView {
  const self = getRobot(state, robotId);
  const others = state.robots.filter((r) => r.id !== robotId);
  const theirs = otherAlliance(self.alliance);
  return {
    timeS: state.timeS,
    phase: state.phase,
    shiftIndex: state.shiftIndex,
    matchRemainingS: Math.max(0, state.rules.matchS - state.timeS),
    hubs: { ours: { ...state.hubs[self.alliance] }, theirs: { ...state.hubs[theirs] } },
    self: {
      id: self.id,
      alliance: self.alliance,
      profile: self.profile,
      pose: { ...self.pose },
      velocity: { ...self.velocity },
      fuelHeld: self.fuelHeld,
      intent: self.intent,
      aligned: self.alignment.aligned,
      spinUpReady: self.spinUp.ready,
      contact: { ...self.contact },
      climb: { ...self.climb },
    },
    robots: [
      ...others.filter((r) => r.alliance === self.alliance).map((r) => observe(r, self.alliance)),
      ...others.filter((r) => r.alliance !== self.alliance).map((r) => observe(r, self.alliance)),
    ],
    fuel: { byZone: { ...state.fuel.byZone }, piles: state.fuel.piles.map((p) => ({ ...p, pos: { ...p.pos } })) },
    score: { ours: state.score[self.alliance].total, theirs: state.score[theirs].total },
    recentEvents: recentEvents.filter((e) => eventConcerns(e, robotId)),
    options: maskOptions(self, state),
    field: state.field,
  };
}
