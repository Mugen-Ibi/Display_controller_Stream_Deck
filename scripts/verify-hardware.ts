/** Opt-in integration check: real plugin + SDK over a test host, real DDC, then restore. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { NativeClient } from "../src/native-client.js";

const folder = resolve("com.ibimu.display-controller.sdPlugin");
const client = new NativeClient(resolve(folder, "bin/display-ddc.exe"));
const requested = process.argv[2];
if (!requested) throw new Error("Usage: npm run verify:hardware -- GCQ271HA (temporarily changes brightness)");
const monitors = (await client.list()).filter((m) => m.name === requested && m.brightness);
if (monitors.length !== 1) { client.dispose(); throw new Error("Exactly one matching DDC monitor is required"); }
const monitor = monitors[0]!;
const before = await client.get(monitor.id);
const direction = before.percent > 94 ? -1 : 1;
const step = Math.ceil(100 / (before.maximum - before.minimum));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
if (typeof address === "string" || !address) throw new Error("No test port");
const received: { event: string; payload?: Record<string, any> }[] = [];
let connection: WebSocket | undefined;
server.on("connection", (socket) => {
  connection = socket;
  socket.on("message", (message) => { received.push(JSON.parse(String(message))); });
});
const settings = { monitorId: monitor.id, monitorName: monitor.name, step, pressStep: step, preset: before.percent };
const info = {
  application: { version: "7.6.1", platform: "windows", platformVersion: "10.0", language: "ja" },
  plugin: { uuid: "com.ibimu.display-controller", version: "0.2.0.0" },
  devicePixelRatio: 1,
  devices: [{ id: "test-deck", name: "Test Stream Deck +", type: 7, size: { columns: 4, rows: 2 } }],
  colors: { buttonPressedBackgroundColor: "#333333", buttonPressedBorderColor: "#333333", buttonPressedTextColor: "#ffffff", disabledColor: "#777777", highlightColor: "#00aaff", mouseDownColor: "#444444" },
};
const plugin = spawn(process.execPath, ["bin/plugin.js", "-port", String(address.port), "-pluginUUID", "test-plugin", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], { cwd: folder, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let errors = "";
plugin.stdout.resume();
plugin.stderr.on("data", (chunk) => { errors += chunk; });
async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline || plugin.exitCode !== null) throw new Error(`${description}: ${errors || "timed out"}`);
    await delay(25);
  }
}
function send(event: string, payload: Record<string, unknown> = {}) {
  connection!.send(JSON.stringify({ event, context: "test-dial", action: "com.ibimu.display-controller.brightness", device: "test-deck", payload: { settings, controller: "Encoder", coordinates: { column: 0, row: 0 }, ...payload } }));
}
async function displayed(percent: number) {
  await waitFor(() => received.some((m) => m.event === "setFeedback" && m.payload?.value === `${Math.round(percent)}%`), `Expected ${percent}% feedback`);
  received.length = 0;
}
function sendKey(event: string, buttonMode: "increase" | "decrease" | "preset") {
  connection!.send(JSON.stringify({ event, context: "test-key", action: "com.ibimu.display-controller.brightness", device: "test-deck",
    payload: { settings: { ...settings, buttonMode }, controller: "Keypad", isInMultiAction: false, coordinates: { column: 0, row: 0 } } }));
}
async function keyDisplayed(operation: string, percent: number) {
  await waitFor(() => received.some((m) => m.event === "setTitle" && m.payload?.title === `${operation}\n${Math.round(percent)}%`), `Expected key ${operation} / ${percent}%`);
  received.length = 0;
}
try {
  await waitFor(() => received.some((m) => m.event === "registerPlugin"), "Plugin registration");
  send("willAppear");
  await displayed(before.percent);
  send("propertyInspectorDidAppear");
  await waitFor(() => received.some((m) => m.event === "sendToPropertyInspector" && m.payload?.type === "monitors"), "PI monitor list");
  received.length = 0;
  send("dialRotate", { ticks: direction, pressed: false });
  await displayed(before.percent + direction * step);
  send("dialDown");
  send("dialRotate", { ticks: direction, pressed: true });
  send("dialUp");
  await displayed(before.percent + direction * step * 2);
  await delay(300);
  const after = await client.get(monitor.id);
  assert.ok(Math.abs(after.percent - (before.percent + direction * step * 2)) <= step / 2, "Pressed rotation must not trigger preset on release");
  send("dialDown");
  send("dialUp");
  await displayed(before.percent);
  send("touchTap", { tapPos: [100, 50], hold: false });
  await displayed(before.percent);
  const forward = direction > 0 ? "increase" : "decrease";
  const reverse = direction > 0 ? "decrease" : "increase";
  const forwardLabel = `${direction > 0 ? "+" : "−"}${step}%`;
  const reverseLabel = `${direction > 0 ? "−" : "+"}${step}%`;
  sendKey("willAppear", forward);
  await keyDisplayed(forwardLabel, before.percent);
  sendKey("keyDown", forward); sendKey("keyUp", forward);
  await keyDisplayed(forwardLabel, before.percent + direction * step);
  sendKey("didReceiveSettings", reverse);
  await keyDisplayed(reverseLabel, before.percent + direction * step);
  sendKey("keyDown", reverse); sendKey("keyUp", reverse);
  await keyDisplayed(reverseLabel, before.percent);
  sendKey("didReceiveSettings", forward);
  await keyDisplayed(forwardLabel, before.percent);
  sendKey("keyDown", forward);
  await keyDisplayed(forwardLabel, before.percent + direction * step);
  sendKey("didReceiveSettings", "preset");
  await keyDisplayed(`→${Math.round(before.percent)}%`, before.percent + direction * step);
  sendKey("keyDown", "preset");
  await keyDisplayed(`→${Math.round(before.percent)}%`, before.percent);
  send("didReceiveSettings", { settings: { ...settings, monitorId: "disconnected-test-monitor" } });
  await waitFor(() => received.some((m) => m.event === "setFeedback" && m.payload?.value === "接続 / 設定を確認"), "Disconnected feedback");
  console.log(JSON.stringify({ monitor: monitor.name, originalPercent: before.percent, range: [before.minimum, before.maximum], checks: ["SDK registration", "PI discovery", "dial rotation", "pressed rotation", "preset", "touch refresh", "key increase", "key decrease", "key preset", "disconnected display"] }, null, 2));
} finally {
  // Stop new polling / writes before restoring through a separate helper.
  const stopped = once(plugin, "exit").catch(() => {});
  plugin.kill();
  if (plugin.exitCode === null) await stopped;
  connection?.terminate();
  await new Promise<void>((done) => server.close(() => done()));
  try {
    const restored = await client.set(monitor.id, before.percent);
    assert.equal(restored.current, before.current, "Original hardware value must be restored");
    console.log(`Restored ${monitor.name}: raw ${restored.current}/${restored.maximum} (${restored.percent}%)`);
  } finally { client.dispose(); }
}
