import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.url)("ws");

export async function startInspectorHost(root) {
  const folder = resolve(root, "com.ibimu.display-controller.sdPlugin");
  const state = {
    settings: {}, messages: [], sockets: new Set(),
    monitors: [
      { id: "test-gcq", name: "GCQ271HA", display: "DISPLAY6", brightness: { percent: 12 }, error: null },
      { id: "internal", name: "NE180WUM-NY3", display: "DISPLAY1", brightness: null, error: "DDC/CI unsupported" },
    ],
  };
  const server = createServer(async (request, response) => {
    const path = resolve(folder, "." + new URL(request.url, "http://localhost").pathname);
    if (!path.startsWith(folder + "/") && !path.startsWith(folder + "\\")) { response.writeHead(403).end(); return; }
    try {
      const content = await readFile(path);
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(path)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": type }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  const wss = new WebSocketServer({ server });
  const send = (socket, payload) => socket.send(JSON.stringify({ event: "sendToPropertyInspector", payload: { context: "test-dial", ...payload } }));
  wss.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      state.messages.push(message);
      if (message.event === "sendToPlugin") send(socket, { type: "monitors", monitors: state.monitors });
      if (message.event === "setSettings") {
        state.settings = message.payload;
        socket.send(JSON.stringify({ event: "didReceiveSettings", payload: { settings: state.settings } }));
        const monitor = state.monitors.find((m) => m.id === state.settings.monitorId);
        send(socket, { type: "status", percent: monitor?.brightness?.percent ?? null, pending: false, error: monitor?.error ?? null });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    state, port, url: `http://127.0.0.1:${port}/ui/index.html`,
    publish(payload) { for (const socket of state.sockets) send(socket, payload); },
    async close() {
      for (const socket of state.sockets) socket.terminate();
      await new Promise((done) => wss.close(done));
      await new Promise((done) => server.close(done));
    },
  };
}
