import { useSyncExternalStore } from "react";

export const POLL_MS = 10_000;

/**
 * A value refreshed from the chain while anything on screen reads it. Polling starts with the first
 * subscriber, stops with the last, and pauses while the tab is hidden; a failed refresh keeps the
 * last good value and records the error beside it.
 */
export class Feed<T> {
  private value: T;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    initial: T,
    private readonly refresh: (current: T) => Promise<T>,
    private readonly onError: (current: T, error: unknown) => T,
    private readonly interval = POLL_MS,
  ) {
    this.value = initial;
  }

  get = (): T => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Refreshes now, outside the schedule. */
  poke = (): void => {
    void this.tick();
  };

  private set(v: T) {
    this.value = v;
    for (const l of this.listeners) l();
  }

  private start() {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    void this.tick();
  }

  private stop() {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private onVisible = () => {
    if (!document.hidden && this.listeners.size > 0) this.poke();
  };

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.set(await this.refresh(this.value));
    } catch (e) {
      this.set(this.onError(this.value, e));
    } finally {
      this.running = false;
    }
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.listeners.size === 0) return;
    this.timer = setTimeout(() => {
      if (typeof document !== "undefined" && document.hidden) this.schedule();
      else void this.tick();
    }, this.interval);
  }
}

export function useFeed<T>(feed: Feed<T>): T {
  return useSyncExternalStore(feed.subscribe, feed.get, feed.get);
}

/** A short reason for a failed read, without viem's multi-line request dump. */
export function errorMessage(e: unknown): string {
  const m = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 200);
}
