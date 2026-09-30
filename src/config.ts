import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { resolveDatabaseUrl, siblingEnv } from "./database-url.js";

loadDotEnv();

/**
 * Local multi-repository convenience. Production remains explicit and fails
 * closed, but a developer starting this sibling service should not have to
 * copy database credentials out of the Rent Buddy backend. The database half
 * lives in `database-url.ts` because the Prisma CLI needs it too.
 */
resolveDatabaseUrl();
if ((process.env.NODE_ENV ?? "development") !== "production") {
	const rentAdmin = siblingEnv("RentBuddyAdmin");
	process.env.RENT_BUDDY_API_URL ??=
		rentAdmin.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:65080/api";
	// Read from the AO admin the same way, rather than guessed. This was a
	// hardcoded :8000 while the AO API listens where `nca-crm/.env` says (8080),
	// so every Appliance Outlet call from the till went to a port that never
	// answered and surfaced as "Platform is unavailable".
	const aoAdmin = siblingEnv("nca-crm");
	process.env.AO_API_URL ??=
		aoAdmin.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:8080/api/v1";
}

const schema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().default(8100),
	DATABASE_URL: z.string().min(1),
	CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
	AO_API_URL: z.string().url(),
	RENT_BUDDY_API_URL: z.string().url(),
	REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
	/**
	 * Named plainly, one per line.
	 *
	 * ! This is the first thing a deployment sees when it is misconfigured, and
	 * ! the container dies before anything else can be logged - which reaches
	 * ! the operator as "502 Bad Gateway" and nothing else. A dump of Zod's
	 * ! issue objects buried the one fact that matters, which variable is
	 * ! missing, so it is spelled out here instead.
	 */
	const missing = parsed.error.issues
		.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("\n");
	throw new Error(
		[
			"Shared POS cannot start: its environment is incomplete.",
			missing,
			"DATABASE_URL must include ?schema=shared_pos. AO_API_URL and RENT_BUDDY_API_URL have no default outside development.",
		].join("\n"),
	);
}

export const config = {
	...parsed.data,
	corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
};
