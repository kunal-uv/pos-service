import { Router } from "express";
import { z } from "zod";
import { sessionOf } from "../auth.js";
import {
  applyCredit,
  addLine,
  checkout,
  findOrCreateCart,
  getCart,
  removeLine,
  replacePayments,
  selectOptionalFee,
  updateLine,
  updateCart,
} from "../cart-service.js";
import { ApiError } from "../errors.js";

export const cartsRouter = Router();

cartsRouter.post("/", async (request, response, next) => {
  try {
    const { kind } = z
      .object({ kind: z.enum(["SALE", "RENTAL"]) })
      .parse(request.body);
    response.status(201).json({
      success: true,
      data: await findOrCreateCart(sessionOf(request), kind),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.get("/:id", async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await getCart(sessionOf(request), request.params.id),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.patch("/:id", async (request, response, next) => {
  try {
    const body = z
      .object({
        customer: z
          .object({
            id: z.string().min(1),
            snapshot: z.record(z.unknown()).optional(),
          })
          .optional(),
        notes: z.string().max(2000).nullable().optional(),
        fulfilment: z.unknown().optional(),
        heldName: z.string().max(120).optional(),
      })
      .parse(request.body);
    response.json({
      success: true,
      data: await updateCart(sessionOf(request), request.params.id, body),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Spend a platform credit on this cart, or take it back off. The body names a
 * reference and nothing else: the amount is the platform's to decide.
 */
cartsRouter.patch("/:id/credit", async (request, response, next) => {
  try {
    const body = z
      .object({ reference: z.string().min(1).nullable() })
      .parse(request.body);
    response.json({
      success: true,
      data: await applyCredit(sessionOf(request), request.params.id, body.reference),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.post("/:id/lines", async (request, response, next) => {
  try {
    const body = z
      .object({
        productId: z.string().min(1),
        unitId: z.string().min(1).optional(),
        quantity: z.number().int().min(1).max(100).optional(),
        rentalStart: z.string().datetime().optional(),
        rentalEnd: z.string().datetime().optional(),
        rentalTenure: z.number().int().min(1).max(120).optional(),
      })
      .parse(request.body);
    response.status(201).json({
      success: true,
      data: await addLine(
        sessionOf(request),
        request.params.id,
        body,
        request.correlationId,
      ),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.delete("/:id/lines/:lineId", async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await removeLine(
        sessionOf(request),
        request.params.id,
        request.params.lineId,
        request.correlationId,
      ),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.patch("/:id/lines/:lineId", async (request, response, next) => {
  try {
    const body = z
      .object({
        note: z.string().max(2000).nullable().optional(),
        // The warranty plan sold with this line; null takes it off.
        warrantyId: z.string().min(1).max(40).nullable().optional(),
      })
      .parse(request.body);
    response.json({
      success: true,
      data: await updateLine(
        sessionOf(request),
        request.params.id,
        request.params.lineId,
        body,
        request.correlationId,
      ),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.patch(
  "/:id/lines/:lineId/optional-fees/:attributeId",
  async (request, response, next) => {
    try {
      const { selected } = z
        .object({ selected: z.boolean() })
        .parse(request.body);
      response.json({
        success: true,
        data: await selectOptionalFee(
          sessionOf(request),
          request.params.id,
          request.params.lineId,
          request.params.attributeId,
          selected,
          request.correlationId,
        ),
      });
    } catch (error) {
      next(error);
    }
  },
);

cartsRouter.put("/:id/payments", async (request, response, next) => {
  try {
    const { payments } = z
      .object({
        payments: z
          .array(
            z.object({
              method: z.string().trim().min(1).max(64),
              amount: z.number().positive(),
              reference: z.string().trim().max(200).optional(),
            }),
          )
          /**
           * ! Empty is legitimate. A sale covered entirely by a credit owes
           * ! nothing, and the till still has to clear whatever it recorded
           * ! before - `min(1)` made "nothing to pay" unsendable.
           */
          .max(20),
      })
      .parse(request.body);
    response.json({
      success: true,
      data: await replacePayments(
        sessionOf(request),
        request.params.id,
        payments,
      ),
    });
  } catch (error) {
    next(error);
  }
});

cartsRouter.post("/:id/checkout", async (request, response, next) => {
  try {
    const idempotencyKey = request.header("idempotency-key")?.trim();
    if (!idempotencyKey)
      throw new ApiError(
        "Idempotency-Key is required",
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
      );
    const data = await checkout(
      sessionOf(request),
      request.params.id,
      idempotencyKey,
      request.correlationId,
    );
    response.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
