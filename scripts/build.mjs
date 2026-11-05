import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build on Windows x64 with Rust MSVC and Node.js installed.");
const cargo = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", "native/Cargo.toml"], { stdio: "inherit", windowsHide: true });
if (cargo.status !== 0) process.exit(cargo.status || 1);
const folder = "com.ibimu.display-controller.sdPlugin";
for (const size of [256, 512]) {
  const icon = new Resvg(await readFile(`${folder}/imgs/plugin.svg`, "utf8"), { fitTo: { mode: "width", value: size } });
  await writeFile(`${folder}/imgs/plugin${size === 512 ? "@2x" : ""}.png`, icon.render().asPng());
}
await mkdir(`${folder}/bin`, { recursive: true });
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["src/plugin.ts"], outfile: `${folder}/bin/plugin.js`, bundle: true, platform: "node", format: "esm", target: "node20", sourcemap: true, banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
await copyFile("native/target/release/display-ddc.exe", `${folder}/bin/display-ddc.exe`);
await copyFile("LICENSE", `${folder}/LICENSE`);
await writeFile(`${folder}/package.json`, JSON.stringify({ type: "module", private: true, license: "MIT" }));
const licenses = ["Third-party dependencies distributed with Display Controller.\n"];
for (const dependency of ["@elgato/streamdeck", "@elgato/utils", "ws", "zod"]) {
  licenses.push(`\n--- ${dependency} ---\n${await readFile(`node_modules/${dependency}/LICENSE`, "utf8")}`);
}
const metadata = spawnSync("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", "native/Cargo.toml"], { encoding: "utf8", windowsHide: true });
if (metadata.status !== 0) throw new Error(metadata.stderr || "Cargo metadata failed");
for (const dependency of JSON.parse(metadata.stdout).packages) {
  if (dependency.name === "display-ddc") continue;
  const directory = dirname(dependency.manifest_path);
  const licenseFiles = (await readdir(directory)).filter((name) => /^(license|copying|copyright|notice)/i.test(name));
  if (!licenseFiles.length) throw new Error(`Missing license for ${dependency.name}`);
  licenses.push(`\n--- ${dependency.name} ${dependency.version} (${dependency.license}) ---`);
  for (const name of licenseFiles) licenses.push(await readFile(join(directory, name), "utf8"));
}
await writeFile(`${folder}/THIRD-PARTY-NOTICES.txt`, licenses.join("\n"));
console.log(`Built ${folder}`);
