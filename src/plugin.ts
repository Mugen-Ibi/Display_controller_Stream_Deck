import streamDeck, {
  action, SingletonAction, type DialAction, type DialDownEvent, type DialRotateEvent,
  type DialUpEvent, type DidReceiveSettingsEvent, type SendToPluginEvent,
  type PropertyInspectorDidAppearEvent, type TouchTapEvent, type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { fileURLToPath } from "node:url";
import { NativeClient } from "./native-client.js";
import { BrightnessController, type DisplayState } from "./controller.js";
import { settingsOf, type Settings } from "./types.js";

const backend = new NativeClient(fileURLToPath(new URL("./display-ddc.exe", import.meta.url)));
const controller = new BrightnessController(backend);
type Binding = { action: DialAction<Settings>; settings: Required<Settings>; unsubscribe: () => void; rotated: boolean; down: boolean };

@action({ UUID: "com.ibimu.display-controller.brightness" })
class BrightnessAction extends SingletonAction<Settings> {
  private bindings = new Map<string, Binding>();
  private pollBusy = false;
  private listing?: Promise<void>;

  constructor() {
    super();
    setInterval(() => { void this.poll(); }, 3_000).unref();
    streamDeck.system.onSystemDidWakeUp(() => { void this.poll(); });
  }

  private async poll(): Promise<void> {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      const ids = new Set([...this.bindings.values()].map((b) => b.settings.monitorId).filter(Boolean));
      for (const id of ids) await controller.refresh(id);
    } finally { this.pollBusy = false; }
  }

  private bind(dial: DialAction<Settings>, settings: Settings): void {
    this.bindings.get(dial.id)?.unsubscribe();
    const binding: Binding = { action: dial, settings: settingsOf(settings), unsubscribe: () => {}, down: false, rotated: false };
    this.bindings.set(dial.id, binding);
    if (!binding.settings.monitorId) {
      void this.feedback(binding, { pending: false });
      return;
    }
    binding.unsubscribe = controller.subscribe(binding.settings.monitorId, (state) => {
      if (this.bindings.get(dial.id) === binding) void this.feedback(binding, state);
    });
    void controller.refresh(binding.settings.monitorId);
  }

  private async feedback(binding: Binding, state: DisplayState): Promise<void> {
    const selected = Boolean(binding.settings.monitorId);
    const value = state.percent === undefined ? "—" : `${Math.round(state.percent)}%${state.pending ? " …" : ""}`;
    try {
      await binding.action.setFeedback({
        title: selected ? binding.settings.monitorName : "モニターを選択",
        value: state.error ? "接続 / 設定を確認" : value,
        indicator: state.percent ?? 0,
        icon: "imgs/brightness.svg",
      });
      if (streamDeck.ui.action?.id === binding.action.id) {
        await streamDeck.ui.sendToPropertyInspector({ type: "status", context: binding.action.id,
          percent: state.percent ?? null, pending: state.pending, error: state.error ?? null });
      }
      if (state.error) streamDeck.logger.warn(state.error);
    } catch (error) { streamDeck.logger.error("Feedback update failed", error); }
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isDial()) this.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.bindings.get(ev.action.id)?.unsubscribe();
    this.bindings.delete(ev.action.id);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isDial()) this.bind(ev.action, ev.payload.settings);
  }
  override onDialDown(ev: DialDownEvent<Settings>): void {
    const binding = this.bindings.get(ev.action.id);
    if (binding) { binding.down = true; binding.rotated = false; }
  }
  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const binding = this.bindings.get(ev.action.id);
    if (!binding) return;
    if (ev.payload.pressed || binding.down) binding.rotated = true;
    const step = ev.payload.pressed ? binding.settings.pressStep : binding.settings.step;
    controller.adjust(binding.settings.monitorId, ev.payload.ticks * step);
  }
  override onDialUp(ev: DialUpEvent<Settings>): void {
    const binding = this.bindings.get(ev.action.id);
    if (!binding) return;
    if (binding.down && !binding.rotated) controller.preset(binding.settings.monitorId, binding.settings.preset);
    binding.down = false;
    binding.rotated = false;
  }
  override onTouchTap(ev: TouchTapEvent<Settings>): void {
    const binding = this.bindings.get(ev.action.id);
    if (binding) void controller.refresh(binding.settings.monitorId);
  }
  override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<Settings>): void {
    void this.sendMonitors(ev.action.id);
  }
  override onSendToPlugin(ev: SendToPluginEvent<{ type?: string }, Settings>): void {
    const payload = ev.payload as { type?: string } | null;
    if (payload?.type === "refreshMonitors") void this.sendMonitors(ev.action.id);
  }

  private async sendMonitors(context: string): Promise<void> {
    // PI can request again while its didAppear list call is still in flight.
    if (this.listing) { await this.listing; if (streamDeck.ui.action?.id !== context) return; }
    this.listing = (async () => {
      try {
        const monitors = await backend.list();
        if (streamDeck.ui.action?.id === context) {
          await streamDeck.ui.sendToPropertyInspector({ type: "monitors", context, monitors });
        }
      } catch (error) {
        if (streamDeck.ui.action?.id === context) {
          await streamDeck.ui.sendToPropertyInspector({ type: "monitors", context, monitors: [], error: String(error) });
        }
      }
    })();
    try { await this.listing; } catch (error) { streamDeck.logger.error(error); }
    finally { this.listing = undefined; }
  }
}

// Raw property-inspector WebSocket messages use the legacy settings protocol.
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.actions.registerAction(new BrightnessAction());
process.on("exit", () => backend.dispose());
process.on("SIGTERM", () => { backend.dispose(); process.exit(0); });
process.on("SIGINT", () => { backend.dispose(); process.exit(0); });
streamDeck.connect().catch((error: unknown) => { streamDeck.logger.error(error); backend.dispose(); process.exit(1); });
