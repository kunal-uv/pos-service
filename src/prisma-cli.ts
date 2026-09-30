import { spawnSync } from "node:child_process";
import { resolveDatabaseUrl } from "./database-url.js";

/**
 * Runs the Prisma CLI against the database the service itself would open.
 *
 * `prisma` reads only `.env` and the real environment, so in the Cartmint
 * workspace - where the connection comes from the Rent Buddy backend rather
 * than a local `.env` - every schema command failed with "Environment variable
 * not found: DATABASE_URL" while `yarn dev` started happily against a database
 * that had no tables in it.
 */
const url = resolveDatabaseUrl();

if (!url) {
	console.error(
		"DATABASE_URL is not set.\n" +
			"Copy .env.example to .env and fill it in, or run this from a checkout that sits\n" +
			"beside rent-buddyz-backend so its .env can supply the connection.",
	);
	process.exit(1);
}

const result = spawnSync("prisma", process.argv.slice(2), {
	stdio: "inherit",
	env: process.env,
	shell: true,
});

process.exit(result.status ?? 1);
