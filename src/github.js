import { tx } from "./db.js";
import { CrewrailError, normLabel } from "./store.js";

const API = "https://api.github.com";

/**
 * Creates issues from a public GitHub repository's open issues (pull requests
 * left out). Read-only, no token needed for public repositories; pass token
 * for a higher rate limit. An issue already imported (same html_url) is
 * skipped. Stops early, keeping what it read, when the rate limit runs out.
 *
 * @returns {{ created: string[], skipped: number, pages: number, rate: object|null, stopped: string|null }}
 */
export async function importGithub(store, { project, repo, actor, maxPages = 3, labels = [], fetch: f = fetch, token, api = API }) {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(String(repo ?? "").trim());
  if (!m) throw new CrewrailError(400, 'repo must be "owner/name"');
  store.getProject(project);
  const pagesMax = Math.min(Math.max(Number(maxPages) || 1, 1), 10);
  const extra = (labels || []).map(normLabel);
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "crewrail-import",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const created = [];
  let skipped = 0;
  let pages = 0;
  let rate = null;
  let stopped = null;

  for (let page = 1; page <= pagesMax; page++) {
    const url = `${api}/repos/${m[1]}/${m[2]}/issues?state=open&per_page=100&page=${page}`;
    const res = await f(url, { headers });
    rate = rateOf(res.headers);
    if (res.status === 404) throw new CrewrailError(404, `no such public repository: ${m[1]}/${m[2]}`);
    if (res.status === 403 || res.status === 429) {
      const wait = waitSeconds(res.headers);
      stopped = `GitHub rate limit: try again in ${wait} s`;
      if (pages === 0) throw new CrewrailError(429, stopped);
      break;
    }
    if (!res.ok) throw new CrewrailError(502, `GitHub answered ${res.status}`);
    const items = await res.json();
    if (!Array.isArray(items)) throw new CrewrailError(502, "GitHub answered something other than a list");
    pages++;
    tx(store.db, () => {
      for (const it of items) {
        if (it.pull_request) continue;
        const exists = store.db
          .prepare("SELECT 1 FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = ? AND i.source_url = ?")
          .get(String(project).toUpperCase(), it.html_url);
        if (exists) {
          skipped++;
          continue;
        }
        const ghLabels = (it.labels || [])
          .map((l) => (typeof l === "string" ? l : l?.name))
          .filter((l) => typeof l === "string" && l.trim() && l.trim().length <= 40)
          .map(normLabel);
        const issue = store.createIssue(
          {
            project,
            title: String(it.title ?? "").slice(0, 200) || `GitHub issue #${it.number}`,
            description: String(it.body ?? "").slice(0, 20000),
            labels: [...new Set([...ghLabels, ...extra])].slice(0, 20),
            status: "todo",
            source_url: it.html_url,
          },
          actor,
        );
        created.push(issue.key);
      }
    });
    if (items.length < 100) break;
    if (rate && rate.remaining === 0) {
      stopped = `GitHub rate limit reached: resets at ${new Date(rate.reset * 1000).toISOString()}`;
      break;
    }
  }
  return { created, skipped, pages, rate, stopped };
}

function rateOf(h) {
  const remaining = h.get("x-ratelimit-remaining");
  if (remaining === null) return null;
  return { limit: Number(h.get("x-ratelimit-limit")), remaining: Number(remaining), reset: Number(h.get("x-ratelimit-reset")) };
}

function waitSeconds(h) {
  const after = Number(h.get("retry-after"));
  if (after > 0) return after;
  const reset = Number(h.get("x-ratelimit-reset"));
  if (reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return 60;
}
