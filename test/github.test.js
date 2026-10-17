import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, H } from "./helpers.js";
import { importGithub } from "../src/github.js";
import { CrewrailError } from "../src/store.js";

function issue(n, extra = {}) {
  return {
    number: n,
    title: `Issue ${n}`,
    body: `Body ${n}`,
    html_url: `https://github.com/o/r/issues/${n}`,
    labels: [{ name: "Good First Issue" }],
    ...extra,
  };
}
const page = (from, count) => Array.from({ length: count }, (_, k) => issue(from + k));

/** A fetch stand-in: answers is a list of [status, body, headers], one per call. */
function mockFetch(answers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const [status, body, headers = {}] = answers[calls.length - 1] ?? [200, []];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  f.calls = calls;
  return f;
}
const rl = (remaining) => ({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": "1790000000" });

function setup() {
  const t = fresh();
  t.store.createProject({ key: "CREW", name: "Crewrail" }, H);
  return t;
}

test("imports open issues, leaves pull requests out, keeps labels, sends no token", async () => {
  const { store } = setup();
  const f = mockFetch([[200, [issue(1), issue(2, { pull_request: {} }), issue(3, { labels: ["bug"], body: null })], rl(59)]]);
  const r = await importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: f, labels: ["from-github"] });
  assert.deepEqual(r.created, ["CREW-1", "CREW-2"]);
  assert.equal(r.pages, 1);
  assert.deepEqual(r.rate, { limit: 60, remaining: 59, reset: 1790000000 });
  assert.equal(f.calls[0].url, "https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1");
  assert.equal(f.calls[0].init.headers.authorization, undefined);
  const i1 = store.getIssue("CREW-1");
  assert.equal(i1.status, "todo");
  assert.equal(i1.source_url, "https://github.com/o/r/issues/1");
  assert.deepEqual(i1.labels, ["from-github", "good-first-issue"]);
  assert.equal(store.getIssue("CREW-2").description, "");
  assert.deepEqual(store.getIssue("CREW-2").labels, ["bug", "from-github"]);
});

test("a token is sent as a bearer header when given", async () => {
  const { store } = setup();
  const f = mockFetch([[200, []]]);
  await importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: f, token: "t0k" });
  assert.equal(f.calls[0].init.headers.authorization, "Bearer t0k");
});

test("a second import skips what is there", async () => {
  const { store } = setup();
  await importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: mockFetch([[200, [issue(1)]]]) });
  const r = await importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: mockFetch([[200, [issue(1), issue(2)]]]) });
  assert.deepEqual(r.created, ["CREW-2"]);
  assert.equal(r.skipped, 1);
});

test("pages until a short page, capped by maxPages", async () => {
  const { store } = setup();
  const f = mockFetch([[200, page(1, 100), rl(58)], [200, page(101, 100), rl(57)], [200, [issue(201)], rl(56)]]);
  const r = await importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: f, maxPages: 5 });
  assert.equal(r.pages, 3);
  assert.equal(r.created.length, 201);
  assert.match(f.calls[2].url, /page=3$/);

  const { store: s2 } = setup();
  const capped = mockFetch([[200, page(1, 100)], [200, page(101, 100)]]);
  const r2 = await importGithub(s2, { project: "CREW", repo: "o/r", actor: H, fetch: capped, maxPages: 1 });
  assert.equal(r2.pages, 1);
  assert.equal(capped.calls.length, 1);
});

test("rate limit: stops and keeps what it read; refused at once is an error", async () => {
  const { store } = setup();
  const f = mockFetch([[200, page(1, 100), rl(0)]]);
  const r = await importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: f, maxPages: 3 });
  assert.equal(r.created.length, 100);
  assert.equal(f.calls.length, 1, "no request once remaining is 0");
  assert.match(r.stopped, /rate limit reached: resets at 2026-/);

  const { store: s2 } = setup();
  const f2 = mockFetch([[200, page(1, 100), rl(1)], [403, { message: "API rate limit exceeded" }, { ...rl(0), "retry-after": "30" }]]);
  const r2 = await importGithub(s2, { project: "CREW", repo: "o/r", actor: H, fetch: f2, maxPages: 3 });
  assert.equal(r2.created.length, 100);
  assert.equal(r2.stopped, "GitHub rate limit: try again in 30 s");

  await assert.rejects(
    importGithub(s2, { project: "CREW", repo: "o/r", actor: H, fetch: mockFetch([[429, {}, { "retry-after": "12" }]]) }),
    (e) => e instanceof CrewrailError && e.code === 429 && /12 s/.test(e.message),
  );
});

test("bad input and missing repositories", async () => {
  const { store } = setup();
  await assert.rejects(importGithub(store, { project: "CREW", repo: "not a repo", actor: H, fetch: mockFetch([]) }), (e) => e.code === 400);
  await assert.rejects(importGithub(store, { project: "CREW", repo: "o/missing", actor: H, fetch: mockFetch([[404, {}]]) }), (e) => e.code === 404);
  await assert.rejects(importGithub(store, { project: "NOPE", repo: "o/r", actor: H, fetch: mockFetch([]) }), (e) => e.code === 404);
  await assert.rejects(importGithub(store, { project: "CREW", repo: "o/r", actor: H, fetch: mockFetch([[500, {}]]) }), (e) => e.code === 502);
});
