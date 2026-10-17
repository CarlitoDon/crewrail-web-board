#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Store, CrewrailError } from "../src/store.js";
import { importGithub } from "../src/github.js";
import { jobDraft } from "../src/job-draft.js";
import { createMcpServer } from "../src/mcp.js";
import { createHttpServer } from "../src/http.js";
import { VERSION } from "../src/version.js";

const HELP = `crewrail ${VERSION}: projects, issues and cycles for crews of agents

Database: --db <file> or CREWRAIL_DB (default ./crewrail.db)
Identity: --as agent:<id> | human:<id>, or CREWRAIL_ACTOR

  project add <KEY> <name> [--description d]
  project list
  issue add <KEY> <title> [--description d] [--done-when line] [--labels a,b]
            [--priority urgent|high|medium|low] [--estimate n] [--status backlog|todo]
            [--parent KEY-n] [--cycle id] [--assignee agent:<id>]
  issue list [--project KEY] [--status s] [--assignee a|none] [--label l] [--q words]
  issue show <KEY-n>
  issue set <KEY-n> [--status s] [--title t] [--done-when line] [--labels a,b]
            [--priority p] [--estimate n] [--assignee a|none] [--parent KEY-n] [--cycle id]
  issue link <KEY-n> <blocks|relates|duplicates> <KEY-m>   |   issue link <KEY-n> url <https://...>
  claim [--skills a,b] [--project KEY]          take the next matching todo issue
  claim <KEY-n>                                  take one issue
  progress <KEY-n> <text>
  comment <KEY-n> <text>
  submit <KEY-n> <evidence-url> [--note text]
  accept <KEY-n> [--reason text]
  reject <KEY-n> <reason>
  cycle add <KEY> <name> <start> <end>           dates in ISO 8601
  cycle list <KEY>
  cycle show <id>
  activity [--project KEY] [--issue KEY-n] [--limit n]
  import github <KEY> <owner/repo> [--pages n]  open issues of a public repository
  job-draft <KEY-n>                             job post body for the issue (nothing sent)
  serve [--port 8787] [--host 127.0.0.1]        REST API + MCP at /mcp (CREWRAIL_TOKEN: bearer token)
  mcp                                            MCP server on stdio
`;

const { values: o, positionals: p } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    as: { type: "string" },
    description: { type: "string" },
    "done-when": { type: "string" },
    labels: { type: "string" },
    priority: { type: "string" },
    estimate: { type: "string" },
    status: { type: "string" },
    parent: { type: "string" },
    cycle: { type: "string" },
    assignee: { type: "string" },
    project: { type: "string" },
    label: { type: "string" },
    q: { type: "string" },
    title: { type: "string" },
    skills: { type: "string" },
    note: { type: "string" },
    reason: { type: "string" },
    issue: { type: "string" },
    limit: { type: "string" },
    pages: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (o.version) {
  console.log(VERSION);
  process.exit(0);
}
if (o.help || !p.length) {
  process.stdout.write(HELP);
  process.exit(0);
}

const store = new Store({ path: o.db || process.env.CREWRAIL_DB || "crewrail.db" });
const actor = o.as || process.env.CREWRAIL_ACTOR;
const me = () => {
  if (!actor) throw new CrewrailError(400, "say who acts: --as agent:<id> or CREWRAIL_ACTOR");
  return actor;
};
const def = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const none = (v) => (v === "none" ? null : v);
const num = (v) => (v === undefined ? undefined : v === "none" ? null : Number(v));

async function run() {
  const [cmd, sub, ...rest] = p;
  switch (cmd) {
    case "project":
      if (sub === "add") return store.createProject({ key: rest[0], name: rest[1], description: o.description }, me());
      if (sub === "list") return store.listProjects();
      break;
    case "issue":
      if (sub === "add")
        return store.createIssue(
          def({
            project: rest[0], title: rest[1], description: o.description, done_when: o["done-when"], labels: o.labels,
            priority: o.priority, estimate: o.estimate, status: o.status, parent: o.parent,
            cycle_id: num(o.cycle), assignee: o.assignee,
          }),
          me(),
        );
      if (sub === "list")
        return store.listIssues(def({ project: o.project, status: o.status, assignee: o.assignee, label: o.label, q: o.q, limit: o.limit }));
      if (sub === "show") return store.getIssue(rest[0]);
      if (sub === "set")
        return store.updateIssue(
          rest[0],
          def({
            status: o.status, title: o.title, description: o.description, done_when: o["done-when"], labels: o.labels,
            priority: o.priority, estimate: num(o.estimate), assignee: o.assignee === undefined ? undefined : none(o.assignee),
            parent: o.parent === undefined ? undefined : none(o.parent), cycle_id: num(o.cycle),
          }),
          me(),
        );
      if (sub === "link")
        return store.addLink(rest[0], rest[1] === "url" ? { kind: "url", url: rest[2] } : { kind: rest[1], target: rest[2] }, me());
      break;
    case "claim":
      if (sub) return store.claim(sub, me());
      return store.claimNext({ project: o.project, skills: o.skills }, me()) ?? { issue: null, note: "nothing matches" };
    case "progress":
      return store.postProgress(sub, rest.join(" "), me());
    case "comment":
      return store.comment(sub, rest.join(" "), me());
    case "submit":
      return store.submitForReview(sub, { evidence_url: rest[0], note: o.note }, me());
    case "accept":
      return store.review(sub, { decision: "accept", reason: o.reason }, me());
    case "reject":
      return store.review(sub, { decision: "reject", reason: rest.join(" ") || o.reason }, me());
    case "cycle":
      if (sub === "add") return store.createCycle({ project: rest[0], name: rest[1], starts_at: rest[2], ends_at: rest[3] }, me());
      if (sub === "list") return store.listCycles(rest[0]);
      if (sub === "show") return store.cycleSummary(rest[0]);
      break;
    case "activity":
      return store.activity(def({ project: o.project, issue: o.issue, limit: o.limit }));
    case "import":
      if (sub === "github")
        return importGithub(store, { project: rest[0], repo: rest[1], maxPages: o.pages, actor: me(), token: process.env.GITHUB_TOKEN });
      break;
    case "job-draft":
      return jobDraft(store, sub);
    case "serve": {
      const port = Number(o.port || process.env.PORT || 8787);
      const host = o.host || "127.0.0.1";
      const token = process.env.CREWRAIL_TOKEN;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !token)
        throw new CrewrailError(400, "set CREWRAIL_TOKEN before listening beyond this machine");
      createHttpServer(store, { token, actor, githubToken: process.env.GITHUB_TOKEN }).listen(port, host, () =>
        console.error(`crewrail listening on http://${host}:${port} (REST /api, MCP /mcp)`),
      );
      return undefined;
    }
    case "mcp": {
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createMcpServer(store, { actor, githubToken: process.env.GITHUB_TOKEN });
      await server.connect(new StdioServerTransport());
      return undefined;
    }
  }
  throw new CrewrailError(400, `unknown command: ${p.join(" ")} (crewrail --help)`);
}

try {
  const out = await run();
  if (out !== undefined) console.log(JSON.stringify(out, null, 2));
} catch (e) {
  if (e instanceof CrewrailError) {
    console.error(`error ${e.code}: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
