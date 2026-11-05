import { clamp, type DisplayBackend } from "./types.js";

export type DisplayState = { percent?: number; pending: boolean; error?: string };
type Intent = { kind: "delta" | "absolute"; value: number };
type Entry = {
  state: DisplayState;
  target?: number;
  intents: Intent[];
  revision: number;
  work?: Promise<void>;
  listeners: Set<(state: DisplayState) => void>;
};

/** Shared by monitor ID, so two dials assigned to one screen cannot race. */
export class BrightnessController {
  private entries = new Map<string, Entry>();
  constructor(private readonly backend: DisplayBackend) {}

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { state: { pending: false }, intents: [], revision: 0, listeners: new Set() };
      this.entries.set(id, entry);
    }
    return entry;
  }

  subscribe(id: string, listener: (state: DisplayState) => void): () => void {
    const entry = this.entry(id);
    entry.listeners.add(listener);
    listener({ ...entry.state });
    return () => entry.listeners.delete(listener);
  }

  private emit(entry: Entry): void {
    for (const listener of entry.listeners) listener({ ...entry.state });
  }

  adjust(id: string, delta: number): void {
    if (!id || !Number.isFinite(delta) || delta === 0) return;
    this.intent(id, { kind: "delta", value: delta });
  }

  preset(id: string, percent: number): void {
    if (!id || !Number.isFinite(percent)) return;
    this.intent(id, { kind: "absolute", value: clamp(percent) });
  }

  private intent(id: string, intent: Intent): void {
    const entry = this.entry(id);
    entry.revision++;
    if (entry.target !== undefined) {
      entry.target = intent.kind === "absolute" ? intent.value : clamp(entry.target + intent.value);
    } else if (entry.intents.length === 0 && entry.state.percent !== undefined && !entry.state.error) {
      entry.target = intent.kind === "absolute" ? intent.value : clamp(entry.state.percent + intent.value);
    } else {
      // Keep the order at the bounds: +10, -10 at 100 must end at 90, not 100.
      entry.intents.push(intent);
    }
    entry.state = { percent: entry.target ?? entry.state.percent, pending: true };
    this.emit(entry);
    this.ensureWork(id, entry);
  }

  private ensureWork(id: string, entry: Entry): Promise<void> {
    if (entry.work) return entry.work;
    entry.work = this.run(id, entry).finally(() => { entry.work = undefined; });
    return entry.work;
  }

  private async run(id: string, entry: Entry): Promise<void> {
    try {
      if (entry.target === undefined) {
        const actual = await this.backend.get(id);
        let target = actual.percent;
        for (const intent of entry.intents) {
          target = intent.kind === "absolute" ? intent.value : clamp(target + intent.value);
        }
        const hadIntents = entry.intents.length > 0;
        entry.intents = [];
        if (!hadIntents && entry.target === undefined) {
          entry.state = { percent: actual.percent, pending: false };
          this.emit(entry);
          return;
        }
        // Rotation during polling can already have set a newer target.
        entry.target ??= target;
      }
      while (entry.target !== undefined) {
        const target = entry.target;
        const revision = entry.revision;
        const actual = await this.backend.set(id, target);
        if (entry.revision !== revision) continue;
        entry.target = undefined;
        entry.state = {
          percent: actual.percent, pending: false,
          ...(Math.abs(actual.percent - target) > 50 / (actual.maximum - actual.minimum) + 0.01
            ? { error: "変更が反映されません。HDR・画面モードを確認" } : {}),
        };
        this.emit(entry);
      }
    } catch (error) {
      // Never replay failed user commands after wake / reconnection.
      entry.target = undefined;
      entry.intents = [];
      entry.state = { pending: false, error: error instanceof Error ? error.message : String(error) };
      this.emit(entry);
    }
  }

  refresh(id: string): Promise<void> {
    if (!id) return Promise.resolve();
    return this.ensureWork(id, this.entry(id));
  }

  async idle(id: string): Promise<void> { await this.entries.get(id)?.work; }
}
