import cors from "cors";
import express from "express";
import helmet from "helmet";
import { authenticate, correlation } from "./auth.js";
import { config } from "./config.js";
import { ApiError, errorHandler, notFound } from "./errors.js";
import { cartsRouter } from "./routes/carts.js";
import { catalogRouter } from "./routes/catalog.js";
import { customersRouter } from "./routes/customers.js";
import { sessionRouter } from "./routes/session.js";

/**
 * A till is not always reached on the origin somebody wrote into `CORS_ORIGINS`.
 * `http://127.0.0.1:3000` is a different origin from `http://localhost:3000`
 * though it is the same server, and a tablet on the shop floor reaches the
 * admin on a LAN address. A refusal is invisible from the browser - no status
 * code, no response, just a failed row in the network tab - so outside
 * production every loopback and private-network origin is allowed rather than
 * left as a blank row nobody can diagnose. Production stays on the allowlist.
 */
const isLocalDevelopmentOrigin = (origin: string) => {
	if (config.NODE_ENV === "production") return false;
	try {
		const { hostname } = new URL(origin);
		return (
			hostname === "localhost" ||
			hostname === "[::1]" ||
			hostname === "::1" ||
			hostname.endsWith(".localhost") ||
			/^127\./.test(hostname) ||
			/^10\./.test(hostname) ||
			/^192\.168\./.test(hostname) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
		);
	} catch {
		return false;
	}
};

export const createApp = () => {
	const app = express();
	app.disable("x-powered-by");
	app.use(helmet());
	app.use(cors({
		origin(origin, callback) {
			if (!origin || config.corsOrigins.includes(origin) || isLocalDevelopmentOrigin(origin)) {
				return callback(null, true);
			}
			// The browser cannot show why, so the server has to say it.
			console.warn(
				`Refused a POS request from origin ${origin}. Add it to CORS_ORIGINS (currently ${config.corsOrigins.join(", ") || "empty"}).`,
			);
			return callback(new ApiError(`Origin ${origin} is not allowed`, 403, "ORIGIN_NOT_ALLOWED"));
		},
		allowedHeaders: ["authorization", "content-type", "x-pos-tenant", "x-pos-store", "x-correlation-id", "idempotency-key"],
	}));
	app.use(express.json({ limit: "2mb" }));
	app.use(correlation);
	app.get("/health", (_request, response) => response.json({ success: true, service: "shared-pos", status: "ok" }));
	app.use("/v1", authenticate);
	app.use("/v1/session", sessionRouter);
	app.use("/v1/catalog", catalogRouter);
	app.use("/v1/customers", customersRouter);
	app.use("/v1/carts", cartsRouter);
	app.use(notFound);
	app.use(errorHandler);
	return app;
};
