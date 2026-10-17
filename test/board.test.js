import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fresh, A, H } from "./helpers.js";
import { createHttpServer } from "../src/http.js";

async function serve(opts) {
  const { store } = fresh();
  const server = createHttpServer(store, opts);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

test("read-only web board: GET / answers 200 text/html and shows 5 columns with counts", async (t) => {
  const { store, server, base } = await serve();
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  // 1. Setup project CREW with issues across 5 different statuses
  store.createProject({ key: "CREW", name: "Crewrail Project" }, H);

  // Backlog
  store.createIssue({ project: "CREW", title: "Backlog item", status: "backlog" }, H);

  // Todo
  store.createIssue({ project: "CREW", title: "Todo item 1", status: "todo" }, H);
  store.createIssue({ project: "CREW", title: "Todo item 2", status: "todo" }, H);

  // In progress (claimed)
  const iProg = store.createIssue({ project: "CREW", title: "In progress item", status: "todo" }, H);
  store.claim(iProg.key, A);

  // Review (submitted)
  const iRev = store.createIssue({ project: "CREW", title: "Review item", status: "todo", done_when: "checked" }, H);
  store.claim(iRev.key, A);
  store.submitForReview(iRev.key, { evidence_url: "https://example.com/rev" }, A);

  // Done (accepted)
  const iDone = store.createIssue({ project: "CREW", title: "Done item", status: "todo", done_when: "checked" }, H);
  store.claim(iDone.key, A);
  store.submitForReview(iDone.key, { evidence_url: "https://example.com/done" }, A);
  store.review(iDone.key, { decision: "accept" }, H);

  // Setup a cycle
  const now = Date.now();
  store.createCycle({
    project: "CREW",
    name: "Cycle 1",
    starts_at: now - 86400000,
    ends_at: now + 86400000 * 6
  }, H);

  // 2. Test GET / answers 200 text/html
  const resRoot = await fetch(base + "/");
  assert.equal(resRoot.status, 200);
  assert.match(resRoot.headers.get("content-type"), /text\/html/);

  // 3. Test GET /?project=CREW
  const resCrew = await fetch(base + "/?project=CREW");
  assert.equal(resCrew.status, 200);
  assert.match(resCrew.headers.get("content-type"), /text\/html/);

  const html = await resCrew.text();

  // Verify project name/key
  assert.match(html, /Crewrail Project/);
  assert.match(html, /CREW/);

  // Verify five status columns exist
  assert.match(html, /data-status="backlog"/);
  assert.match(html, /data-status="todo"/);
  assert.match(html, /data-status="in_progress"/);
  assert.match(html, /data-status="review"/);
  assert.match(html, /data-status="done"/);

  // Verify counts: backlog=1, todo=2, in_progress=1, review=1, done=1
  const project = store.getProject("CREW");
  assert.equal(project.counts.backlog, 1);
  assert.equal(project.counts.todo, 2);
  assert.equal(project.counts.in_progress, 1);
  assert.equal(project.counts.review, 1);
  assert.equal(project.counts.done, 1);

  // Verify burndown section rendered
  assert.match(html, /Cycle Burndown: Cycle 1/);
});
