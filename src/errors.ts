import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status = 400,
		public readonly code = "BAD_REQUEST",
		public readonly details?: unknown,
	) {
		super(message);
	}
}

export const notFound = (_request: Request, response: Response) => {
	response.status(404).json({ success: false, code: "NOT_FOUND", error: "Route not found" });
};

export const errorHandler = (
	error: unknown,
	request: Request,
	response: Response,
	_next: NextFunction,
) => {
	if (error instanceof ZodError) {
		return response.status(422).json({
			success: false,
			code: "VALIDATION_ERROR",
			error: error.issues[0]?.message ?? "Invalid request",
			details: error.flatten(),
			correlationId: request.correlationId,
		});
	}

	if (error instanceof ApiError) {
		return response.status(error.status).json({
			success: false,
			code: error.code,
			error: error.message,
			details: error.details,
			correlationId: request.correlationId,
		});
	}

	console.error(`[${request.correlationId}]`, error);
	return response.status(500).json({
		success: false,
		code: "INTERNAL_ERROR",
		error: "An unexpected error occurred",
		correlationId: request.correlationId,
	});
};
