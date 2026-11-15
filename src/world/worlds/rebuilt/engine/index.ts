/**
 * Engine entry point (owner: P1).
 *
 * Everyone else imports `engine` from here. When the real engine is ready, change the one line
 * below; no caller needs to change.
 */
import type { Engine } from "../../../../contracts";
import { rebuiltEngine } from "./engine";

/** The engine in use: the real REBUILT engine (src/world/worlds/rebuilt/engine/engine.ts). The stub stays in stubEngine.ts for reference. */
export const engine: Engine = rebuiltEngine;

/** True while `engine` is the stub; results produced with a stub must not be reported. The real engine is in use. */
export const ENGINE_IS_STUB = false;

export { buildFieldLayout } from "./field";
export { buildObservationView, eventConcerns } from "./observe";
