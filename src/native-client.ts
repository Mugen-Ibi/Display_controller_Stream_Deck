import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Brightness, DisplayBackend, Monitor } from "./types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One command in flight globally: Windows DDC calls must not overlap. */
export class NativeClient implements DisplayBackend {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: Pending & { id: number };
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly executable: string,
    private readonly timeoutMs = 12_000,
    private readonly args: string[] = [],
  ) {}

  list(): Promise<Monitor[]> { return this.request({ op: "list" }); }
  get(monitorId: string): Promise<Brightness> { return this.request({ op: "get", monitor_id: monitorId }); }
  set(monitorId: string, percent: number): Promise<Brightness> {
    return this.request({ op: "set", monitor_id: monitorId, percent });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.executable, this.args, { windowsHide: true, stdio: "pipe", shell: false });
    this.child = child;
    // Drain stderr so a helper cannot block waiting for its pipe to empty.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        const message = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
        if (!this.pending || message.id !== this.pending.id) throw new Error("Invalid DDC response ID");
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error(message.error || "DDC command failed"));
      } catch (error) {
        this.fail(child, error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("error", (error) => this.fail(child, error));
    child.stdin.on("error", (error) => this.fail(child, error));
    child.on("exit", () => { lines.close(); this.fail(child, new Error("DDC helper exited")); });
    return child;
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    child.kill();
  }

  private request<T>(command: Record<string, unknown>): Promise<T> {
    const result = this.tail.then(() => new Promise<T>((resolve, reject) => {
      if (this.disposed) { reject(new Error("DDC client closed")); return; }
      const child = this.start();
      const id = ++this.sequence;
      this.pending = {
        id, resolve: (value) => resolve(value as T), reject,
        timer: setTimeout(() => this.fail(child, new Error("DDC communication timed out; check monitor connection")), this.timeoutMs),
      };
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n", (error) => {
        if (error) this.fail(child, error);
      });
    }));
    this.tail = result.catch(() => {});
    return result;
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) this.fail(this.child, new Error("DDC client closed"));
  }
}
