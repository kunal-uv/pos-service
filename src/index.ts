import { Prisma } from "@prisma/client";
import { createApp } from "./app.js";
import { releaseStaleCarts } from "./cart-service.js";
import { config } from "./config.js";
import { POS_SCHEMA } from "./database-url.js";
import { prisma } from "./db.js";

/** Host, database and schema only - never the credentials in DATABASE_URL. */
const describeDatabase = () => {
	try {
		const url = new URL(config.DATABASE_URL);
		return `${url.host}${url.pathname} (schema ${url.searchParams.get("schema") ?? POS_SCHEMA})`;
	} catch {
		return "the configured database";
	}
};

const server = createApp().listen(config.PORT, () => {
	console.log(`Shared POS listening on ${config.PORT}`);
});

const sweep = async () => {
	try {
		const released = await releaseStaleCarts();
		if (released) console.log(`Released ${released} abandoned POS cart(s)`);
	} catch (error) {
		// The sweep is the first thing to touch the database, so an unprovisioned
		// one surfaces here. That is a setup step, not a fault worth a stack
		// trace: say which command fixes it.
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
			console.error(
				`The POS tables do not exist in ${describeDatabase()}. Run \`yarn db:migrate\` (or \`yarn db:push\`) before starting the service.`,
			);
			return;
		}
		// Any other failed sweep must not take the till down with it; the next one
		// runs in five minutes and the units stay reserved until it succeeds.
		console.error("Failed to release abandoned POS carts", error);
	}
};

void sweep();
const sweeper = setInterval(sweep, 5 * 60 * 1000);
sweeper.unref();

const shutdown = async () => {
	clearInterval(sweeper);
	server.close();
	await prisma.$disconnect();
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
