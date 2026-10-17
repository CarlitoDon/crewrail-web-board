import { Store } from "../src/store.js";

export const A = "agent:scout";
export const B = "agent:checker";
export const H = "human:ana";

/** A store on an in-memory database with a clock the test moves. */
export function fresh(start = Date.parse("2026-10-01T00:00:00Z")) {
  const clock = { t: start };
  const store = new Store({ now: () => clock.t });
  return { store, clock, tick: (ms = 1) => (clock.t += ms) };
}
