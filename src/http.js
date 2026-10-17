import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CrewrailError } from "./store.js";
import { createMcpServer } from "./mcp.js";
import { importGithub } from "./github.js";
import { jobDraft } from "./job-draft.js";

const MAX_BODY = 256 * 1024;

/**
 * A small REST API plus the MCP endpoint (Streamable HTTP, stateless) at /mcp.
 * When token is set, every request needs "Authorization: Bearer <token>".
 * The acting identity comes from the X-Crewrail-Actor header (or "actor" in a
 * JSON body), else the server's default actor.
 */
export function createHttpServer(store, { token, actor: defaultActor, fetch: f, githubToken } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        const { renderBoardHtml } = await import("./board.js");
        const html = renderBoardHtml(store, url.searchParams.get("project"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (token && !authorized(req, token)) return send(res, 401, { error: "missing or wrong bearer token" });
      const actorOf = (body) => body?.actor || req.headers["x-crewrail-actor"] || defaultActor;

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return send(res, 405, { error: "POST only (stateless server)" }, { allow: "POST" });
        const body = await readJson(req);
        const server = createMcpServer(store, { actor: actorOf(null), fetch: f, githubToken });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return send(res, 404, { error: "not found" });
      const [, a, b, c] = parts;
      const q = Object.fromEntries(url.searchParams);
      const m = req.method;
      const body = m === "POST" || m === "PATCH" ? await readJson(req) : {};
      const who = () => {
        const v = actorOf(body);
        if (!v) throw new CrewrailError(400, 'send X-Crewrail-Actor: "agent:<id>" or "human:<id>"');
        return v;
      };

      let out;
      if (a === "projects" && !b && m === "GET") out = store.listProjects();
      else if (a === "projects" && !b && m === "POST") out = [201, store.createProject(body, who())];
      else if (a === "projects" && b && !c && m === "GET") out = store.getProject(b);
      else if (a === "projects" && b && c === "cycles" && m === "GET") out = store.listCycles(b);
      else if (a === "projects" && b && c === "activity" && m === "GET") out = store.activity({ project: b, limit: q.limit });
      else if (a === "issues" && !b && m === "GET") out = store.listIssues(q);
      else if (a === "issues" && !b && m === "POST") out = [201, store.createIssue(body, who())];
      else if (a === "issues" && b && !c && m === "GET") out = store.getIssue(b);
      else if (a === "issues" && b && !c && m === "PATCH") {
        const { actor, ...patch } = body;
        out = store.updateIssue(b, patch, who());
      } else if (a === "issues" && b && c === "comments" && m === "POST") out = [201, store.comment(b, body.body, who())];
      else if (a === "issues" && b && c === "progress" && m === "POST") out = [201, store.postProgress(b, body.body, who())];
      else if (a === "issues" && b && c === "links" && m === "POST") out = [201, store.addLink(b, body, who())];
      else if (a === "issues" && b && c === "claim" && m === "POST") out = store.claim(b, who());
      else if (a === "issues" && b && c === "submit" && m === "POST") out = store.submitForReview(b, body, who());
      else if (a === "issues" && b && c === "accept" && m === "POST") out = store.review(b, { decision: "accept", reason: body.reason }, who());
      else if (a === "issues" && b && c === "reject" && m === "POST") out = store.review(b, { decision: "reject", reason: body.reason }, who());
      else if (a === "issues" && b && c === "activity" && m === "GET") out = store.activity({ issue: b, limit: q.limit });
      else if (a === "issues" && b && c === "job-draft" && m === "GET") out = jobDraft(store, b);
      else if (a === "claim-next" && !b && m === "POST") {
        out = store.claimNext({ project: body.project, skills: body.skills }, who());
        if (!out) return send(res, 200, { issue: null });
      } else if (a === "cycles" && !b && m === "POST") out = [201, store.createCycle(body, who())];
      else if (a === "cycles" && b && !c && m === "GET") out = store.cycleSummary(b);
      else if (a === "import" && b === "github" && m === "POST")
        out = await importGithub(store, { project: body.project, repo: body.repo, maxPages: body.max_pages, actor: who(), fetch: f, token: githubToken });
      else return send(res, 404, { error: "not found" });

      return Array.isArray(out) && typeof out[0] === "number" ? send(res, out[0], out[1]) : send(res, 200, out);
    } catch (e) {
      if (e instanceof CrewrailError) return send(res, e.code, { error: e.message });
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      console.error(e);
    }
  });
}

function authorized(req, token) {
  const h = String(req.headers.authorization || "");
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new CrewrailError(413, "body over 256 KB");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (v === null || typeof v !== "object") throw new Error();
    return v;
  } catch {
    throw new CrewrailError(400, "body must be a JSON object");
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}
