import { openDb, tx } from "./db.js";

export const STATUSES = ["backlog", "todo", "in_progress", "review", "done"];
export const PRIORITIES = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
const PRIORITY_NAMES = Object.fromEntries(Object.entries(PRIORITIES).map(([k, v]) => [v, k]));
export const LINK_KINDS = ["blocks", "relates", "duplicates", "url"];

/** An error a caller can show as is. code mirrors an HTTP status. */
export class CrewrailError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const bad = (m) => new CrewrailError(400, m);
const notFound = (m) => new CrewrailError(404, m);
const conflict = (m) => new CrewrailError(409, m);
const forbidden = (m) => new CrewrailError(403, m);

const DAY = 86_400_000;

/**
 * Actors are strings "agent:<id>" or "human:<id>". id: 1-64 characters of
 * letters, digits, . _ - @.
 */
export function parseActor(actor) {
  const m = typeof actor === "string" && /^(agent|human):([A-Za-z0-9._@-]{1,64})$/.exec(actor.trim());
  if (!m) throw bad(`actor must look like "agent:<id>" or "human:<id>" (got ${JSON.stringify(actor)})`);
  return { actor: `${m[1]}:${m[2]}`, kind: m[1], id: m[2] };
}

function text(value, field, { min = 0, max, oneLine = false } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw bad(`${field} must be a string`);
  let v = value.replace(/\r\n?/g, "\n").trim();
  if (oneLine) v = v.replace(/\s+/g, " ");
  if (v.length < min) throw bad(min === 1 ? `${field} is required` : `${field}: at least ${min} characters`);
  if (max && v.length > max) throw bad(`${field}: at most ${max} characters (got ${v.length})`);
  return v;
}

function httpUrl(value, field) {
  if (typeof value !== "string") throw bad(`${field} must be a URL`);
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    throw bad(`${field} must be a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw bad(`${field} must be an http or https URL`);
  if (u.href.length > 500) throw bad(`${field}: at most 500 characters`);
  return u.href;
}

export function normLabel(l) {
  if (typeof l !== "string") throw bad("labels must be strings");
  const v = l.trim().toLowerCase().replace(/\s+/g, "-");
  if (!v || v.length > 40) throw bad(`label must be 1-40 characters: ${JSON.stringify(l)}`);
  return v;
}
function labelsOf(input) {
  if (input === undefined || input === null) return [];
  const list = typeof input === "string" ? input.split(",") : input;
  if (!Array.isArray(list)) throw bad("labels must be a list or a comma-separated string");
  const out = [...new Set(list.filter((x) => String(x).trim() !== "").map(normLabel))];
  if (out.length > 20) throw bad("at most 20 labels");
  return out;
}

function priorityOf(p) {
  if (p === undefined || p === null || p === "") return 0;
  if (typeof p === "string" && p.toLowerCase() in PRIORITIES) return PRIORITIES[p.toLowerCase()];
  const n = Number(p);
  if (Number.isInteger(n) && n >= 0 && n <= 4) return n;
  throw bad("priority must be none, urgent, high, medium, low (or 0-4)");
}
function estimateOf(e) {
  if (e === undefined || e === null || e === "") return null;
  const n = Number(e);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw bad("estimate must be a whole number 0-1000");
  return n;
}
function timeOf(t, field) {
  if (typeof t === "number" && Number.isFinite(t)) return Math.trunc(t);
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw bad(`${field} must be a date (ISO 8601) or unix milliseconds`);
  return ms;
}

export class Store {
  /** @param {{ db?: import("node:sqlite").DatabaseSync, path?: string, now?: () => number }} opts */
  constructor(opts = {}) {
    this.db = opts.db ?? openDb(opts.path ?? ":memory:");
    this.now = opts.now ?? Date.now;
  }

  close() {
    this.db.close();
  }

  log(projectId, issueId, actor, kind, data = {}) {
    this.db
      .prepare("INSERT INTO activity (project_id, issue_id, actor, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, issueId, actor, kind, JSON.stringify(data), this.now());
  }

  // ---------- projects ----------

  createProject({ key, name, description = "" }, actor) {
    const a = parseActor(actor);
    const k = text(key, "key", { min: 1, max: 10 }).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(k)) throw bad("key: a letter, then letters or digits, 10 at most (e.g. CREW)");
    const n = text(name, "name", { min: 1, max: 80, oneLine: true });
    const d = text(description, "description", { max: 2000 });
    return tx(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM projects WHERE key = ?").get(k)) throw conflict(`project ${k} exists`);
      const r = this.db
        .prepare("INSERT INTO projects (key, name, description, created_at) VALUES (?, ?, ?, ?)")
        .run(k, n, d, this.now());
      const id = Number(r.lastInsertRowid);
      this.log(id, null, a.actor, "project_created", { key: k, name: n });
      return this.getProject(k);
    });
  }

  getProject(ref) {
    const row =
      typeof ref === "number"
        ? this.db.prepare("SELECT * FROM projects WHERE id = ?").get(ref)
        : this.db.prepare("SELECT * FROM projects WHERE key = ?").get(String(ref ?? "").toUpperCase());
    if (!row) throw notFound(`no such project: ${ref}`);
    const counts = Object.fromEntries(
      this.db
        .prepare("SELECT status, COUNT(*) AS n FROM issues WHERE project_id = ? GROUP BY status")
        .all(row.id)
        .map((r) => [r.status, r.n]),
    );
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      counts: Object.fromEntries(STATUSES.map((s) => [s, counts[s] ?? 0])),
    };
  }

  listProjects() {
    return this.db
      .prepare("SELECT key FROM projects ORDER BY key")
      .all()
      .map((r) => this.getProject(r.key));
  }

  // ---------- issues ----------

  /** Resolves "CREW-12" or a numeric id to the issue row. */
  issueRow(ref) {
    let row;
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      row = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(Number(ref));
    } else {
      const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(String(ref ?? "").trim());
      if (m)
        row = this.db
          .prepare("SELECT i.* FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = ? AND i.number = ?")
          .get(m[1].toUpperCase(), Number(m[2]));
    }
    if (!row) throw notFound(`no such issue: ${ref}`);
    return row;
  }

  keyOf(row) {
    const p = this.db.prepare("SELECT key FROM projects WHERE id = ?").get(row.project_id);
    return `${p.key}-${row.number}`;
  }

  issueOut(row, { full = false } = {}) {
    const labels = this.db
      .prepare("SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label")
      .all(row.id)
      .map((r) => r.label);
    const out = {
      id: row.id,
      key: this.keyOf(row),
      project: this.db.prepare("SELECT key FROM projects WHERE id = ?").get(row.project_id).key,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: PRIORITY_NAMES[row.priority],
      estimate: row.estimate,
      labels,
      assignee: row.assignee,
      parent: row.parent_id ? this.keyOf(this.issueRow(row.parent_id)) : null,
      cycle_id: row.cycle_id,
      done_when: row.done_when,
      source_url: row.source_url,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      done_at: row.done_at,
    };
    if (full) {
      out.links = this.db
        .prepare("SELECT * FROM issue_links WHERE issue_id = ? ORDER BY id")
        .all(row.id)
        .map((l) => ({
          id: l.id,
          kind: l.kind,
          ...(l.kind === "url" ? { url: l.url } : { issue: this.keyOf(this.issueRow(l.target_id)) }),
        }));
      out.blocked_by = this.db
        .prepare("SELECT issue_id FROM issue_links WHERE kind = 'blocks' AND target_id = ?")
        .all(row.id)
        .map((r) => this.keyOf(this.issueRow(r.issue_id)));
      out.children = this.db
        .prepare("SELECT * FROM issues WHERE parent_id = ? ORDER BY number")
        .all(row.id)
        .map((c) => ({ key: this.keyOf(c), title: c.title, status: c.status }));
      out.comments = this.db
        .prepare("SELECT id, author, kind, body, created_at FROM comments WHERE issue_id = ? ORDER BY id")
        .all(row.id)
        .map((c) => ({ ...c }));
      out.reviews = this.db
        .prepare("SELECT * FROM reviews WHERE issue_id = ? ORDER BY id")
        .all(row.id)
        .map((r) => ({ ...r }));
    }
    return out;
  }

  getIssue(ref) {
    return this.issueOut(this.issueRow(ref), { full: true });
  }

  createIssue(input, actor) {
    const a = parseActor(actor);
    const project = this.getProject(input.project);
    const title = text(input.title, "title", { min: 1, max: 200, oneLine: true });
    const description = text(input.description, "description", { max: 20000 });
    const status = input.status ?? "backlog";
    if (!["backlog", "todo"].includes(status)) throw bad("a new issue starts in backlog or todo");
    const priority = priorityOf(input.priority);
    const estimate = estimateOf(input.estimate);
    const labels = labelsOf(input.labels);
    const doneWhen = text(input.done_when, "done_when", { max: 300, oneLine: true });
    const sourceUrl = input.source_url ? httpUrl(input.source_url, "source_url") : null;
    return tx(this.db, () => {
      const parentId = input.parent ? this.sameProject(input.parent, project.id, "parent").id : null;
      const cycleId = input.cycle_id != null ? this.cycleRow(input.cycle_id, project.id).id : null;
      const assignee = input.assignee ? parseActor(input.assignee) : null;
      const p = this.db.prepare("SELECT next_number FROM projects WHERE id = ?").get(project.id);
      this.db.prepare("UPDATE projects SET next_number = next_number + 1 WHERE id = ?").run(project.id);
      const now = this.now();
      const r = this.db
        .prepare(
          `INSERT INTO issues (project_id, number, title, description, status, priority, estimate, assignee,
             assignee_kind, parent_id, cycle_id, done_when, source_url, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id, p.next_number, title, description, status, priority, estimate,
          assignee?.actor ?? null, assignee?.kind ?? null, parentId, cycleId, doneWhen, sourceUrl,
          a.actor, now, now,
        );
      const id = Number(r.lastInsertRowid);
      for (const l of labels) this.db.prepare("INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)").run(id, l);
      const row = this.issueRow(id);
      this.log(project.id, id, a.actor, "issue_created", { key: this.keyOf(row), title });
      return this.issueOut(row);
    });
  }

  sameProject(ref, projectId, field) {
    const row = this.issueRow(ref);
    if (row.project_id !== projectId) throw bad(`${field} must be in the same project`);
    return row;
  }

  /**
   * Changes fields of an issue. Status may move between backlog, todo and
   * in_progress here; review and done go through submitForReview / review.
   */
  updateIssue(ref, patch, actor) {
    const a = parseActor(actor);
    return tx(this.db, () => {
      const row = this.issueRow(ref);
      const set = {};
      if (patch.title !== undefined) set.title = text(patch.title, "title", { min: 1, max: 200, oneLine: true });
      if (patch.description !== undefined) set.description = text(patch.description, "description", { max: 20000 });
      if (patch.priority !== undefined) set.priority = priorityOf(patch.priority);
      if (patch.estimate !== undefined) set.estimate = estimateOf(patch.estimate);
      if (patch.done_when !== undefined)
        set.done_when = text(patch.done_when, "done_when", { max: 300, oneLine: true });
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
        if (patch.status === "review") throw bad("submit for review with submit_for_review (an evidence link is needed)");
        if (patch.status === "done") throw bad("an issue is done when a reviewer accepts it");
        if (row.status === "review") throw conflict("the issue is in review: a reviewer accepts it or sends it back");
        if (row.status === "done" && patch.status !== "done") set.done_at = null;
        set.status = patch.status;
      }
      if (patch.assignee !== undefined) {
        if (patch.assignee === null || patch.assignee === "") {
          set.assignee = null;
          set.assignee_kind = null;
        } else {
          const as = parseActor(patch.assignee);
          set.assignee = as.actor;
          set.assignee_kind = as.kind;
        }
      }
      if (patch.parent !== undefined) {
        if (!patch.parent) set.parent_id = null;
        else {
          const parent = this.sameProject(patch.parent, row.project_id, "parent");
          for (let p = parent; p; p = p.parent_id ? this.issueRow(p.parent_id) : null)
            if (p.id === row.id) throw bad("parent would make a loop");
          set.parent_id = parent.id;
        }
      }
      if (patch.cycle_id !== undefined)
        set.cycle_id = patch.cycle_id === null ? null : this.cycleRow(patch.cycle_id, row.project_id).id;
      const changed = Object.keys(set).filter((k) => set[k] !== row[k]);
      if (changed.length) {
        set.updated_at = this.now();
        const cols = [...changed, "updated_at"];
        this.db
          .prepare(`UPDATE issues SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
          .run(...cols.map((c) => set[c]), row.id);
        this.log(row.project_id, row.id, a.actor, "issue_updated", {
          changes: Object.fromEntries(changed.map((c) => [c, { from: row[c], to: set[c] }])),
        });
      }
      if (patch.labels !== undefined) {
        const labels = labelsOf(patch.labels);
        const before = this.issueOut(row).labels;
        if (before.join() !== [...labels].sort().join()) {
          this.db.prepare("DELETE FROM issue_labels WHERE issue_id = ?").run(row.id);
          for (const l of labels)
            this.db.prepare("INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)").run(row.id, l);
          this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(this.now(), row.id);
          this.log(row.project_id, row.id, a.actor, "labels_changed", { from: before, to: labels });
        }
      }
      return this.getIssue(row.id);
    });
  }

  addLink(ref, { kind, target, url }, actor) {
    const a = parseActor(actor);
    if (!LINK_KINDS.includes(kind)) throw bad(`link kind must be one of ${LINK_KINDS.join(", ")}`);
    return tx(this.db, () => {
      const row = this.issueRow(ref);
      let targetId = null;
      let u = null;
      if (kind === "url") u = httpUrl(url, "url");
      else {
        const t = this.issueRow(target);
        if (t.id === row.id) throw bad("an issue cannot link to itself");
        targetId = t.id;
      }
      this.db
        .prepare("INSERT INTO issue_links (issue_id, kind, target_id, url, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.id, kind, targetId, u, this.now());
      this.log(row.project_id, row.id, a.actor, "link_added", { kind, target: targetId ? this.keyOf(this.issueRow(targetId)) : u });
      return this.getIssue(row.id);
    });
  }

  /**
   * Lists issues. filter: project, status (one or a list), assignee, label,
   * cycle_id, q (words matched in title and description), limit (1-200).
   */
  listIssues(filter = {}) {
    const where = [];
    const args = [];
    if (filter.project) {
      where.push("i.project_id = ?");
      args.push(this.getProject(filter.project).id);
    }
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : String(filter.status).split(",");
      for (const s of list) if (!STATUSES.includes(s)) throw bad(`status must be one of ${STATUSES.join(", ")}`);
      where.push(`i.status IN (${list.map(() => "?").join(",")})`);
      args.push(...list);
    }
    if (filter.assignee !== undefined) {
      if (filter.assignee === null || filter.assignee === "none") where.push("i.assignee IS NULL");
      else {
        where.push("i.assignee = ?");
        args.push(parseActor(filter.assignee).actor);
      }
    }
    if (filter.label) {
      where.push("EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = i.id AND l.label = ?)");
      args.push(normLabel(filter.label));
    }
    if (filter.cycle_id != null) {
      where.push("i.cycle_id = ?");
      args.push(Number(filter.cycle_id));
    }
    if (filter.q) {
      const words = String(filter.q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      for (const w of words) {
        where.push("(instr(lower(i.title), ?) > 0 OR instr(lower(i.description), ?) > 0)");
        args.push(w, w);
      }
    }
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT i.* FROM issues i ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY CASE i.priority WHEN 0 THEN 5 ELSE i.priority END, i.updated_at DESC, i.id DESC LIMIT ?`,
      )
      .all(...args, limit);
    return rows.map((r) => this.issueOut(r));
  }

  // ---------- comments and progress ----------

  comment(ref, body, actor, kind = "comment") {
    const a = parseActor(actor);
    const b = text(body, "body", { min: 1, max: 10000 });
    return tx(this.db, () => {
      const row = this.issueRow(ref);
      const r = this.db
        .prepare("INSERT INTO comments (issue_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.id, a.actor, kind, b, this.now());
      this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(this.now(), row.id);
      this.log(row.project_id, row.id, a.actor, kind === "progress" ? "progress" : "commented", { comment: Number(r.lastInsertRowid) });
      return { id: Number(r.lastInsertRowid), issue: this.keyOf(row), author: a.actor, kind, body: b };
    });
  }

  /** A progress note by the assignee on work in progress. */
  postProgress(ref, body, actor) {
    const a = parseActor(actor);
    const row = this.issueRow(ref);
    if (row.assignee !== a.actor) throw forbidden(`only the assignee (${row.assignee ?? "nobody"}) posts progress`);
    if (row.status !== "in_progress") throw conflict(`progress is for issues in progress (this one is ${row.status})`);
    return this.comment(ref, body, actor, "progress");
  }

  // ---------- agent workflow ----------

  /**
   * Claims the most urgent unassigned todo issue whose labels share one with
   * skills (any todo issue when skills is empty). Blocked issues are skipped.
   * Returns null when nothing matches.
   */
  claimNext({ project, skills = [] } = {}, actor) {
    const a = parseActor(actor);
    const wanted = labelsOf(skills);
    return tx(this.db, () => {
      const args = [];
      let where = "i.status = 'todo' AND i.assignee IS NULL";
      if (project) {
        where += " AND i.project_id = ?";
        args.push(this.getProject(project).id);
      }
      if (wanted.length) {
        where += ` AND EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue_id = i.id AND l.label IN (${wanted.map(() => "?").join(",")}))`;
        args.push(...wanted);
      }
      where += ` AND NOT EXISTS (SELECT 1 FROM issue_links k JOIN issues b ON b.id = k.issue_id
                 WHERE k.kind = 'blocks' AND k.target_id = i.id AND b.status <> 'done')`;
      const row = this.db
        .prepare(
          `SELECT i.* FROM issues i WHERE ${where}
           ORDER BY CASE i.priority WHEN 0 THEN 5 ELSE i.priority END, i.created_at, i.id LIMIT 1`,
        )
        .get(...args);
      if (!row) return null;
      const now = this.now();
      const r = this.db
        .prepare(
          "UPDATE issues SET assignee = ?, assignee_kind = ?, status = 'in_progress', updated_at = ? WHERE id = ? AND assignee IS NULL AND status = 'todo'",
        )
        .run(a.actor, a.kind, now, row.id);
      if (r.changes !== 1) throw conflict("claimed by someone else: try again");
      this.log(row.project_id, row.id, a.actor, "claimed", { skills: wanted });
      return this.getIssue(row.id);
    });
  }

  /** Claims one named issue (todo or backlog, unassigned or already yours). */
  claim(ref, actor) {
    const a = parseActor(actor);
    return tx(this.db, () => {
      const row = this.issueRow(ref);
      if (row.assignee && row.assignee !== a.actor) throw conflict(`assigned to ${row.assignee}`);
      if (!["backlog", "todo", "in_progress"].includes(row.status)) throw conflict(`the issue is ${row.status}`);
      this.db
        .prepare("UPDATE issues SET assignee = ?, assignee_kind = ?, status = 'in_progress', updated_at = ? WHERE id = ?")
        .run(a.actor, a.kind, this.now(), row.id);
      this.log(row.project_id, row.id, a.actor, "claimed", {});
      return this.getIssue(row.id);
    });
  }

  /** The assignee hands in work: evidence_url is what a reviewer checks against done_when. */
  submitForReview(ref, { evidence_url, note = "" }, actor) {
    const a = parseActor(actor);
    const url = httpUrl(evidence_url, "evidence_url");
    const n = text(note, "note", { max: 2000 });
    return tx(this.db, () => {
      const row = this.issueRow(ref);
      if (row.assignee !== a.actor) throw forbidden(`only the assignee (${row.assignee ?? "nobody"}) submits`);
      if (row.status !== "in_progress") throw conflict(`only issues in progress are submitted (this one is ${row.status})`);
      if (!row.done_when) throw conflict("set done_when first: the line a reviewer checks the evidence against");
      const now = this.now();
      this.db
        .prepare("INSERT INTO reviews (issue_id, submitted_by, evidence_url, note, submitted_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.id, a.actor, url, n, now);
      this.db.prepare("UPDATE issues SET status = 'review', updated_at = ? WHERE id = ?").run(now, row.id);
      this.log(row.project_id, row.id, a.actor, "submitted", { evidence_url: url });
      return this.getIssue(row.id);
    });
  }

  /** A reviewer (agent or human, never the assignee) accepts or sends back with a reason. */
  review(ref, { decision, reason = "" }, actor) {
    const a = parseActor(actor);
    if (!["accepted", "rejected", "accept", "reject"].includes(decision)) throw bad("decision must be accept or reject");
    const accepted = decision.startsWith("accept");
    const why = text(reason, "reason", { min: accepted ? 0 : 1, max: 2000 });
    return tx(this.db, () => {
      const row = this.issueRow(ref);
      if (row.status !== "review") throw conflict(`the issue is not in review (it is ${row.status})`);
      if (row.assignee === a.actor) throw forbidden("the assignee cannot review their own work");
      const open = this.db
        .prepare("SELECT * FROM reviews WHERE issue_id = ? AND decision IS NULL ORDER BY id DESC LIMIT 1")
        .get(row.id);
      const now = this.now();
      this.db
        .prepare("UPDATE reviews SET reviewer = ?, decision = ?, reason = ?, decided_at = ? WHERE id = ?")
        .run(a.actor, accepted ? "accepted" : "rejected", why, now, open.id);
      if (accepted)
        this.db.prepare("UPDATE issues SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
      else this.db.prepare("UPDATE issues SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, row.id);
      this.log(row.project_id, row.id, a.actor, accepted ? "accepted" : "rejected", {
        reason: why,
        evidence_url: open.evidence_url,
      });
      return this.getIssue(row.id);
    });
  }

  // ---------- cycles ----------

  createCycle({ project, name, starts_at, ends_at }, actor) {
    const a = parseActor(actor);
    const p = this.getProject(project);
    const n = text(name, "name", { min: 1, max: 80, oneLine: true });
    const s = timeOf(starts_at, "starts_at");
    const e = timeOf(ends_at, "ends_at");
    if (e <= s) throw bad("ends_at must be after starts_at");
    if (e - s > 90 * DAY) throw bad("a cycle is 90 days at most");
    return tx(this.db, () => {
      const r = this.db
        .prepare("INSERT INTO cycles (project_id, name, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(p.id, n, s, e, this.now());
      this.log(p.id, null, a.actor, "cycle_created", { cycle: Number(r.lastInsertRowid), name: n });
      return this.cycleSummary(Number(r.lastInsertRowid));
    });
  }

  cycleRow(id, projectId) {
    const row = this.db.prepare("SELECT * FROM cycles WHERE id = ?").get(Number(id));
    if (!row) throw notFound(`no such cycle: ${id}`);
    if (projectId !== undefined && row.project_id !== projectId) throw bad("the cycle belongs to another project");
    return row;
  }

  listCycles(project) {
    const p = this.getProject(project);
    return this.db
      .prepare("SELECT id FROM cycles WHERE project_id = ? ORDER BY starts_at DESC")
      .all(p.id)
      .map((r) => this.cycleSummary(r.id, { burndown: false }));
  }

  /**
   * Counts and a daily burndown: for each day from the start to the end (or
   * today), the issues and estimate points not done by the end of that day.
   * Issues are counted by their current cycle.
   */
  cycleSummary(id, { burndown = true } = {}) {
    const c = this.cycleRow(id);
    const issues = this.db.prepare("SELECT * FROM issues WHERE cycle_id = ?").all(c.id);
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let points = 0;
    let pointsDone = 0;
    for (const i of issues) {
      by[i.status]++;
      points += i.estimate ?? 0;
      if (i.status === "done") pointsDone += i.estimate ?? 0;
    }
    const now = this.now();
    const out = {
      id: c.id,
      project: this.db.prepare("SELECT key FROM projects WHERE id = ?").get(c.project_id).key,
      name: c.name,
      starts_at: c.starts_at,
      ends_at: c.ends_at,
      state: now < c.starts_at ? "upcoming" : now >= c.ends_at ? "ended" : "active",
      total: issues.length,
      by_status: by,
      points,
      points_done: pointsDone,
    };
    if (burndown) {
      out.burndown = [];
      const last = Math.min(c.ends_at, Math.max(now, c.starts_at));
      for (let day = c.starts_at; day < last || day === c.starts_at; day += DAY) {
        const end = Math.min(day + DAY, c.ends_at);
        const open = issues.filter((i) => !(i.done_at && i.done_at < end));
        out.burndown.push({
          day: new Date(day).toISOString().slice(0, 10),
          remaining: open.length,
          remaining_points: open.reduce((s, i) => s + (i.estimate ?? 0), 0),
        });
        if (out.burndown.length >= 91) break;
      }
    }
    return out;
  }

  // ---------- activity ----------

  activity({ project, issue, limit = 50 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    let rows;
    if (issue) rows = this.db.prepare("SELECT * FROM activity WHERE issue_id = ? ORDER BY id DESC LIMIT ?").all(this.issueRow(issue).id, lim);
    else if (project) rows = this.db.prepare("SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(this.getProject(project).id, lim);
    else rows = this.db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(lim);
    return rows.map((r) => ({
      id: r.id,
      issue: r.issue_id ? this.keyOf(this.issueRow(r.issue_id)) : null,
      actor: r.actor,
      kind: r.kind,
      data: JSON.parse(r.data),
      at: r.created_at,
    }));
  }
}
