import { Router } from "express";
import { z } from "zod";
import { getAdapter } from "../adapters/index.js";
import { sessionOf } from "../auth.js";

export const customersRouter = Router();

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
