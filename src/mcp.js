import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrewrailError, STATUSES } from "./store.js";
import { importGithub } from "./github.js";
import { jobDraft } from "./job-draft.js";
import { VERSION } from "./version.js";

const actorArg = z
  .string()
  .optional()
  .describe('Who acts, as "agent:<id>" or "human:<id>". Defaults to the identity this server was started with.');
const issueArg = z.string().describe('Issue key such as "CREW-12", or its numeric id.');

/**
 * Builds an MCP server over a Store.
 * @param {import("./store.js").Store} store
 * @param {{ actor?: string, fetch?: typeof fetch, githubToken?: string }} opts
 */
export function createMcpServer(store, opts = {}) {
  const server = new McpServer(
    { name: "crewrail", version: VERSION },
    {
      instructions:
        "Crewrail tracks projects, issues and cycles for crews of agents and people. " +
        "To work: claim_next with your skills, post_progress while you work, submit_for_review with an evidence link " +
        "that shows the issue's done_when line holds, then wait for a reviewer to accept or send it back.",
    },
  );

  const who = (a) => {
    const v = a || opts.actor;
    if (!v) throw new CrewrailError(400, 'actor is required: "agent:<id>" or "human:<id>"');
    return v;
  };

  const tool = (name, description, inputSchema, run, { readOnly = false } = {}) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: name === "import_github" },
      },
      async (args) => {
        try {
          const out = await run(args);
          return { content: [{ type: "text", text: JSON.stringify(out ?? null, null, 2) }] };
        } catch (e) {
          if (!(e instanceof CrewrailError)) throw e;
          return { isError: true, content: [{ type: "text", text: `${e.code}: ${e.message}` }] };
        }
      },
    );

  tool("list_projects", "List projects with issue counts per status.", {}, () => store.listProjects(), { readOnly: true });

  tool(
    "create_project",
    "Create a project. key is a short code used in issue keys (a letter, then letters or digits, 10 at most).",
    { key: z.string(), name: z.string(), description: z.string().optional(), actor: actorArg },
    (a) => store.createProject(a, who(a.actor)),
  );

  tool(
    "list_issues",
    "List or search issues, most urgent first. All filters are optional; q matches words in the title and description.",
    {
      project: z.string().optional().describe("Project key."),
      status: z.enum(STATUSES).optional(),
      assignee: z.string().optional().describe('"agent:<id>", "human:<id>", or "none" for unassigned.'),
      label: z.string().optional(),
      cycle_id: z.number().int().optional(),
      q: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    (a) => store.listIssues(a),
    { readOnly: true },
  );

  tool("get_issue", "Read one issue with its links, children, comments and reviews.", { issue: issueArg }, (a) => store.getIssue(a.issue), {
    readOnly: true,
  });

  tool(
    "create_issue",
    "Create an issue. done_when is one line a stranger can check to tell the work is done.",
    {
      project: z.string(),
      title: z.string(),
      description: z.string().optional(),
      done_when: z.string().optional(),
      status: z.enum(["backlog", "todo"]).optional(),
      priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(),
      estimate: z.number().int().min(0).max(1000).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().optional().describe('"agent:<id>" or "human:<id>".'),
      parent: z.string().optional().describe("Parent issue key."),
      cycle_id: z.number().int().optional(),
      actor: actorArg,
    },
    (a) => store.createIssue(a, who(a.actor)),
  );

  tool(
    "update_issue",
    "Change an issue's fields or move it between backlog, todo and in_progress. Review and done go through submit_for_review and review.",
    {
      issue: issueArg,
      status: z.enum(["backlog", "todo", "in_progress"]).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      done_when: z.string().optional(),
      priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional(),
      estimate: z.number().int().min(0).max(1000).nullable().optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.string().nullable().optional(),
      parent: z.string().nullable().optional(),
      cycle_id: z.number().int().nullable().optional(),
      actor: actorArg,
    },
    ({ issue, actor, ...patch }) => store.updateIssue(issue, patch, who(actor)),
  );

  tool(
    "claim_next",
    "Take the most urgent unassigned todo issue whose labels match one of your skills; it becomes yours and in progress. Returns null when nothing matches.",
    {
      skills: z.array(z.string()).optional().describe("Labels you can work on. Empty: any todo issue."),
      project: z.string().optional(),
      actor: actorArg,
    },
    (a) => store.claimNext({ project: a.project, skills: a.skills }, who(a.actor)),
  );

  tool("claim", "Take one named issue: it becomes yours and in progress.", { issue: issueArg, actor: actorArg }, (a) =>
    store.claim(a.issue, who(a.actor)),
  );

  tool("comment", "Add a comment to an issue.", { issue: issueArg, body: z.string(), actor: actorArg }, (a) =>
    store.comment(a.issue, a.body, who(a.actor)),
  );

  tool(
    "post_progress",
    "Post a progress note on an issue you are working on (assignee only, in progress).",
    { issue: issueArg, body: z.string(), actor: actorArg },
    (a) => store.postProgress(a.issue, a.body, who(a.actor)),
  );

  tool(
    "submit_for_review",
    "Hand in your work: evidence_url is a link a reviewer opens to check the issue's done_when line.",
    { issue: issueArg, evidence_url: z.string(), note: z.string().optional(), actor: actorArg },
    (a) => store.submitForReview(a.issue, { evidence_url: a.evidence_url, note: a.note }, who(a.actor)),
  );

  tool(
    "review",
    "Accept an issue in review (it becomes done) or reject it with a reason (it goes back to its assignee in progress). The assignee cannot review their own work.",
    { issue: issueArg, decision: z.enum(["accept", "reject"]), reason: z.string().optional(), actor: actorArg },
    (a) => store.review(a.issue, { decision: a.decision, reason: a.reason }, who(a.actor)),
  );

  tool(
    "create_cycle",
    "Create a time-boxed cycle in a project. Dates in ISO 8601.",
    { project: z.string(), name: z.string(), starts_at: z.string(), ends_at: z.string(), actor: actorArg },
    (a) => store.createCycle(a, who(a.actor)),
  );

  tool(
    "cycle_summary",
    "Counts per status, estimate points and a daily burndown of what is left for a cycle.",
    { cycle_id: z.number().int() },
    (a) => store.cycleSummary(a.cycle_id),
    { readOnly: true },
  );

  tool(
    "activity",
    "Recent activity, newest first, for an issue, a project or everything.",
    { issue: z.string().optional(), project: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    (a) => store.activity(a),
    { readOnly: true },
  );

  tool(
    "import_github",
    'Create issues from the open issues of a public GitHub repository ("owner/name"). Issues imported before are skipped.',
    { project: z.string(), repo: z.string(), max_pages: z.number().int().min(1).max(10).optional(), actor: actorArg },
    (a) =>
      importGithub(store, {
        project: a.project,
        repo: a.repo,
        maxPages: a.max_pages,
        actor: who(a.actor),
        fetch: opts.fetch,
        token: opts.githubToken,
      }),
  );

  tool(
    "job_draft",
    "Build the body of a job post for an issue (title, summary, done). Nothing is sent.",
    { issue: issueArg },
    (a) => jobDraft(store, a.issue),
    { readOnly: true },
  );

  return server;
}

