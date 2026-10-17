// Crewrail read-only web board
// Zero-build single HTML page rendering project status columns and cycle burndown

import { STATUSES } from "./store.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderBoardHtml(store, projectKey) {
  const projects = store.listProjects();
  let currentProject = null;
  let issues = [];
  let cycles = [];
  let cycle = null;
  let error = null;

  if (projectKey) {
    try {
      currentProject = store.getProject(projectKey);
      issues = store.listIssues({ project: currentProject.key });
      cycles = store.listCycles(currentProject.key);
      if (cycles.length > 0) {
        cycle = store.cycleSummary(cycles[0].id);
      }
    } catch (e) {
      error = e.message;
    }
  } else if (projects.length > 0) {
    currentProject = projects[0];
    issues = store.listIssues({ project: currentProject.key });
    cycles = store.listCycles(currentProject.key);
    if (cycles.length > 0) {
      cycle = store.cycleSummary(cycles[0].id);
    }
  }

  const columns = STATUSES.map((status) => {
    const list = issues.filter((i) => i.status === status);
    const count = currentProject ? (currentProject.counts[status] ?? list.length) : list.length;
    return { status, count, list };
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crewrail Board - ${escapeHtml(currentProject?.key || "Projects")}</title>
  <style>
    :root {
      --bg: #0f141c;
      --card-bg: #1a2230;
      --border: #2d3848;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 12px; }
    .project-nav { display: flex; gap: 8px; }
    .project-nav a { color: var(--text-muted); text-decoration: none; padding: 4px 10px; border-radius: 6px; font-size: 13px; border: 1px solid var(--border); }
    .project-nav a.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    
    .board-container { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin-bottom: 32px; overflow-x: auto; }
    .status-column { background: #131b26; border-radius: 8px; border: 1px solid var(--border); padding: 12px; min-width: 200px; }
    .column-header { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    .column-count { background: var(--border); color: var(--text); padding: 2px 8px; border-radius: 12px; font-size: 11px; }
    
    .issue-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
    .issue-key { font-size: 11px; color: var(--text-muted); font-weight: 600; }
    .issue-title { font-size: 13px; margin: 4px 0 6px 0; color: var(--text); }
    .issue-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); }

    .burndown-section { background: #131b26; border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
    .burndown-header { margin-bottom: 16px; }
    .burndown-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .burndown-stats { font-size: 13px; color: var(--text-muted); }
    table.burndown-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
    table.burndown-table th, table.burndown-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    table.burndown-table th { color: var(--text-muted); }
  </style>
</head>
<body>
  <header>
    <h1>
      <span>Crewrail Board</span>
      ${currentProject ? `<span style="color:var(--text-muted)">/ ${escapeHtml(currentProject.name)} (${escapeHtml(currentProject.key)})</span>` : ""}
    </h1>
    <nav class="project-nav">
      ${projects.map((p) => `<a href="/?project=${escapeHtml(p.key)}" class="${currentProject && currentProject.key === p.key ? "active" : ""}">${escapeHtml(p.key)}</a>`).join("")}
    </nav>
  </header>

  ${error ? `<div style="color:#ef4444;margin-bottom:20px;">Error: ${escapeHtml(error)}</div>` : ""}

  <main>
    <div class="board-container">
      ${columns.map((col) => `
        <div class="status-column" data-status="${escapeHtml(col.status)}">
          <div class="column-header">
            <span>${escapeHtml(col.status.replace("_", " "))}</span>
            <span class="column-count">${col.count}</span>
          </div>
          <div class="column-issues">
            ${col.list.map((i) => `
              <div class="issue-card" data-key="${escapeHtml(i.key)}">
                <div class="issue-key">${escapeHtml(i.key)}</div>
                <div class="issue-title">${escapeHtml(i.title)}</div>
                <div class="issue-meta">
                  <span>${escapeHtml(i.priority || "normal")}</span>
                  <span>${escapeHtml(i.assignee || "unassigned")}</span>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("")}
    </div>

    ${cycle ? `
      <section class="burndown-section">
        <div class="burndown-header">
          <div class="burndown-title">Cycle Burndown: ${escapeHtml(cycle.name)} (${escapeHtml(cycle.state)})</div>
          <div class="burndown-stats">Points: ${cycle.points_done} / ${cycle.points} completed | Total Issues: ${cycle.total}</div>
        </div>
        ${cycle.burndown && cycle.burndown.length ? `
          <table class="burndown-table">
            <thead>
              <tr><th>Day</th><th>Remaining Issues</th><th>Remaining Points</th></tr>
            </thead>
            <tbody>
              ${cycle.burndown.map((b) => `<tr><td>${escapeHtml(b.day)}</td><td>${b.remaining}</td><td>${b.remaining_points}</td></tr>`).join("")}
            </tbody>
          </table>
        ` : ""}
      </section>
    ` : ""}
  </main>
</body>
</html>`;
}
