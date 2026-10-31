/**
 * Typed publish/subscribe bus.
 *
 * Systems emit events (e.g. inventory changed, discovery) and UI/audio
 * subscribe, so gameplay code never touches the DOM directly.
 * The event map type gives compile-time checking of names and payloads.
 */

export type Listener<P> = (payload: P) => void;

export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Subscribes and returns an unsubscribe function. */
  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(type, listener);
  }

  /** Subscribes for a single delivery. */
  once<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(type);
  }

  /**
   * Delivers synchronously in subscription order. A throwing listener does not
   * stop the others; the first error is re-thrown afterwards so it still
   * reaches the error overlay.
   */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    let firstError: unknown = undefined;
    let failed = false;
    // Copy so listeners may unsubscribe during delivery.
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }

  listenerCount<K extends keyof Events>(type: K): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
