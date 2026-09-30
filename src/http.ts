import { config } from "./config.js";
import { ApiError } from "./errors.js";

interface UpstreamEnvelope<T> {
	success?: boolean;
	code?: number;
	data?: T;
	error?: string;
	message?: string;
}

/**
 * How a platform expects the staff token presented.
 *
 * This is not cosmetic and it is not the same everywhere. Rent Buddyz hands the
 * entire `Authorization` header value to `jwt.verify`, so a "Bearer " prefix is
 * part of the token as far as it is concerned and every request fails with
 * "Invalid Token". Appliance Outlet strips the prefix when it is there. The
 * scheme therefore belongs to the adapter that knows its platform, not to this
 * function - and a new platform must state which it is.
 */
export type AuthScheme = "bearer" | "raw";

const authorizationHeader = (token: string, scheme: AuthScheme) => {
	const bare = token.replace(/^Bearer\s+/i, "").trim();
	return scheme === "raw" ? bare : `Bearer ${bare}`;
};

export interface UpstreamOptions {
	scheme?: AuthScheme;
	/**
	 * The statuses this platform uses to say "the staff session is over".
	 *
	 * ! Not always 401. Appliance Outlet answers an expired or tampered token
	 * ! with 420 (and treats 498/499 the same), and its own admin logs the
	 * ! operator out on all three. Anything listed here becomes a 401 from this
	 * ! service, which is the one signal the till acts on - so an expired AO
	 * ! session sends the operator to sign in again rather than leaving "jwt
	 * ! expired" on screen with no way forward.
	 */
	sessionExpiredStatuses?: number[];
	/**
	 * Overrides REQUEST_TIMEOUT_MS for one call. Reads keep the short default;
	 * a platform's final commit gets longer, because abandoning it is worse than
	 * waiting for it - see `UPSTREAM_TIMEOUT` below.
	 */
	timeoutMs?: number;
}

/** A platform refusing the request on its merits, not failing to serve it. */
const REJECTION_STATUSES = new Set([400, 404, 409, 422]);

export const upstreamRequest = async <T>(
	url: string,
	token: string,
	init: RequestInit = {},
	options: UpstreamOptions = {},
): Promise<T> => {
	const scheme = options.scheme ?? "bearer";
	const sessionExpired = new Set(options.sessionExpiredStatuses ?? [401]);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? config.REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			...init,
			signal: controller.signal,
			headers: {
				accept: "application/json",
				authorization: authorizationHeader(token, scheme),
				...(init.body ? { "content-type": "application/json" } : {}),
				...init.headers,
			},
		});
		const raw = await response.text();
		let body: UpstreamEnvelope<T> | null = null;
		try {
			body = raw ? (JSON.parse(raw) as UpstreamEnvelope<T>) : null;
		} catch {
			throw new ApiError("Platform returned an unreadable response", 502, "UPSTREAM_INVALID_RESPONSE");
		}

		if (!response.ok || body?.success === false) {
			const message = body?.error ?? body?.message ?? `Platform request failed (${response.status})`;
			if (sessionExpired.has(response.status)) throw new ApiError(message, 401, "UNAUTHENTICATED");
			if (response.status === 403) throw new ApiError(message, 403, "FORBIDDEN");
			// ! Kept as what they are. A 409 "that unit is in another till's cart"
			// ! is the platform declining, not the platform being down, and
			// ! reporting it as a 502 sends whoever reads the logs looking for an
			// ! outage that never happened.
			if (REJECTION_STATUSES.has(response.status)) {
				throw new ApiError(message, response.status, "UPSTREAM_REJECTED");
			}
			throw new ApiError(message, 502, "UPSTREAM_ERROR");
		}

		return (body?.data ?? body) as T;
	} catch (error) {
		if (error instanceof ApiError) throw error;
		if (error instanceof Error && error.name === "AbortError") {
			throw new ApiError("Platform request timed out", 504, "UPSTREAM_TIMEOUT");
		}
		throw new ApiError("Platform is unavailable", 502, "UPSTREAM_UNAVAILABLE");
	} finally {
		clearTimeout(timer);
	}
};

export const withQuery = (base: string, values: Record<string, string | number | undefined>) => {
	const url = new URL(base);
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
	}
	return url.toString();
};
