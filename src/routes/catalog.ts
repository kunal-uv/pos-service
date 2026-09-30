import { Router } from "express";
import { z } from "zod";
import { getAdapter } from "../adapters/index.js";
import { sessionOf } from "../auth.js";

export const catalogRouter = Router();

catalogRouter.get("/", async (request, response, next) => {
	try {
		const query = z.object({
			search: z.string().trim().optional(),
			categoryId: z.string().trim().optional(),
			pageSize: z.coerce.number().int().min(1).max(200).default(60),
			pageOffset: z.coerce.number().int().min(0).default(0),
		}).parse(request.query);
		const session = sessionOf(request);
		const data = await getAdapter(session.tenantId).listCatalog(session, query);
		response.json({ success: true, data });
	} catch (error) { next(error); }
});

catalogRouter.get("/:productId/units", async (request, response, next) => {
	try {
		const session = sessionOf(request);
		const data = await getAdapter(session.tenantId).listUnits(session, request.params.productId);
		response.json({ success: true, data });
	} catch (error) { next(error); }
});
