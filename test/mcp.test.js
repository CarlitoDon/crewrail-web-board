import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fresh, A, B, H } from "./helpers.js";
import { createMcpServer } from "../src/mcp.js";

async function connect(store, opts = {}) {
  const server = createMcpServer(store, opts);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { error: r.content[0].text };
    return JSON.parse(r.content[0].text);
  };
  return { client, call };
}

const TOOLS = [
  "activity", "claim", "claim_next", "comment", "create_cycle", "create_issue", "create_project", "cycle_summary",
  "get_issue", "import_github", "job_draft", "list_issues", "list_projects", "post_progress", "review",
  "submit_for_review", "update_issue",
];

test("lists every tool with plain descriptions and read-only hints", async () => {
  const { client } = await connect(fresh().store);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.ok(t.description.length > 10, t.name);
    assert.doesNotMatch(t.description, /https?:|github\.com\/|docs/i, `${t.name} names no outside docs`);
  }
  const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(ro, ["activity", "cycle_summary", "get_issue", "job_draft", "list_issues", "list_projects"]);
});

test("the whole agent loop through MCP tools", async () => {
  const { store } = fresh();
  const { call } = await connect(store, { actor: H });
  const p = await call("create_project", { key: "crew", name: "Crewrail" });
  assert.equal(p.key, "CREW");
  const i = await call("create_issue", {
    project: "CREW", title: "Write the CLI help", labels: ["docs"], status: "todo", priority: "high",
    done_when: "crewrail --help lists every command",
  });
  assert.equal(i.key, "CREW-1");
  assert.equal((await call("list_issues", { q: "cli help" }))[0].key, "CREW-1");
  assert.equal((await call("list_issues", { status: "done" })).length, 0);

  assert.equal(await call("claim_next", { skills: ["python"], actor: A }), null);
  const claimed = await call("claim_next", { skills: ["docs"], actor: A });
  assert.equal(claimed.assignee, A);
  assert.equal(claimed.status, "in_progress");

  assert.match((await call("post_progress", { issue: "CREW-1", body: "draft", actor: B })).error, /^403/);
  await call("post_progress", { issue: "CREW-1", body: "draft written", actor: A });
  await call("comment", { issue: "CREW-1", body: "nice", actor: B });
  const sub = await call("submit_for_review", { issue: "CREW-1", evidence_url: "https://e.org/help.txt", actor: A });
  assert.equal(sub.status, "review");
  assert.match((await call("review", { issue: "CREW-1", decision: "accept", actor: A })).error, /^403/);
  const back = await call("review", { issue: "CREW-1", decision: "reject", reason: "claim is missing", actor: B });
  assert.equal(back.status, "in_progress");
  await call("submit_for_review", { issue: "CREW-1", evidence_url: "https://e.org/help2.txt", actor: A });
  const done = await call("review", { issue: "CREW-1", decision: "accept" });
  assert.equal(done.status, "done");
  assert.equal(done.reviews[1].reviewer, H);

  const full = await call("get_issue", { issue: "CREW-1" });
  assert.deepEqual(full.comments.map((c) => c.kind), ["progress", "comment"]);
  const acts = await call("activity", { issue: "CREW-1" });
  assert.equal(acts[0].kind, "accepted");

  const upd = await call("update_issue", { issue: "CREW-1", status: "todo" });
  assert.equal(upd.status, "todo");
  assert.equal(upd.done_at, null);

  const draft = await call("job_draft", { issue: "CREW-1" });
  assert.equal(draft.body.done, "crewrail --help lists every command");
});

test("cycles, errors and the missing actor", async () => {
  const { store } = fresh(Date.parse("2026-10-02T12:00:00Z"));
  const { call } = await connect(store);
  assert.match((await call("create_project", { key: "CREW", name: "x" })).error, /actor is required/);
  await call("create_project", { key: "CREW", name: "x", actor: H });
  const c = await call("create_cycle", { project: "CREW", name: "W1", starts_at: "2026-10-01", ends_at: "2026-10-08", actor: H });
  await call("create_issue", { project: "CREW", title: "a", estimate: 2, cycle_id: c.id, actor: H });
  const s = await call("cycle_summary", { cycle_id: c.id });
  assert.equal(s.total, 1);
  assert.equal(s.points, 2);
  assert.equal(s.burndown.length, 2);
  assert.match((await call("get_issue", { issue: "CREW-9" })).error, /^404/);
  assert.match((await call("update_issue", { issue: "CREW-1", status: "done", actor: H })).error, /Invalid|invalid/);
});

test("import_github goes through the fetch it is given", async () => {
  const { store } = fresh();
  store.createProject({ key: "CREW", name: "x" }, H);
  const fetch = async () =>
    new Response(JSON.stringify([{ number: 7, title: "From GitHub", body: "b", html_url: "https://github.com/o/r/issues/7", labels: [] }]), {
      status: 200,
    });
  const { call } = await connect(store, { actor: H, fetch });
  const r = await call("import_github", { project: "CREW", repo: "o/r" });
  assert.deepEqual(r.created, ["CREW-1"]);
  assert.equal(store.getIssue("CREW-1").source_url, "https://github.com/o/r/issues/7");
});
