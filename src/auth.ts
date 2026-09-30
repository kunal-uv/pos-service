import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getAdapter } from "./adapters/index.js";
import { ApiError } from "./errors.js";

export const correlation = (request: Request, response: Response, next: NextFunction) => {
	request.correlationId = String(request.header("x-correlation-id") ?? randomUUID());
	response.setHeader("x-correlation-id", request.correlationId);
	next();
};

export const authenticate = async (request: Request, _response: Response, next: NextFunction) => {
	try {
		const tenant = request.header("x-pos-tenant")?.trim();
		const storeId = request.header("x-pos-store")?.trim();
		const authorization = request.header("authorization")?.trim();
		if (!tenant) throw new ApiError("X-POS-Tenant is required", 400, "TENANT_REQUIRED");
		if (!storeId) throw new ApiError("X-POS-Store is required", 400, "STORE_REQUIRED");
		if (!authorization) throw new ApiError("Authorization is required", 401, "UNAUTHENTICATED");
		const token = authorization.replace(/^Bearer\s+/i, "");
		request.posSession = await getAdapter(tenant).authenticate(token, storeId);
		next();
	} catch (error) {
		next(error);
	}
};

export const sessionOf = (request: Request) => {
	if (!request.posSession) throw new ApiError("Authentication context is missing", 401, "UNAUTHENTICATED");
	return request.posSession;
};
