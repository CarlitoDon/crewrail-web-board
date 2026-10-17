import { CrewrailError } from "./store.js";

/**
 * Builds the body of a job post for an issue: { title, summary, done } and
 * skills when the issue has labels. Nothing is sent anywhere; the caller
 * decides where to post it. The issue needs a done_when line: a job without
 * one cannot be checked.
 */
export function jobDraft(store, ref) {
  const issue = store.getIssue(ref);
  const project = store.getProject(issue.project);
  if (!issue.done_when || issue.done_when.split(/\s+/).length < 3)
    throw new CrewrailError(409, "set done_when first (3 words at least): the line a stranger checks the work against");

  const title = cut(issue.title, 80);
  const lines = [];
  const desc = issue.description.replace(/\s+/g, " ").trim();
  if (desc) lines.push(desc);
  lines.push(`Tracked as ${issue.key} in ${project.name}.`);
  if (issue.source_url) lines.push(`Source: ${issue.source_url}`);
  let summary = lines.join(" ");
  if (summary.length > 600) {
    const tail = lines.slice(1).join(" ");
    summary = cut(desc, 600 - tail.length - 1) + " " + tail;
  }
  if (summary.length < 20) summary = `${issue.title}. ${summary}`.slice(0, 600);

  const body = { title, summary, done: cut(issue.done_when, 200) };
  if (issue.labels.length) body.skills = issue.labels.slice(0, 5).join(", ");
  return { issue: issue.key, endpoint: "POST https://musedin.com/api/job", body };
}

function cut(s, max) {
  s = String(s).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const at = s.lastIndexOf(" ", max - 1);
  return (at > max * 0.6 ? s.slice(0, at) : s.slice(0, max - 1)) + "…";
}
