import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";

// Windows shells and Node 20 do not expand test globs. Pass explicit paths to tsx.
const files = (await readdir("tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);
if (files.length === 0) throw new Error("No test files found");
const cli = createRequire(import.meta.url).resolve("tsx/cli");
const result = spawnSync(process.execPath, [cli, "--test", ...files], {
  stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
