import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const child = spawn(fileURLToPath(new URL("../com.ibimu.display-controller.sdPlugin/bin/display-ddc.exe", import.meta.url)), [], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
const timer = setTimeout(() => { console.error("DDC helper timed out"); child.kill(); process.exitCode = 1; }, 15_000);
child.on("error", (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  clearTimeout(timer);
  const response = JSON.parse(line);
  console.log(JSON.stringify(response, null, 2));
  if (!response.ok) process.exitCode = 1;
  child.stdin.end();
});
child.stdin.on("error", () => {});
child.stdin.end(JSON.stringify({ id: 1, op: "list" }) + "\n");
