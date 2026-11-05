import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { NativeClient } from "../src/native-client.js";
const fixture = fileURLToPath(new URL("./fixtures/helper.mjs", import.meta.url));

test("JSON-lines requests serialize and individual errors do not poison the queue", async () => {
  const client = new NativeClient(process.execPath, 2000, [fixture]);
  try {
    const results = await Promise.allSettled([client.set("a", 20), client.get("missing"), client.set("b", 60)]);
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "rejected");
    const last = results[2];
    assert.equal(last?.status, "fulfilled");
    if (last?.status === "fulfilled") assert.equal(last.value.percent, 60);
  } finally { client.dispose(); }
});

for (const mode of ["hang", "crash", "invalid"]) {
  test(`helper ${mode} fails promptly and queued requests can restart`, async () => {
    const client = new NativeClient(process.execPath, mode === "hang" ? 150 : 2000, [fixture, mode]);
    try {
      await assert.rejects(client.get("a"));
      await assert.rejects(client.get("a"));
    } finally { client.dispose(); }
  });
}

test("missing executable and disposal are reported without hanging", async () => {
  const client = new NativeClient("Z:/does-not-exist/display-ddc.exe", 1000);
  await assert.rejects(client.list());
  client.dispose();
  await assert.rejects(client.list(), /closed/);
});
