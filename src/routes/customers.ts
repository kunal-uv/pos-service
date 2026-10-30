import { Router } from "express";
import { z } from "zod";
import { getAdapter } from "../adapters/index.js";
import { sessionOf } from "../auth.js";
import { ApiError } from "../errors.js";

export const customersRouter = Router();

customersRouter.get("/:id", async (request, response, next) => {
	try {
		const session = sessionOf(request);
		const adapter = getAdapter(session.tenantId);
		if (!adapter.getCustomer) throw new ApiError("Customer editing is unavailable", 422, "UNSUPPORTED");
		response.json({success: true, data: await adapter.getCustomer(session, request.params.id)});
	} catch (error) { next(error); }
});

customersRouter.patch("/:id", async (request, response, next) => {
	try {
		const session = sessionOf(request);
		const adapter = getAdapter(session.tenantId);
		if (!adapter.updateCustomer) throw new ApiError("Customer editing is unavailable", 422, "UNSUPPORTED");
		const input = z.record(z.unknown()).parse(request.body);
		response.json({success: true, data: await adapter.updateCustomer(session, request.params.id, input)});
	} catch (error) { next(error); }
});

customersRouter.get("/", async (request, response, next) => {
	try {
		const { search } = z.object({ search: z.string().trim().max(100).default("") }).parse(request.query);
		const session = sessionOf(request);
		const data = await getAdapter(session.tenantId).searchCustomers(session, search);
		response.json({ success: true, data });
	} catch (error) { next(error); }
});

customersRouter.get("/:id/addresses", async (request, response, next) => {
	try {
		const { id } = z.object({ id: z.string().trim().min(1).max(100) }).parse(request.params);
		const session = sessionOf(request);
		const data = await getAdapter(session.tenantId).getCustomerAddresses(session, id);
		response.json({ success: true, data });
	} catch (error) { next(error); }
});

customersRouter.post("/", async (request, response, next) => {
	try {
		const input = z.record(z.unknown()).parse(request.body);
		const session = sessionOf(request);
		const data = await getAdapter(session.tenantId).createCustomer(session, input);
		response.status(201).json({ success: true, data });
	} catch (error) { next(error); }
});
