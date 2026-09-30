import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";

/** POS tables live here, so they cannot collide with a platform's own tables. */
export const POS_SCHEMA = "shared_pos";

/** Resolved from this file, not `process.cwd()`: a Prisma CLI invoked from the
 *  workspace root must find the same sibling repository the service does. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readSiblingEnv = (path: string): Record<string, string> => {
	if (!existsSync(path)) return {};
	return parseDotEnv(readFileSync(path));
};

export const siblingEnv = (repository: string): Record<string, string> =>
	readSiblingEnv(resolve(packageRoot, "..", repository, ".env"));

/**
 * Local multi-repository convenience. Production remains explicit and fails
 * closed, but a developer starting this sibling service should not have to copy
 * database credentials out of the Rent Buddy backend.
 *
 * This lives apart from `config.ts` because the Prisma CLI never loads the
 * service's config: `yarn db:push` shells out to `prisma`, which reads only
 * `.env` and the real environment. Without a shared resolver the service starts
 * against a database whose tables the CLI could never be pointed at to create -
 * which is exactly how `shared_pos.Cart does not exist` happens. It also stays
 * free of the rest of the config schema, so a migration does not need the
 * platform API URLs set to run.
 *
 * Applies the result to `process.env` and returns it.
 */
export const resolveDatabaseUrl = (): string | undefined => {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	if ((process.env.NODE_ENV ?? "development") === "production") return undefined;

	const rentBackend = siblingEnv("rent-buddyz-backend");
	if (!rentBackend.DATABASE_URL) return undefined;

	const database = new URL(rentBackend.DATABASE_URL.trim());
	database.searchParams.set("schema", POS_SCHEMA);
	process.env.DATABASE_URL = database.toString();
	return process.env.DATABASE_URL;
};
