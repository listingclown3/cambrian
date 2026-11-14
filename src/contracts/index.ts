/**
 * Single source of truth for every shape shared between modules.
 * Import from "…/contracts" (this file), never redefine a shape elsewhere.
 * Changing anything here affects all four owners: announce it before you merge it.
 */
export * from "./common";
export * from "./field";
export * from "./profiles";
export * from "./actions";
export * from "./state";
export * from "./engine";
export * from "./policy";
export * from "./decide";
export * from "./config";
export * from "./manifest";
export * from "./events";
export * from "./scenario";
export * from "./results";
