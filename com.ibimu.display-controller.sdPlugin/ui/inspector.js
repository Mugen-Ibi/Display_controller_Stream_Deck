/* Stream Deck's property inspector runs in its own Chromium context. No CDN dependencies. */
let socket;
let context;
let actionId;
let settings = {};
let monitors = [];
const byId = (id) => document.getElementById(id);
const status = (text, error = false) => { byId("status").textContent = text; byId("status").classList.toggle("error", error); };
const send = (event, payload) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, ...(event === "sendToPlugin" ? { action: actionId } : {}), payload }));
};

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
  context = uuid;
  const action = JSON.parse(actionInfo);
  actionId = action.action;
  settings = action.payload.settings || {};
  renderSettings();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    refresh();
  };
  socket.onclose = () => status("Stream Deckとの接続が切れました。設定画面を開き直してください。", true);
  socket.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.event === "didReceiveSettings") {
      settings = message.payload.settings || {};
      renderSettings();
    }
    if (message.event !== "sendToPropertyInspector") return;
    const payload = message.payload;
    // UUID supplied at PI registration is the action's context.
    if (payload.context && payload.context !== action.context) return;
    if (payload.type === "monitors") {
      monitors = payload.monitors;
      byId("refresh").disabled = false;
      renderMonitors();
      const selected = monitors.find((m) => m.id === settings.monitorId);
      byId("brightness").textContent = selected?.brightness ? `${Math.round(selected.brightness.percent)}%` : "—";
      if (payload.error) status(payload.error, true);
      else if (!monitors.some((m) => m.brightness)) status("輝度を取得できるディスプレイがありません。DDC/CI設定をご確認ください。", true);
      else if (settings.monitorId) {
        status(selected?.error || (selected ? "接続済み" : "選択したディスプレイが見つかりません。"), !selected || !!selected.error);
      } else status("操作するディスプレイを選択してください。");
    }
    if (payload.type === "status") {
      byId("brightness").textContent = payload.percent === null ? "—" : `${Math.round(payload.percent)}%`;
      status(payload.error || (payload.pending ? "輝度を変更中…" : (settings.monitorId ? "接続済み" : "ディスプレイを選択してください。")), !!payload.error);
    }
  };
};

function renderSettings() {
  for (const [key, fallback] of [["step", 2], ["pressStep", 10], ["preset", 50]]) byId(key).value = settings[key] ?? fallback;
  renderMonitors();
}
function renderMonitors() {
  const select = byId("monitor");
  select.replaceChildren(new Option("ディスプレイを選択", ""));
  for (const monitor of monitors) {
    const suffix = monitor.brightness ? `${Math.round(monitor.brightness.percent)}%` : "DDC/CI取得不可";
    const option = new Option(`${monitor.name} · ${monitor.display} · ${suffix}`, monitor.id);
    option.disabled = !monitor.id || !monitor.brightness;
    select.add(option);
  }
  if (settings.monitorId && !monitors.some((m) => m.id === settings.monitorId)) {
    select.add(new Option(`${settings.monitorName || "選択済み"}（未接続）`, settings.monitorId));
  }
  select.value = settings.monitorId || "";
}
function refresh() {
  byId("refresh").disabled = true;
  status("ディスプレイを検出中…");
  send("sendToPlugin", { type: "refreshMonitors" });
}
byId("refresh").addEventListener("click", refresh);
byId("monitor").addEventListener("change", () => {
  const monitor = monitors.find((m) => m.id === byId("monitor").value);
  settings = { ...settings, monitorId: monitor?.id || "", monitorName: monitor?.name || "Display" };
  send("setSettings", settings);
});
for (const key of ["step", "pressStep", "preset"]) {
  byId(key).addEventListener("change", () => {
    const input = byId(key);
    if (!input.value || !input.checkValidity()) { renderSettings(); return; }
    settings = { ...settings, [key]: Number(input.value) };
    send("setSettings", settings);
  });
}
