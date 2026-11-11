import { Router } from "express";
import { z } from "zod";
import { sessionOf } from "../auth.js";
import { listUnitHolds, releaseCartHolds } from "../cart-service.js";

/**
 * Units POS carts are holding, for the platform admin's Reserve & Hold page.
 * Reading needs only a POS session; releasing needs pos.manage (checked in
 * `releaseCartHolds`).
 */
export const holdsRouter = Router();

holdsRouter.get("/", async (request, response, next) => {
  try {
    response.json({ success: true, data: await listUnitHolds(sessionOf(request)) });
  } catch (error) {
    next(error);
  }
});

holdsRouter.post("/:cartId/release", async (request, response, next) => {
  try {
    const { reason } = z
      .object({ reason: z.string().trim().min(3, "Say why the units are being released").max(300) })
      .parse(request.body ?? {});
    response.json({
      success: true,
      data: await releaseCartHolds(sessionOf(request), request.params.cartId, reason, request.correlationId),
    });
  } catch (error) {
    next(error);
  }
});
