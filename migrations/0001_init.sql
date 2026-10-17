-- Crewrail schema v1. Times are unix milliseconds.

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,          -- short code used in issue keys, e.g. CREW
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE cycles (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE issues (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'backlog'
                CHECK (status IN ('backlog','todo','in_progress','review','done')),
  priority      INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4), -- 0 none, 1 urgent .. 4 low
  estimate      INTEGER CHECK (estimate IS NULL OR estimate >= 0),
  assignee      TEXT,
  assignee_kind TEXT CHECK (assignee_kind IS NULL OR assignee_kind IN ('agent','human')),
  parent_id     INTEGER REFERENCES issues(id),
  cycle_id      INTEGER REFERENCES cycles(id),
  done_when     TEXT NOT NULL DEFAULT '',
  source_url    TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  done_at       INTEGER,
  UNIQUE (project_id, number)
);
CREATE INDEX issues_status ON issues (project_id, status);
CREATE INDEX issues_assignee ON issues (assignee);
CREATE INDEX issues_cycle ON issues (cycle_id);
CREATE UNIQUE INDEX issues_source ON issues (project_id, source_url) WHERE source_url IS NOT NULL;

CREATE TABLE issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  PRIMARY KEY (issue_id, label)
);
CREATE INDEX issue_labels_label ON issue_labels (label);

CREATE TABLE issue_links (
  id        INTEGER PRIMARY KEY,
  issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('blocks','relates','duplicates','url')),
  target_id INTEGER REFERENCES issues(id),
  url       TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'url' AND url IS NOT NULL AND target_id IS NULL) OR (kind <> 'url' AND target_id IS NOT NULL AND url IS NULL))
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','progress')),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_issue ON comments (issue_id, id);

CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  submitted_by TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  submitted_at INTEGER NOT NULL,
  reviewer    TEXT,
  decision    TEXT CHECK (decision IS NULL OR decision IN ('accepted','rejected')),
  reason      TEXT,
  decided_at  INTEGER
);
CREATE INDEX reviews_issue ON reviews (issue_id, id);

CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  issue_id   INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX activity_project ON activity (project_id, id);
CREATE INDEX activity_issue ON activity (issue_id, id);
