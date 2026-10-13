// Applies numbered schema migrations to a Durable Object's SQLite database.
// migrations[0] is version 1, migrations[1] is version 2, and so on.

export function migrate(storage: DurableObjectStorage, migrations: readonly string[]): number {
	const sql = storage.sql;
	sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
	const row = sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0];
	const current = row?.version ?? 0;
	if (current > migrations.length) {
		throw new Error(
			`Database is at schema version ${current}, newer than this code (${migrations.length})`,
		);
	}

	for (let version = current + 1; version <= migrations.length; version++) {
		// Each migration and its version bump commit together, or not at all.
		storage.transactionSync(() => {
			sql.exec(migrations[version - 1]);
			sql.exec("DELETE FROM schema_version");
			sql.exec("INSERT INTO schema_version (version) VALUES (?)", version);
		});
	}
	return migrations.length;
}
