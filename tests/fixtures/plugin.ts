import streamDeck from "@elgato/streamdeck";
import { BrightnessAction } from "../../src/brightness-action.js";
import type { DisplayBackend, Brightness } from "../../src/types.js";

let value = 40;
const reading = (): Brightness => ({ percent: value, current: value, minimum: 0, maximum: 100, method: "fixture" });
const backend: DisplayBackend = {
  async list() { return [{ id: "screen", name: "Test monitor", display: "DISPLAY1", brightness: reading(), error: null }]; },
  async get(id) { if (id !== "screen") throw new Error("Disconnected"); return reading(); },
  async set(id, percent) {
    if (id !== "screen") throw new Error("Disconnected");
    process.send?.({ type: "write", id, percent });
    await new Promise((done) => setTimeout(done, 30));
    value = percent;
    return reading();
  },
};
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.actions.registerAction(new BrightnessAction(backend));
await streamDeck.connect();
