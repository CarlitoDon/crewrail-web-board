import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, A, H } from "./helpers.js";
import { CrewrailError, parseActor } from "../src/store.js";

const err = (code) => (e) => e instanceof CrewrailError && e.code === code;

test("actors", () => {
  assert.deepEqual(parseActor("agent:scout"), { actor: "agent:scout", kind: "agent", id: "scout" });
  assert.throws(() => parseActor("scout"), err(400));
  assert.throws(() => parseActor("robot:x"), err(400));
});

test("projects: keys, duplicates, counts", () => {
  const { store } = fresh();
  const p = store.createProject({ key: "crew", name: "Crewrail" }, H);
  assert.equal(p.key, "CREW");
  assert.deepEqual(p.counts, { backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0 });
  assert.throws(() => store.createProject({ key: "CREW", name: "x" }, H), err(409));
  assert.throws(() => store.createProject({ key: "1x", name: "x" }, H), err(400));
  assert.throws(() => store.getProject("NOPE"), err(404));
});

test("issues: create, numbering, fields, labels", () => {
  const { store } = fresh();
  store.createProject({ key: "CREW", name: "Crewrail" }, H);
  const i1 = store.createIssue({ project: "CREW", title: "  First   one ", labels: "Docs, Node JS", priority: "high", estimate: 3, done_when: "README has a quickstart" }, H);
  const i2 = store.createIssue({ project: "crew", title: "Second", parent: i1.key }, A);
  assert.equal(i1.key, "CREW-1");
  assert.equal(i2.key, "CREW-2");
  assert.equal(i1.title, "First one");
  assert.deepEqual(i1.labels, ["docs", "node-js"]);
  assert.equal(i1.priority, "high");
  assert.equal(i2.parent, "CREW-1");
  assert.equal(store.getIssue("CREW-1").children[0].key, "CREW-2");
  assert.equal(store.getIssue(i1.id).key, "CREW-1");
  assert.throws(() => store.createIssue({ project: "CREW", title: "" }, H), err(400));
  assert.throws(() => store.createIssue({ project: "CREW", title: "x", status: "done" }, H), err(400));
  assert.throws(() => store.createIssue({ project: "CREW", title: "x", priority: "asap" }, H), err(400));
  assert.throws(() => store.getIssue("CREW-99"), err(404));
});

test("issues: update rules, parent loops, labels, activity", () => {
  const { store } = fresh();
  store.createProject({ key: "CREW", name: "Crewrail" }, H);
  const a = store.createIssue({ project: "CREW", title: "A" }, H);
  const b = store.createIssue({ project: "CREW", title: "B", parent: a.key }, H);
  assert.throws(() => store.updateIssue(a.key, { parent: b.key }, H), err(400));
  assert.throws(() => store.updateIssue(a.key, { status: "done" }, H), err(400));
  assert.throws(() => store.updateIssue(a.key, { status: "review" }, H), err(400));
  const u = store.updateIssue(a.key, { status: "todo", labels: ["x"], assignee: "agent:z", estimate: 5 }, H);
  assert.equal(u.status, "todo");
  assert.equal(u.assignee, "agent:z");
  assert.deepEqual(u.labels, ["x"]);
  const kinds = store.activity({ issue: a.key }).map((x) => x.kind);
  assert.deepEqual(kinds, ["labels_changed", "issue_updated", "issue_created"]);
  const unassigned = store.updateIssue(a.key, { assignee: null }, H);
  assert.equal(unassigned.assignee, null);
});

test("search and filters", () => {
  const { store, tick } = fresh();
  store.createProject({ key: "CREW", name: "Crewrail" }, H);
  store.createIssue({ project: "CREW", title: "Fix the importer", description: "pages beyond 3", labels: ["github"], priority: "low" }, H);
  tick();
  store.createIssue({ project: "CREW", title: "Write docs", labels: ["docs"], priority: "urgent", status: "todo" }, H);
  assert.deepEqual(store.listIssues({ q: "importer" }).map((i) => i.key), ["CREW-1"]);
  assert.deepEqual(store.listIssues({ q: "PAGES beyond" }).map((i) => i.key), ["CREW-1"]);
  assert.deepEqual(store.listIssues({ label: "Docs" }).map((i) => i.key), ["CREW-2"]);
  assert.deepEqual(store.listIssues({ status: "todo" }).map((i) => i.key), ["CREW-2"]);
  assert.deepEqual(store.listIssues({ project: "CREW" }).map((i) => i.key), ["CREW-2", "CREW-1"]);
  assert.equal(store.listIssues({ assignee: "none" }).length, 2);
  assert.throws(() => store.listIssues({ status: "open" }), err(400));
});

test("links: blocks, url, self", () => {
  const { store } = fresh();
  store.createProject({ key: "CREW", name: "Crewrail" }, H);
  const a = store.createIssue({ project: "CREW", title: "A" }, H);
  const b = store.createIssue({ project: "CREW", title: "B" }, H);
  store.addLink(a.key, { kind: "blocks", target: b.key }, H);
  const withUrl = store.addLink(a.key, { kind: "url", url: "https://example.org/spec" }, H);
  assert.deepEqual(withUrl.links.map((l) => l.issue ?? l.url), ["CREW-2", "https://example.org/spec"]);
  assert.deepEqual(store.getIssue(b.key).blocked_by, ["CREW-1"]);
  assert.throws(() => store.addLink(a.key, { kind: "blocks", target: a.key }, H), err(400));
  assert.throws(() => store.addLink(a.key, { kind: "url", url: "javascript:alert(1)" }, H), err(400));
});

test("cycles: counts, points and burndown by day", () => {
  const { store, clock, tick } = fresh(Date.parse("2026-10-01T09:00:00Z"));
  store.createProject({ key: "CREW", name: "Crewrail" }, H);
  const c = store.createCycle({ project: "CREW", name: "Week 1", starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-10-08T00:00:00Z" }, H);
  const a = store.createIssue({ project: "CREW", title: "A", estimate: 3, cycle_id: c.id, status: "todo", done_when: "the A test passes" }, H);
  store.createIssue({ project: "CREW", title: "B", estimate: 2, cycle_id: c.id, status: "todo" }, H);
  store.claim(a.key, "agent:w");
  tick(86_400_000); // Oct 2
  store.submitForReview(a.key, { evidence_url: "https://example.org/run/1" }, "agent:w");
  store.review(a.key, { decision: "accept" }, H);
  clock.t = Date.parse("2026-10-03T12:00:00Z");
  const s = store.cycleSummary(c.id);
  assert.equal(s.state, "active");
  assert.equal(s.total, 2);
  assert.equal(s.by_status.done, 1);
  assert.equal(s.points, 5);
  assert.equal(s.points_done, 3);
  assert.deepEqual(s.burndown, [
    { day: "2026-10-01", remaining: 2, remaining_points: 5 },
    { day: "2026-10-02", remaining: 1, remaining_points: 2 },
    { day: "2026-10-03", remaining: 1, remaining_points: 2 },
  ]);
  assert.throws(() => store.createCycle({ project: "CREW", name: "bad", starts_at: "2026-10-08", ends_at: "2026-10-01" }, H), err(400));
  const other = store.createProject({ key: "OTH", name: "Other" }, H);
  assert.throws(() => store.createIssue({ project: other.key, title: "x", cycle_id: c.id }, H), err(400));
});

test("data survives reopening a file database", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/store.js");
  const dir = mkdtempSync(join(tmpdir(), "crewrail-"));
  const path = join(dir, "t.db");
  let s = new Store({ path });
  s.createProject({ key: "CREW", name: "Crewrail" }, H);
  s.close();
  s = new Store({ path });
  assert.equal(s.getProject("CREW").name, "Crewrail");
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
