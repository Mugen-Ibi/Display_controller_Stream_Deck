import streamDeck, {
  action, SingletonAction, type DialAction, type KeyAction, type KeyDownEvent, type DialDownEvent, type DialRotateEvent,
  type DialUpEvent, type DidReceiveSettingsEvent, type SendToPluginEvent,
  type PropertyInspectorDidAppearEvent, type TouchTapEvent, type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { BrightnessController, type DisplayState } from "./controller.js";
import { settingsOf, type Settings, type DisplayBackend } from "./types.js";

type Binding = { action: DialAction<Settings> | KeyAction<Settings>; settings: Required<Settings>; unsubscribe: () => void; rotated: boolean; down: boolean };

@action({ UUID: "com.ibimu.display-controller.brightness" })
export class BrightnessAction extends SingletonAction<Settings> {
  private bindings = new Map<string, Binding>();
  private pollBusy = false;
  private listing?: Promise<void>;
  private readonly controller: BrightnessController;

  constructor(private readonly backend: DisplayBackend) {
    super();
    this.controller = new BrightnessController(backend);
    setInterval(() => { void this.poll(); }, 3_000).unref();
    streamDeck.system.onSystemDidWakeUp(() => { void this.poll(); });
  }

  private async poll(): Promise<void> {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      const ids = new Set([...this.bindings.values()].map((b) => b.settings.monitorId).filter(Boolean));
      for (const id of ids) await this.controller.refresh(id);
    } finally { this.pollBusy = false; }
  }

  private bind(dial: DialAction<Settings> | KeyAction<Settings>, settings: Settings): void {
    this.bindings.get(dial.id)?.unsubscribe();
    const binding: Binding = { action: dial, settings: settingsOf(settings), unsubscribe: () => {}, down: false, rotated: false };
    this.bindings.set(dial.id, binding);
    if (!binding.settings.monitorId) {
      void this.feedback(binding, { pending: false });
      return;
    }
    binding.unsubscribe = this.controller.subscribe(binding.settings.monitorId, (state) => {
      if (this.bindings.get(dial.id) === binding) void this.feedback(binding, state);
    });
    void this.controller.refresh(binding.settings.monitorId);
  }

  private async feedback(binding: Binding, state: DisplayState): Promise<void> {
    const selected = Boolean(binding.settings.monitorId);
    const value = state.percent === undefined ? "—" : `${Math.round(state.percent)}%${state.pending ? " …" : ""}`;
    try {
      if (binding.action.isDial()) await binding.action.setFeedback({
        title: selected ? binding.settings.monitorName : "モニターを選択",
        value: state.error ? "接続 / 設定を確認" : value,
        indicator: state.percent ?? 0,
        icon: "imgs/brightness.svg",
      });
      else {
        const { buttonMode, step, preset } = binding.settings;
        const operation = buttonMode === "preset" ? `→${preset}%` : `${buttonMode === "decrease" ? "−" : "+"}${step}%`;
        await binding.action.setImage("imgs/key.svg");
        await binding.action.setTitle(selected ? `${operation}\n${state.error ? "接続確認" : value}` : "画面を\n選択");
      }
      if (streamDeck.ui.action?.id === binding.action.id) {
        await streamDeck.ui.sendToPropertyInspector({ type: "status", context: binding.action.id,
          percent: state.percent ?? null, pending: state.pending, error: state.error ?? null });
      }
      if (state.error) streamDeck.logger.warn(state.error);
    } catch (error) { streamDeck.logger.error("Feedback update failed", error); }
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isDial() || ev.action.isKey()) this.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.bindings.get(ev.action.id)?.unsubscribe();
    this.bindings.delete(ev.action.id);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isDial() || ev.action.isKey()) this.bind(ev.action, ev.payload.settings);
  }
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const binding = this.bindings.get(ev.action.id);
    if (!binding) return;
    const { monitorId, buttonMode, step, preset } = binding.settings;
    if (!monitorId) { await ev.action.showAlert(); return; }
    if (buttonMode === "preset") this.controller.preset(monitorId, preset);
    else this.controller.adjust(monitorId, buttonMode === "decrease" ? -step : step);
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
    this.controller.adjust(binding.settings.monitorId, ev.payload.ticks * step);
  }
  override onDialUp(ev: DialUpEvent<Settings>): void {
    const binding = this.bindings.get(ev.action.id);
    if (!binding) return;
    if (binding.down && !binding.rotated) this.controller.preset(binding.settings.monitorId, binding.settings.preset);
    binding.down = false;
    binding.rotated = false;
  }
  override onTouchTap(ev: TouchTapEvent<Settings>): void {
    const binding = this.bindings.get(ev.action.id);
    if (binding) void this.controller.refresh(binding.settings.monitorId);
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
        const monitors = await this.backend.list();
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
