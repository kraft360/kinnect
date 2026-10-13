// Directory database (requirements 7.4 and 8.2). A single instance for the whole
// deployment; holds only what doesn't belong to one Organization.
//
// Version 1 is already deployed: never change an existing migration, add a new one.

export const directoryMigrations: readonly string[] = [
	/* 1 */ `
	CREATE TABLE join_code (
		code_hash TEXT PRIMARY KEY,
		org_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL,
		failed_attempts INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX join_code_by_expiry ON join_code (expires_at);

	CREATE TABLE org_creation (
		link_id TEXT PRIMARY KEY,
		used_at INTEGER NOT NULL,
		org_id TEXT NOT NULL
	);

	CREATE TABLE rate_limit (
		key TEXT NOT NULL,
		window_start INTEGER NOT NULL,
		count INTEGER NOT NULL,
		PRIMARY KEY (key, window_start)
	);
	`,

	/* 2 */ `
	-- Wrong guesses can't be attributed to a code, so per-code counts are not kept.
	ALTER TABLE join_code DROP COLUMN failed_attempts;

	-- Single-use operator links: "create organization" and "recover".
	DROP TABLE org_creation;
	CREATE TABLE operator_link (
		link_id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		org_id TEXT NOT NULL,
		used_at INTEGER NOT NULL
	);
	`,
];
