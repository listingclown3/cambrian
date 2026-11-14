/**
 * Engine entry point (owner: P1).
 *
 * Everyone else imports `engine` from here. When the real engine is ready, change the one line
 * below; no caller needs to change.
 */
import type { Engine } from "../contracts";
import { stubEngine } from "./stubEngine";

/** The engine in use. Currently the stub. */
export const engine: Engine = stubEngine;

/** True while `engine` is the stub; results produced with it must not be reported. */
export const ENGINE_IS_STUB = true;

export { buildFieldLayout } from "./field";
export { buildObservationView, eventConcerns } from "./observe";
