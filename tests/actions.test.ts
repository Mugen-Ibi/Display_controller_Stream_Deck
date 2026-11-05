import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { Settings } from "../src/types.js";

test("SDK host: button modes, rapid presses, shared dials, settings and disconnection", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "display-controller-test-"));
  let child: ChildProcess | undefined;
  let server: WebSocketServer | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit"); child.kill(); await stopped;
    }
    if (server) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server!.close(() => done()));
    }
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("display-controller-test-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await copyFile("com.ibimu.display-controller.sdPlugin/manifest.json", join(directory, "manifest.json"));
  await build({ entryPoints: ["tests/fixtures/plugin.ts"], outfile: join(directory, "plugin.mjs"), bundle: true,
    platform: "node", format: "esm", target: "node20", banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: WebSocket | undefined;
  type Message = { event: string; context?: string; payload?: { title?: string; value?: string; indicator?: number } };
  const messages: Message[] = [];
  const latest = new Map<string, string>();
  server.on("connection", (connection) => {
    socket = connection;
    connection.on("message", (data) => {
      const message = JSON.parse(String(data)) as Message;
      messages.push(message);
      if (message.context && message.event === "setTitle") latest.set(message.context, message.payload?.title ?? "");
      if (message.context && message.event === "setFeedback") latest.set(message.context, message.payload?.value ?? "");
    });
  });
  const info = { application: { version: "7.6.1", platform: "windows", language: "ja", platformVersion: "10.0" },
    plugin: { uuid: "com.ibimu.display-controller", version: "0.2.0.0" }, devicePixelRatio: 1,
    devices: [{ id: "key-deck", name: "Stream Deck MK.2", type: 0, size: { columns: 5, rows: 3 } },
      { id: "dial-deck", name: "Stream Deck +", type: 7, size: { columns: 4, rows: 2 } }] };
  child = spawn(process.execPath, [join(directory, "plugin.mjs"), "-port", String(address.port), "-pluginUUID", "test", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const writes: number[] = [];
  let errors = "";
  child.stdout?.resume();
  child.stderr?.on("data", (data) => { errors += String(data); });
  child.on("message", (data) => { const m = data as { type: string; percent: number }; if (m.type === "write") writes.push(m.percent); });
  async function until(predicate: () => boolean) {
    const end = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < end && child?.exitCode === null && child.signalCode === null, errors || "SDK feedback timed out"); await delay(10); }
  }
  const base: Settings = { monitorId: "screen", monitorName: "Test monitor", step: 2, preset: 50 };
  function send(event: string, context: string, settings: Settings = base, payload: Record<string, unknown> = {}) {
    const dial = context === "dial";
    socket!.send(JSON.stringify({ event, context, action: "com.ibimu.display-controller.brightness", device: dial ? "dial-deck" : "key-deck",
      payload: { settings, controller: dial ? "Encoder" : "Keypad", isInMultiAction: false, coordinates: { column: 0, row: 0 }, ...payload } }));
  }
  await until(() => messages.some((m) => m.event === "registerPlugin"));
  send("willAppear", "up"); // Profiles without buttonMode default to increase.
  send("willAppear", "down", { ...base, buttonMode: "decrease" });
  send("willAppear", "preset", { ...base, buttonMode: "preset" });
  send("willAppear", "dial");
  await until(() => latest.get("up") === "+2%\n40%" && latest.get("down") === "−2%\n40%" && latest.get("preset") === "→50%\n40%");
  send("keyDown", "up"); send("keyUp", "up");
  await until(() => latest.get("up") === "+2%\n42%" && latest.get("down") === "−2%\n42%" && latest.get("dial") === "42%");
  assert.deepEqual(writes, [42], "one complete press must write once");
  send("keyDown", "down");
  await until(() => latest.get("up") === "+2%\n40%");
  send("keyDown", "preset");
  await until(() => latest.get("preset") === "→50%\n50%");
  const count = writes.length;
  for (let i = 0; i < 30; i++) { send("keyDown", "up"); send("keyUp", "up"); }
  await until(() => latest.get("up") === "+2%\n100%");
  assert.ok(writes.length - count < 30, "rapid button presses must coalesce");
  send("didReceiveSettings", "up", { ...base, buttonMode: "decrease", step: 5 });
  await until(() => latest.get("up") === "−5%\n100%");
  send("keyDown", "up");
  await until(() => latest.get("up") === "−5%\n95%");
  send("dialRotate", "dial", base, { ticks: -1, pressed: false });
  await until(() => latest.get("up") === "−5%\n93%" && latest.get("dial") === "93%");
  send("dialDown", "dial"); send("dialRotate", "dial", base, { ticks: -1, pressed: true }); send("dialUp", "dial");
  await until(() => latest.get("dial") === "83%");
  send("dialDown", "dial"); send("dialUp", "dial");
  await until(() => latest.get("dial") === "50%");
  send("willAppear", "empty", {});
  await until(() => latest.get("empty") === "画面を\n選択");
  const beforeEmpty = writes.length;
  send("keyDown", "empty", {});
  await until(() => messages.some((m) => m.event === "showAlert" && m.context === "empty"));
  assert.equal(writes.length, beforeEmpty);
  send("didReceiveSettings", "down", { ...base, monitorId: "missing", buttonMode: "decrease" });
  await until(() => latest.get("down") === "−2%\n接続確認");
  assert.ok(!messages.some((m) => m.event === "setFeedback" && m.context !== "dial"), "key-only devices must never receive encoder commands");
  send("willDisappear", "up");
  await delay(30);
  messages.length = 0;
  send("keyDown", "preset");
  await until(() => messages.some((m) => m.context === "preset" && m.event === "setTitle"));
  assert.ok(!messages.some((m) => m.context === "up"));
});
