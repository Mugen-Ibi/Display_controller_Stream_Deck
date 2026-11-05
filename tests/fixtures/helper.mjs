import { createInterface } from "node:readline";
const mode = process.argv[2];
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "hang") return;
  if (mode === "crash") process.exit(1);
  if (mode === "invalid") { console.log("not-json"); return; }
  if (request.monitor_id === "missing") {
    console.log(JSON.stringify({ id: request.id, ok: false, error: "disconnected" })); return;
  }
  setTimeout(() => console.log(JSON.stringify({ id: request.id, ok: true, result: { percent: request.percent ?? 42, current: 42, minimum: 0, maximum: 100, method: "fixture" } })), 15);
});
