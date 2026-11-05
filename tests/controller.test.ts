import { test } from "node:test";
import assert from "node:assert/strict";
import { BrightnessController, type DisplayState } from "../src/controller.js";
import { settingsOf, type Brightness, type DisplayBackend } from "../src/types.js";

const reading = (percent: number): Brightness => ({ percent, current: percent, minimum: 0, maximum: 100, method: "vcp" });
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Backend implements DisplayBackend {
  value = 40;
  writes: [string, number][] = [];
  fail = false;
  getGate?: ReturnType<typeof gate<Brightness>>;
  setGate?: ReturnType<typeof gate<Brightness>>;
  async list() { return []; }
  async get() {
    if (this.fail) throw new Error("Disconnected");
    return this.getGate ? this.getGate.promise : reading(this.value);
  }
  async set(id: string, percent: number) {
    this.writes.push([id, percent]);
    if (this.fail) throw new Error("Disconnected");
    this.value = percent;
    return this.setGate ? this.setGate.promise : reading(percent);
  }
}

test("100 rapid events coalesce and the latest target wins", async () => {
  const backend = new Backend();
  const controller = new BrightnessController(backend);
  await controller.refresh("screen");
  const wait = backend.setGate = gate<Brightness>();
  controller.adjust("screen", 1);
  for (let i = 0; i < 99; i++) controller.adjust("screen", 1);
  assert.deepEqual(backend.writes, [["screen", 41]]);
  backend.setGate = undefined;
  wait.resolve(reading(41));
  await controller.idle("screen");
  assert.deepEqual(backend.writes, [["screen", 41], ["screen", 100]]);
});

test("initial rotation is based on hardware and preserves ordered clamping", async () => {
  const backend = new Backend();
  const wait = backend.getGate = gate<Brightness>();
  const controller = new BrightnessController(backend);
  controller.adjust("screen", 10);
  controller.adjust("screen", -10);
  wait.resolve(reading(100));
  await controller.idle("screen");
  assert.deepEqual(backend.writes, [["screen", 90]]);
});

test("poll in flight never overwrites a newer dial target", async () => {
  const backend = new Backend();
  const controller = new BrightnessController(backend);
  await controller.refresh("screen");
  const wait = backend.getGate = gate<Brightness>();
  void controller.refresh("screen");
  controller.adjust("screen", 2);
  wait.resolve(reading(25));
  await controller.idle("screen");
  assert.equal(backend.value, 42);
});

test("two subscriptions to one monitor share a single target", async () => {
  const backend = new Backend();
  const controller = new BrightnessController(backend);
  let a: DisplayState = { pending: false }, b = a;
  controller.subscribe("screen", (state) => { a = state; });
  controller.subscribe("screen", (state) => { b = state; });
  controller.adjust("screen", 2);
  controller.adjust("screen", 2);
  await controller.idle("screen");
  assert.equal(a.percent, 44);
  assert.deepEqual(a, b);
});

test("failed writes are discarded, reconnect only reads, and next input recovers", async () => {
  const backend = new Backend();
  const controller = new BrightnessController(backend);
  let state: DisplayState = { pending: false };
  controller.subscribe("screen", (s) => { state = s; });
  await controller.refresh("screen");
  backend.fail = true;
  controller.preset("screen", 80);
  await controller.idle("screen");
  assert.match(state.error!, /Disconnected/);
  backend.fail = false;
  backend.value = 23;
  await controller.refresh("screen");
  assert.equal(state.percent, 23);
  assert.equal(backend.writes.length, 1);
  controller.adjust("screen", 2);
  await controller.idle("screen");
  assert.equal(backend.value, 25);
});

test("external app changes are reflected on refresh without a write", async () => {
  const backend = new Backend();
  const controller = new BrightnessController(backend);
  let state: DisplayState = { pending: false };
  controller.subscribe("screen", (s) => { state = s; });
  await controller.refresh("screen");
  backend.value = 75;
  await controller.refresh("screen");
  assert.equal(state.percent, 75);
  assert.equal(backend.writes.length, 0);
});

test("ignored hardware writes expose actual brightness and an error", async () => {
  const backend = new Backend();
  backend.set = async () => reading(40);
  const controller = new BrightnessController(backend);
  let state: DisplayState = { pending: false };
  controller.subscribe("screen", (s) => { state = s; });
  controller.preset("screen", 80);
  await controller.idle("screen");
  assert.equal(state.percent, 40);
  assert.ok(state.error);
});

test("preset supersedes pending rotation and clamps to limits", async () => {
  const backend = new Backend();
  const wait = backend.getGate = gate<Brightness>();
  const controller = new BrightnessController(backend);
  controller.adjust("screen", 15);
  controller.preset("screen", 50);
  controller.adjust("screen", -500);
  wait.resolve(reading(40));
  await controller.idle("screen");
  assert.deepEqual(backend.writes, [["screen", 0]]);
});

test("multiple inputs after an ignored write retain every delta during re-read", async () => {
  const backend = new Backend();
  const originalSet = backend.set.bind(backend);
  backend.set = async () => reading(40);
  const controller = new BrightnessController(backend);
  controller.preset("screen", 80);
  await controller.idle("screen");
  backend.set = originalSet;
  const wait = backend.getGate = gate<Brightness>();
  controller.adjust("screen", 5);
  controller.adjust("screen", 2);
  wait.resolve(reading(40));
  await controller.idle("screen");
  assert.equal(backend.value, 47);
});

test("readback tolerates half-step rounding, but detects a full ignored hardware step", async () => {
  const backend = new Backend();
  backend.set = async () => ({ ...reading(12), current: 6, maximum: 50 });
  const controller = new BrightnessController(backend);
  let state: DisplayState = { pending: false };
  controller.subscribe("screen", (s) => { state = s; });
  controller.preset("screen", 13);
  await controller.idle("screen");
  assert.equal(state.error, undefined);
  controller.preset("screen", 14);
  await controller.idle("screen");
  assert.ok(state.error);
});

test("unselected and non-finite input never writes hardware", async () => {
  const backend = new Backend();
  const controller = new BrightnessController(backend);
  controller.adjust("", 5);
  controller.adjust("screen", NaN);
  controller.preset("screen", Infinity);
  await controller.idle("screen");
  assert.equal(backend.writes.length, 0);
});

test("settings from profiles are validated at the trust boundary", () => {
  assert.deepEqual(settingsOf({ step: NaN, pressStep: 1000, preset: -20 }), {
    monitorId: "", monitorName: "Display", step: 2, pressStep: 25, preset: 0, buttonMode: "increase",
  });
});
