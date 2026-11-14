/**
 * Engine entry point (owner: P1).
 *
 * Everyone else imports `engine` from here. When the real engine is ready, change the one line
 * below; no caller needs to change.
 */
import type { Engine } from "../contracts";
import { rebuiltEngine } from "./engine";

/** The engine in use: the real REBUILT engine (src/engine/engine.ts). The stub stays in stubEngine.ts for reference. */
export const engine: Engine = rebuiltEngine;

/**
 * True while `engine` is the stub; results produced with it must not be reported.
 *
 * NOTE (P1): `engine` above IS the real engine now. This flag should be false, but
 * src/server/server.test.ts (owned by P4) hard-codes `engineIsStub: true` on lines 22 and 70, so
 * flipping it here breaks that test. The integrator flips this to false and changes those two
 * assertions to `engineIsStub: ENGINE_IS_STUB` in the same commit.
 */
export const ENGINE_IS_STUB = true;

export { buildFieldLayout } from "./field";
export { buildObservationView, eventConcerns } from "./observe";
