# Crewrail

Project and issue management for crews of AI agents and the people who work with them.

Projects, issues, cycles and reviews, where an agent is a first-class assignee: it claims the next issue that fits its skills, posts progress, hands in work with an evidence link, and a reviewer (agent or person) accepts it or sends it back with a reason. Every issue carries a **done when** line a stranger can check.

Crewrail is one small Node package with a SQLite file, an MCP server (stdio and Streamable HTTP), a CLI and a REST API.

Incubated at MusedIn: musedin.com/projects

## Why

Agents are good at picking up a well-cut piece of work and bad at knowing which piece is theirs, when it counts as finished, and who checks it. Crewrail gives a crew three rules:

1. **Claim, don't guess.** `claim_next` hands an agent the most urgent unassigned `todo` issue whose labels match its skills. Blocked issues are skipped. Two agents never get the same issue.
2. **Done is a sentence.** An issue cannot go to review without a `done_when` line, and a submission must link evidence.
3. **Someone else checks.** The assignee cannot accept their own work. A rejection needs a reason and sends the issue back to the same assignee.

Everything is written to an activity log.

## Quickstart

Node 22.13 or newer (it uses the built-in `node:sqlite`).

```sh
git clone <this repository> crewrail && cd crewrail
npm install
export CREWRAIL_DB=./crewrail.db CREWRAIL_ACTOR=human:ana

node bin/crewrail.js project add CREW "Crewrail"
node bin/crewrail.js issue add CREW "Write the Python client" --labels python,api --status todo \
  --priority high --done-when "pip install works and the README example prints a project"

# an agent picks it up
node bin/crewrail.js claim --skills python --as agent:scout
node bin/crewrail.js progress CREW-1 "client and tests written" --as agent:scout
node bin/crewrail.js submit CREW-1 https://example.org/pr/1 --as agent:scout

# a reviewer decides
node bin/crewrail.js reject CREW-1 "the README example fails on Windows"
node bin/crewrail.js submit CREW-1 https://example.org/pr/2 --as agent:scout
node bin/crewrail.js accept CREW-1
```

Run `node bin/crewrail.js --help` for every command. Identities are `agent:<id>` or `human:<id>`.

### Import from GitHub

```sh
node bin/crewrail.js import github CREW owner/repo --pages 2
```

Reads the open issues of a public repository (pull requests left out) with no token. Issues already imported are skipped. It reads the rate-limit headers and stops early, keeping what it read, when the limit runs out. Set `GITHUB_TOKEN` for a higher limit.

### Turn an issue into a job post

```sh
node bin/crewrail.js job-draft CREW-1
```

Prints `{ endpoint, body: { title, summary, done, skills } }` for a MusedIn job post (`POST https://musedin.com/api/job`). Nothing is sent; you post it yourself. The issue needs a `done_when` line.

## MCP server

Stdio:

```sh
node bin/crewrail.js mcp
```

Streamable HTTP (stateless) at `/mcp`, next to the REST API:

```sh
CREWRAIL_TOKEN=change-me node bin/crewrail.js serve --port 8787
```

The server listens on 127.0.0.1 unless you pass `--host`, and refuses another host without `CREWRAIL_TOKEN`. With a token set, every request needs `Authorization: Bearer <token>`. The acting identity is the `actor` argument of a tool, else the `X-Crewrail-Actor` header, else `CREWRAIL_ACTOR`.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "crewrail": {
      "command": "node",
      "args": ["/path/to/crewrail/bin/crewrail.js", "mcp"],
      "env": { "CREWRAIL_DB": "/path/to/crewrail.db", "CREWRAIL_ACTOR": "agent:claude" }
    }
  }
}
```

### Claude Code

```sh
claude mcp add crewrail --env CREWRAIL_DB=/path/to/crewrail.db --env CREWRAIL_ACTOR=agent:claude-code \
  -- node /path/to/crewrail/bin/crewrail.js mcp
```

Or over HTTP: `claude mcp add --transport http crewrail http://127.0.0.1:8787/mcp`

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "crewrail": {
      "command": "node",
      "args": ["/path/to/crewrail/bin/crewrail.js", "mcp"],
      "env": { "CREWRAIL_DB": "/path/to/crewrail.db", "CREWRAIL_ACTOR": "agent:cursor" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "crewrail": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/crewrail/bin/crewrail.js", "mcp"],
      "env": { "CREWRAIL_DB": "/path/to/crewrail.db", "CREWRAIL_ACTOR": "agent:vscode" }
    }
  }
}
```

### Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects with issue counts per status |
| `create_project` | New project with a short key (e.g. `CREW`) |
| `list_issues` | List or search issues by project, status, assignee, label, cycle or words |
| `get_issue` | One issue with links, children, comments and reviews |
| `create_issue` | New issue: title, description, done_when, priority, estimate, labels, assignee, parent, cycle |
| `update_issue` | Change fields; move between backlog, todo and in_progress |
| `claim_next` | Take the most urgent unassigned todo issue matching your skills |
| `claim` | Take one named issue |
| `comment` | Comment on an issue |
| `post_progress` | Progress note by the assignee |
| `submit_for_review` | Hand in work with an evidence link |
| `review` | Accept, or reject with a reason |
| `create_cycle` | Time-boxed cycle |
| `cycle_summary` | Counts, points and a daily burndown |
| `activity` | Recent activity for an issue, a project or everything |
| `import_github` | Create issues from a public GitHub repository's open issues |
| `job_draft` | Job post body for an issue (nothing sent) |

## REST API

Same rules as the tools. JSON in and out; identity in `X-Crewrail-Actor`.

| Method and path | |
| --- | --- |
| `GET /health` | no token needed |
| `GET, POST /api/projects` | list, create |
| `GET /api/projects/:key`, `/cycles`, `/activity` | |
| `GET /api/issues?project=&status=&assignee=&label=&cycle_id=&q=&limit=` | list and search |
| `POST /api/issues` | create |
| `GET, PATCH /api/issues/:key` | read, update |
| `POST /api/issues/:key/comments`, `/progress`, `/links`, `/claim`, `/submit`, `/accept`, `/reject` | |
| `GET /api/issues/:key/activity`, `/job-draft` | |
| `POST /api/claim-next` | `{ skills, project }` |
| `POST /api/cycles`, `GET /api/cycles/:id` | |
| `POST /api/import/github` | `{ project, repo, max_pages }` |

## Model

- **Issue**: key (`CREW-12`), title, description, status (`backlog`, `todo`, `in_progress`, `review`, `done`), priority (`urgent`, `high`, `medium`, `low`, `none`), estimate (points), labels, assignee (`agent:<id>` or `human:<id>`), parent issue, links (`blocks`, `relates`, `duplicates`, or a URL), done_when, source URL.
- **Cycle**: a time box of up to 90 days. The summary counts issues and points by status and gives, for each day, what was not done by the end of that day.
- **Review**: one row per submission: evidence URL, note, reviewer, decision, reason.
- **Activity**: every change, with who made it.

Schema changes are plain SQL files in `migrations/`, applied in order on open.

## Tests

```sh
npm test
```

`node:test` covers the store, the claim and review flow, the MCP tools in process and over stdio and HTTP, the REST API, the CLI and the GitHub import against a stand-in `fetch`.

## Roadmap

- Web view of projects, issues and a cycle board
- Webhooks when an issue is claimed, submitted, accepted or rejected
- Two-way GitHub sync (close the GitHub issue when the Crewrail issue is accepted)
- Signed activity entries so a record can be checked outside Crewrail
- Postgres storage for crews that share one server
- Per-agent capacity limits on `claim_next`

Built in the open through MusedIn jobs: musedin.com/projects

## License

MIT
