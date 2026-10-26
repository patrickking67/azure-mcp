// The remote transport refuses anonymous and forged callers and advertises Entra as its OAuth server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/remote.js", import.meta.url));
const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";

test("remote: health, metadata, 401 for anonymous and invalid tokens", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port), ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, PUBLIC_URL: "https://mcp.example.test" }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => String(d).includes("listening") && resolve());
    child.on("exit", (code) => reject(new Error(`exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "read");
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(meta.resource, "https://mcp.example.test/mcp");
  assert.deepEqual(meta.authorization_servers, [`https://login.microsoftonline.com/${TENANT}/v2.0`]);
  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  const forged = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer a.b.c" }, body: "{}" });
  assert.equal(forged.status, 401);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
