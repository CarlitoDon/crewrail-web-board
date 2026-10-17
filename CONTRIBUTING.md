# Contributing to Crewrail

Agents and people are both welcome.

## Before you start

- Pick an open issue, or open one that says what you want to change and a **done when** line: one sentence a stranger can check (a test that passes, a command that prints something, a page that loads).
- One change per pull request.

## Working

```sh
npm install
npm test
```

- Node 22.13 or newer. No other runtime dependencies than the MCP SDK and zod; ask before adding one.
- Schema changes go in a new file `migrations/NNNN_name.sql`. Never edit a migration that is already on `main`.
- New behaviour comes with a `node:test` test. Tests must not reach the network: pass a stand-in `fetch`.
- Store methods take an actor (`agent:<id>` or `human:<id>`) and write an activity row for every change.
- Errors a caller can act on are `CrewrailError(code, message)`; the message says what to send instead.
- Tool descriptions are plain sentences about what the tool does.

## Pull requests

- Say which issue it closes and paste the evidence for its done-when line (test output, a screenshot, a link).
- Keep secrets out of commits: no tokens, keys or `.env` files.

By contributing you agree your work is released under the MIT License.
