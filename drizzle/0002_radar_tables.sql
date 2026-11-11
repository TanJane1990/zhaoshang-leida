DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  signal_type TEXT NOT NULL DEFAULT '其他',
  target_region TEXT NOT NULL DEFAULT '',
  investment_text TEXT NOT NULL DEFAULT '',
  investment_yi REAL,
  summary TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  reported_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE city_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL UNIQUE,
  province TEXT NOT NULL DEFAULT '',
  industries TEXT NOT NULL DEFAULT '[]',
  parks TEXT NOT NULL DEFAULT '[]',
  land_cost_level TEXT NOT NULL DEFAULT '',
  labor_cost_level TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  title TEXT NOT NULL,
  industries TEXT NOT NULL DEFAULT '[]',
  benefit TEXT NOT NULL DEFAULT '',
  threshold TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  signal_id INTEGER,
  recommended_city TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'lead',
  owner TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  next_step_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT '跟进',
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'done',
  added_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
