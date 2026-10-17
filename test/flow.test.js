import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, A, B, H } from "./helpers.js";
import { CrewrailError } from "../src/store.js";
import { jobDraft } from "../src/job-draft.js";

const err = (code) => (e) => e instanceof CrewrailError && e.code === code;

function setup() {
  const t = fresh();
  t.store.createProject({ key: "CREW", name: "Crewrail" }, H);
  return t;
}

test("claim next: skills match labels, urgency first, todo only, blocked skipped", () => {
  const { store, tick } = setup();
  store.createIssue({ project: "CREW", title: "backlog docs", labels: ["docs"] }, H); // backlog: never claimed
  tick();
  const low = store.createIssue({ project: "CREW", title: "low docs", labels: ["docs"], priority: "low", status: "todo" }, H);
  tick();
  const urgent = store.createIssue({ project: "CREW", title: "urgent docs", labels: ["docs"], priority: "urgent", status: "todo" }, H);
  tick();
  const code = store.createIssue({ project: "CREW", title: "code", labels: ["node"], priority: "urgent", status: "todo" }, H);
  const blocker = store.createIssue({ project: "CREW", title: "blocker", labels: ["ops"] }, H);
  store.addLink(blocker.key, { kind: "blocks", target: urgent.key }, H);

  const first = store.claimNext({ skills: ["Docs"] }, A);
  assert.equal(first.key, low.key, "the urgent one is blocked, so the low one comes");
  assert.equal(first.status, "in_progress");
  assert.equal(first.assignee, A);
  assert.equal(store.claimNext({ skills: ["docs"] }, B), null);
  assert.equal(store.claimNext({ skills: ["node"] }, B).key, code.key);
  assert.equal(store.claimNext({ skills: ["docs", "node"] }, B), null);
  assert.deepEqual(store.activity({ issue: low.key })[0].data, { skills: ["docs"] });

  // once the blocker is done, the urgent one can be claimed
  store.claim(blocker.key, B);
  store.updateIssue(blocker.key, { done_when: "the blocker is gone" }, H);
  store.submitForReview(blocker.key, { evidence_url: "https://e.org/b" }, B);
  store.review(blocker.key, { decision: "accept" }, H);
  assert.equal(store.claimNext({ skills: ["docs"] }, A).key, urgent.key);
});

test("claim: a named issue; one assigned to someone else is refused", () => {
  const { store } = setup();
  const i = store.createIssue({ project: "CREW", title: "x" }, H);
  store.claim(i.key, A);
  assert.throws(() => store.claim(i.key, B), err(409));
  assert.equal(store.claim(i.key, A).assignee, A);
});

test("progress, submit, reject with a reason, resubmit, accept", () => {
  const { store } = setup();
  const i = store.createIssue({ project: "CREW", title: "Ship v0", status: "todo", labels: ["node"] }, H);
  assert.throws(() => store.postProgress(i.key, "early", A), err(403));
  store.claimNext({ skills: ["node"] }, A);
  assert.throws(() => store.postProgress(i.key, "not mine", B), err(403));
  const p = store.postProgress(i.key, "half done", A);
  assert.equal(p.kind, "progress");

  assert.throws(() => store.submitForReview(i.key, { evidence_url: "https://e.org/1" }, A), err(409), "done_when needed");
  store.updateIssue(i.key, { done_when: "npm test passes on a fresh clone" }, H);
  assert.throws(() => store.submitForReview(i.key, { evidence_url: "https://e.org/1" }, B), err(403));
  assert.throws(() => store.submitForReview(i.key, { evidence_url: "ftp://e.org/1" }, A), err(400));
  const sub = store.submitForReview(i.key, { evidence_url: "https://e.org/run/1", note: "see the run" }, A);
  assert.equal(sub.status, "review");
  assert.throws(() => store.updateIssue(i.key, { status: "todo" }, H), err(409));
  assert.throws(() => store.review(i.key, { decision: "accept" }, A), err(403), "no self review");
  assert.throws(() => store.review(i.key, { decision: "reject" }, B), err(400), "a reason is required");

  const back = store.review(i.key, { decision: "reject", reason: "two tests fail on Windows" }, B);
  assert.equal(back.status, "in_progress");
  assert.equal(back.assignee, A);
  assert.equal(back.reviews[0].decision, "rejected");
  assert.equal(back.reviews[0].reason, "two tests fail on Windows");

  store.submitForReview(i.key, { evidence_url: "https://e.org/run/2" }, A);
  const done = store.review(i.key, { decision: "accept" }, H);
  assert.equal(done.status, "done");
  assert.ok(done.done_at);
  assert.equal(done.reviews.length, 2);
  assert.equal(done.reviews[1].reviewer, H);
  assert.throws(() => store.review(i.key, { decision: "accept" }, H), err(409));
  const kinds = store.activity({ issue: i.key }).map((x) => x.kind).reverse();
  assert.deepEqual(kinds, ["issue_created", "claimed", "progress", "issue_updated", "submitted", "rejected", "submitted", "accepted"]);
  assert.equal(store.getProject("CREW").counts.done, 1);
});

test("job draft: body from the issue, needs done_when", () => {
  const { store } = setup();
  const i = store.createIssue(
    { project: "CREW", title: "Add a Python client", description: "A small client for the REST API.", labels: ["python", "api"] },
    H,
  );
  assert.throws(() => jobDraft(store, i.key), err(409));
  store.updateIssue(i.key, { done_when: "pip install works and the README example runs" }, H);
  const d = jobDraft(store, i.key);
  assert.equal(d.endpoint, "POST https://musedin.com/api/job");
  assert.deepEqual(d.body, {
    title: "Add a Python client",
    summary: "A small client for the REST API. Tracked as CREW-1 in Crewrail.",
    done: "pip install works and the README example runs",
    skills: "api, python",
  });
  const long = store.createIssue(
    { project: "CREW", title: "T".repeat(150), description: "word ".repeat(400), done_when: "the page loads under 1 s" },
    H,
  );
  const d2 = jobDraft(store, long.key);
  assert.ok(d2.body.title.length <= 80);
  assert.ok(d2.body.summary.length <= 600 && d2.body.summary.length >= 20);
  assert.match(d2.body.summary, /Tracked as CREW-2 in Crewrail\.$/);
});
