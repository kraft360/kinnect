// Organization database (requirements 8.1). One per family, inside OrgDO.
//
// Migrations 1–4 are deployed: never change an existing migration, add a new one to the end.
//
// Times are INTEGER milliseconds since the Unix epoch (UTC). Booleans are 0/1.

export const orgMigrations: readonly string[] = [
	/* 1 */ `
	CREATE TABLE organization (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
		default_due_time TEXT NOT NULL DEFAULT '09:00',
		created_at INTEGER NOT NULL
	);

	CREATE TABLE member (
		id TEXT PRIMARY KEY,
		username TEXT NOT NULL UNIQUE COLLATE NOCASE,
		display_name TEXT NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
		simple_view INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		deactivated_at INTEGER
	);

	CREATE TABLE team (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE team_member (
		team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
		member_id TEXT NOT NULL REFERENCES member(id),
		added_by TEXT NOT NULL REFERENCES member(id),
		added_at INTEGER NOT NULL,
		PRIMARY KEY (team_id, member_id)
	);
	CREATE INDEX team_member_by_member ON team_member (member_id);

	CREATE TABLE device (
		id TEXT PRIMARY KEY,
		member_id TEXT NOT NULL REFERENCES member(id),
		name TEXT NOT NULL,
		session_token_hash TEXT NOT NULL UNIQUE,
		push_subscription TEXT,
		created_at INTEGER NOT NULL,
		last_seen INTEGER,
		last_ack_at INTEGER,
		unreachable_since INTEGER,
		revoked_at INTEGER
	);
	CREATE INDEX device_by_member ON device (member_id);

	CREATE TABLE invite (
		id TEXT PRIMARY KEY,
		member_id TEXT NOT NULL REFERENCES member(id),
		kind TEXT NOT NULL CHECK (kind IN ('invite', 'add_device')),
		token_hash TEXT NOT NULL UNIQUE,
		code_hash TEXT NOT NULL UNIQUE,
		created_by TEXT REFERENCES member(id),
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER,
		used_by_device TEXT REFERENCES device(id),
		revoked_at INTEGER
	);

	CREATE TABLE task (
		id TEXT PRIMARY KEY,
		team_id TEXT REFERENCES team(id),
		title TEXT NOT NULL,
		notes TEXT,
		label TEXT,
		colour TEXT,
		assignee_id TEXT REFERENCES member(id),
		due_date TEXT,
		due_time TEXT,
		repeat TEXT,
		remind_before_minutes INTEGER,
		second_reminder_minutes INTEGER,
		overdue_after_minutes INTEGER,
		done_at INTEGER,
		done_by TEXT REFERENCES member(id),
		archived INTEGER NOT NULL DEFAULT 0,
		created_by TEXT NOT NULL REFERENCES member(id),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX task_by_team ON task (team_id);
	CREATE INDEX task_by_assignee ON task (assignee_id);

	CREATE TABLE task_watcher (
		task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
		member_id TEXT NOT NULL REFERENCES member(id),
		PRIMARY KEY (task_id, member_id)
	);
	CREATE INDEX task_watcher_by_member ON task_watcher (member_id);

	CREATE TABLE subtask (
		id TEXT PRIMARY KEY,
		task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		note TEXT,
		position REAL NOT NULL,
		done_at INTEGER,
		done_by TEXT REFERENCES member(id),
		deleted_at INTEGER
	);
	CREATE INDEX subtask_by_task ON subtask (task_id, position);

	CREATE TABLE occurrence (
		id TEXT PRIMARY KEY,
		task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
		due_at INTEGER NOT NULL,
		status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'done_late', 'missed')),
		done_at INTEGER,
		done_by TEXT REFERENCES member(id),
		on_behalf INTEGER NOT NULL DEFAULT 0,
		note TEXT,
		UNIQUE (task_id, due_at)
	);
	CREATE INDEX occurrence_by_due ON occurrence (due_at);

	CREATE TABLE occurrence_tick (
		occurrence_id TEXT NOT NULL REFERENCES occurrence(id) ON DELETE CASCADE,
		subtask_id TEXT NOT NULL REFERENCES subtask(id),
		done_at INTEGER NOT NULL,
		done_by TEXT NOT NULL REFERENCES member(id),
		PRIMARY KEY (occurrence_id, subtask_id)
	);

	CREATE TABLE scheduled_job (
		id TEXT PRIMARY KEY,
		occurrence_id TEXT REFERENCES occurrence(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('advance', 'due', 'second', 'missed', 'resend', 'materialize')),
		fire_at INTEGER NOT NULL,
		done_at INTEGER
	);
	CREATE INDEX scheduled_job_pending ON scheduled_job (done_at, fire_at);

	CREATE TABLE alert (
		id TEXT PRIMARY KEY,
		occurrence_id TEXT NOT NULL REFERENCES occurrence(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		sent_at INTEGER,
		acked_at INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX alert_by_occurrence ON alert (occurrence_id);

	CREATE TABLE change_log (
		version INTEGER PRIMARY KEY AUTOINCREMENT,
		entity TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		op TEXT NOT NULL,
		member_id TEXT REFERENCES member(id),
		at INTEGER NOT NULL
	);
	CREATE INDEX change_log_by_time ON change_log (at);
	`,

	/* 2 */ `
	-- Households are soft-deleted so archived tasks keep their household (FR-85)
	-- and stay private to it instead of becoming family-wide.
	ALTER TABLE team ADD COLUMN deleted_at INTEGER;
	CREATE UNIQUE INDEX team_name_unique ON team (name COLLATE NOCASE) WHERE deleted_at IS NULL;
	`,

	/* 3 */ `
	-- Live sync (M4): each change carries the object's new state and its audience
	-- (team_id NULL = the whole family).
	ALTER TABLE change_log ADD COLUMN data TEXT;
	ALTER TABLE change_log ADD COLUMN team_id TEXT;
	-- Version of the last change to each task, so devices can tell which copy is newer.
	ALTER TABLE task ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
	`,

	/* 4 */ `
	-- Scheduling (M5). Who each alert went to, so "done late" notices reach the
	-- same people (FR-22), and when a missed alert was given up as undelivered (NFR-5).
	ALTER TABLE alert ADD COLUMN recipients TEXT;
	ALTER TABLE alert ADD COLUMN undelivered_at INTEGER;
	-- Pushes waiting to be sent; each alarm run sends at most 40 (7.3).
	CREATE TABLE push_queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		device_id TEXT NOT NULL,
		payload TEXT NOT NULL,
		ttl INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX scheduled_job_by_occurrence ON scheduled_job (occurrence_id);
	CREATE INDEX occurrence_by_task ON occurrence (task_id, due_at);
	`,

	/* 5 */ `
	-- Notification health (FR-42): when a push was first sent to the device without
	-- being shown since. Cleared when the device acknowledges a notification.
	ALTER TABLE device ADD COLUMN first_unacked_at INTEGER;
	`,

	/* 6 */ `
	-- The change_log version at which what the member can see last changed (role or
	-- households). A device that reconnects from an older version gets a full snapshot,
	-- since the log is filtered by current access and misses what they gained or lost (FR-83, FR-84).
	ALTER TABLE member ADD COLUMN audience_version INTEGER NOT NULL DEFAULT 0;
	`,

	/* 7 */ `
	-- Daily purge (8.3) runs as a "purge" job. SQLite can't change a CHECK constraint in place,
	-- so scheduled_job is rebuilt (copy, drop, rename) with 'purge' added. Nothing refers to it.
	CREATE TABLE scheduled_job_new (
		id TEXT PRIMARY KEY,
		occurrence_id TEXT REFERENCES occurrence(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('advance', 'due', 'second', 'missed', 'resend', 'materialize', 'purge')),
		fire_at INTEGER NOT NULL,
		done_at INTEGER
	);
	INSERT INTO scheduled_job_new (id, occurrence_id, kind, fire_at, done_at)
		SELECT id, occurrence_id, kind, fire_at, done_at FROM scheduled_job;
	DROP TABLE scheduled_job;
	ALTER TABLE scheduled_job_new RENAME TO scheduled_job;
	CREATE INDEX scheduled_job_pending ON scheduled_job (done_at, fire_at);
	CREATE INDEX scheduled_job_by_occurrence ON scheduled_job (occurrence_id);
	-- An existing family's first purge is due straight away (fire_at 0), on its next alarm.
	INSERT INTO scheduled_job (id, kind, fire_at)
		SELECT lower(hex(randomblob(16))), 'purge', 0 FROM organization;
	`,
];
