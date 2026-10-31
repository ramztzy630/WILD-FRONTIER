/**
 * Game state machine (ARCHITECTURE.md §3.1). Pure: holds the current state,
 * validates transitions, and notifies a listener. Game.ts reacts to changes.
 */

export type GameStateName = "boot" | "mainMenu" | "loading" | "playing" | "paused" | "dead";

const TRANSITIONS: Readonly<Record<GameStateName, readonly GameStateName[]>> = {
  boot: ["mainMenu"],
  mainMenu: ["loading"],
  loading: ["playing", "mainMenu"],
  playing: ["paused", "dead", "mainMenu"],
  paused: ["playing", "mainMenu"],
  dead: ["loading", "mainMenu"],
};

export type StateChangeListener = (to: GameStateName, from: GameStateName) => void;

export class GameStateMachine {
  private current: GameStateName = "boot";
  private readonly listener: StateChangeListener | undefined;

  constructor(listener?: StateChangeListener) {
    this.listener = listener;
  }

  get state(): GameStateName {
    return this.current;
  }

  canTransition(to: GameStateName): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  /** Performs the transition if allowed. Returns false (and changes nothing) otherwise. */
  transition(to: GameStateName): boolean {
    if (!this.canTransition(to)) return false;
    const from = this.current;
    this.current = to;
    this.listener?.(to, from);
    return true;
  }

  is(...states: GameStateName[]): boolean {
    return states.includes(this.current);
  }
}
