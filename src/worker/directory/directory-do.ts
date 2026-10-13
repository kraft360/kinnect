// Global lookups that don't belong to one Organization: join codes,
// operator links and join rate limits (requirements 7.4).
import { DurableObject } from "cloudflare:workers";
import { migrate } from "../db/migrate.ts";
import { fail, ok, type Result } from "../result.ts";
import { directoryMigrations } from "./schema.ts";

const HOUR_MS = 60 * 60 * 1000;
/** Join-code lookups allowed per hour (FR-79). A household joining from one Wi-Fi shares an IP. */
export const JOIN_LIMIT_PER_IP = 30;
export const JOIN_LIMIT_GLOBAL = 300;

export const DIRECTORY_NAME = "global";

export class DirectoryDO extends DurableObject<Env> {
	private schemaVersion = 0;
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.schemaVersion = migrate(ctx.storage, directoryMigrations);
		});
	}

	health(): number {
		return this.schemaVersion;
	}

	/** Records a single-use operator link as used. Returns false if it already was. */
	claimOperatorLink(linkId: string, kind: string, orgId: string, now = Date.now()): boolean {
		const inserted = this.sql
			.exec(
				"INSERT INTO operator_link (link_id, kind, org_id, used_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING link_id",
				linkId,
				kind,
				orgId,
				now,
			)
			.toArray();
		return inserted.length === 1;
	}

	/** Returns false if the code is already taken (the caller picks another). */
	registerJoinCode(codeHash: string, orgId: string, expiresAt: number, now = Date.now()): boolean {
		this.sql.exec("DELETE FROM join_code WHERE expires_at <= ?", now);
		const inserted = this.sql
			.exec(
				"INSERT INTO join_code (code_hash, org_id, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING code_hash",
				codeHash,
				orgId,
				expiresAt,
			)
			.toArray();
		return inserted.length === 1;
	}

	removeJoinCodes(codeHashes: string[]): void {
		for (const hash of codeHashes) this.sql.exec("DELETE FROM join_code WHERE code_hash = ?", hash);
	}

	/** Finds the Organization for a join code, counting the attempt against the rate limits. */
	lookupJoinCode(codeHash: string, ip: string, now = Date.now()): Result<{ orgId: string }> {
		if (
			!this.allow(`ip:${ip}`, JOIN_LIMIT_PER_IP, now) ||
			!this.allow("global", JOIN_LIMIT_GLOBAL, now)
		) {
			return fail(429, "Too many attempts. Please wait an hour and try again.");
		}
		const row = this.sql
			.exec<{ org_id: string }>(
				"SELECT org_id FROM join_code WHERE code_hash = ? AND expires_at > ?",
				codeHash,
				now,
			)
			.toArray()[0];
		return row ? ok({ orgId: row.org_id }) : fail(404, "That code isn't valid or has expired.");
	}

	/** Fixed one-hour windows. Counts this attempt and returns whether it's within the limit. */
	private allow(key: string, limit: number, now: number): boolean {
		const window = Math.floor(now / HOUR_MS) * HOUR_MS;
		this.sql.exec("DELETE FROM rate_limit WHERE window_start < ?", window);
		const { count } = this.sql
			.exec<{ count: number }>(
				`INSERT INTO rate_limit (key, window_start, count) VALUES (?, ?, 1)
				 ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
				 RETURNING count`,
				key,
				window,
			)
			.one();
		return count <= limit;
	}
}
