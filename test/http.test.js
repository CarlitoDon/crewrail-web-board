import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fresh, A, H } from "./helpers.js";
import { createHttpServer } from "../src/http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "crewrail.js");

async function serve(opts) {
  const { store } = fresh();
  const server = createHttpServer(store, opts);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

test("REST API: projects, issues, claim, submit, accept", async (t) => {
  const { server, base } = await serve({ token: "s3cret" });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const req = async (method, path, body, actor = H, auth = "Bearer s3cret") => {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: auth, ...(actor ? { "x-crewrail-actor": actor } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await req("GET", "/api/projects", null, H, "Bearer nope")).status, 401);
  assert.equal((await req("POST", "/api/projects", { key: "CREW", name: "Crewrail" })).status, 201);
  assert.equal((await req("POST", "/api/projects", { key: "CREW", name: "again" })).status, 409);
  const i = await req("POST", "/api/issues", { project: "CREW", title: "REST works", status: "todo", labels: ["api"], done_when: "curl returns 200 here" });
  assert.equal(i.status, 201);
  assert.equal(i.body.key, "CREW-1");
  assert.equal((await req("POST", "/api/issues", { project: "CREW", title: "x" }, null)).status, 400);
  assert.equal((await req("GET", "/api/issues?q=rest")).body.length, 1);
  const c = await req("POST", "/api/claim-next", { skills: ["api"] }, A);
  assert.equal(c.body.assignee, A);
  assert.deepEqual((await req("POST", "/api/claim-next", { skills: ["api"] }, A)).body, { issue: null });
  assert.equal((await req("POST", "/api/issues/CREW-1/progress", { body: "going" }, A)).status, 201);
  assert.equal((await req("POST", "/api/issues/CREW-1/submit", { evidence_url: "https://e.org/1" }, A)).body.status, "review");
  assert.equal((await req("POST", "/api/issues/CREW-1/reject", {}, H)).status, 400);
  assert.equal((await req("POST", "/api/issues/CREW-1/accept", {}, H)).body.status, "done");
  assert.equal((await req("GET", "/api/issues/CREW-1/job-draft")).body.body.done, "curl returns 200 here");
  assert.equal((await req("PATCH", "/api/issues/CREW-1", { title: "renamed" })).body.title, "renamed");
  assert.equal((await req("GET", "/api/projects/CREW/activity")).body[0].kind, "issue_updated");
  assert.equal((await req("GET", "/api/nothing")).status, 404);
  const raw = await fetch(base + "/api/projects", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: "not json" });
  assert.equal(raw.status, 400);
});

test("MCP over Streamable HTTP at /mcp", async (t) => {
  const { server, base, store } = await serve({ actor: H });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === "claim_next"));
  const r = await client.callTool({ name: "create_project", arguments: { key: "WEB", name: "Over HTTP" } });
  assert.equal(JSON.parse(r.content[0].text).key, "WEB");
  assert.equal(store.getProject("WEB").name, "Over HTTP");
  assert.equal((await fetch(base + "/mcp")).status, 405);
});


test("CLI and the MCP server on stdio", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crewrail-cli-"));
  // a child that inherits NODE_TEST_CONTEXT reports to the test runner instead of its own stdout
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const env = { ...base, CREWRAIL_DB: join(dir, "t.db"), CREWRAIL_ACTOR: H, NODE_NO_WARNINGS: "1" };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 15000 });
    const out = r.stdout.trim();
    return { code: r.status, out: out.startsWith("{") || out.startsWith("[") ? JSON.parse(out) : out, err: r.stderr };
  };
  assert.match(cli("--help").out, /claim \[--skills/);
  assert.equal(cli("project", "add", "CLI", "Command line").out.key, "CLI");
  assert.equal(cli("issue", "add", "CLI", "Try it", "--labels", "shell", "--status", "todo", "--done-when", "the command prints JSON").out.key, "CLI-1");
  assert.equal(cli("claim", "--skills", "shell", "--as", A).out.assignee, A);
  assert.equal(cli("submit", "CLI-1", "https://e.org/out", "--as", A).out.status, "review");
  assert.equal(cli("accept", "CLI-1").out.status, "done");
  const bad = cli("issue", "show", "CLI-9");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /error 404/);

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env, stderr: "ignore" }));
  try {
    const r = await client.callTool({ name: "list_issues", arguments: { project: "CLI" } });
    assert.equal(JSON.parse(r.content[0].text)[0].status, "done");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
