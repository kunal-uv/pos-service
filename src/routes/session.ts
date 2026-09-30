import { Router } from "express";
import { sessionOf } from "../auth.js";

export const sessionRouter = Router();

sessionRouter.get("/", (request, response) => {
	const { token: _token, ...session } = sessionOf(request);
	response.json({ success: true, data: session });
});
