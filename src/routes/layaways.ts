import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { sessionOf } from "../auth.js";
import { prisma } from "../db.js";
import { ApiError } from "../errors.js";
import { getCart, resumeCart } from "../cart-service.js";

export const layawaysRouter = Router();
layawaysRouter.use((req, _res, next) => {
  const session = sessionOf(req);
  if (session.tenantId !== "rent-buddyz") return next(new ApiError("Layaways are unavailable for this tenant", 403, "FORBIDDEN"));
  if (req.method !== "GET" && !session.permissions.includes("pos:create")) return next(new ApiError("Permission denied: pos.create required", 403, "FORBIDDEN"));
  next();
});
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const cents = (value: unknown) => Math.round(Number(value) * 100);
const paymentSchema = z.object({amount: z.number().finite().positive().max(10000000), method: z.enum(["cash", "debit", "credit", "interac"]), reference: z.string().trim().max(120).optional()});
const include = {lines: true, payments: {orderBy: {createdAt: "asc" as const}}};
const summary = (cart: any) => {
  const details = record(record(cart.fulfilment).layaway);
  const paid = cart.payments.filter((p: any) => record(p.metadata).layaway === true && p.status !== "REFUNDED" && p.status !== "VOIDED").reduce((sum: number, p: any) => sum + cents(p.amount), 0);
  return {id: cart.id, name: cart.heldName, customerName: record(cart.customerSnapshot).name ?? "Customer", dueDate: details.dueDate,
    status: cart.status === "CANCELLED" ? "cancelled" : cart.status === "COMPLETED" ? "completed" : details.releaseAuthorized ? "release_authorized" : paid >= cents(cart.grandTotal) ? "paid_ready" : "active",
    total: Number(cart.grandTotal), paid: paid / 100, remaining: Math.max(0, cents(cart.grandTotal) - paid) / 100,
    currency: cart.currency, note: details.note, cancellationReason: details.cancellationReason,
    paymentsToSettle: cart.status === "CANCELLED" ? paid / 100 : 0,
    payments: cart.payments.filter((p: any) => record(p.metadata).layaway === true).map((p: any) => ({id: p.id, amount: Number(p.amount), method: p.method, reference: p.externalReference, createdAt: p.createdAt})),
    lines: cart.lines.map((line: any) => ({name: line.name, serial: line.serial}))};
};

layawaysRouter.get("/", async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const carts = await prisma.cart.findMany({where: {tenantId: session.tenantId, storeId: session.storeId, fulfilment: {path: ["layaway", "dueDate"], not: Prisma.DbNull}}, include, orderBy: {updatedAt: "desc"}, take: 200});
    res.json({success: true, data: carts.map(summary)});
  } catch (error) { next(error); }
});

layawaysRouter.post("/", async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const input = paymentSchema.extend({cartId: z.string().uuid(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(2000).optional()}).parse(req.body);
    if (!session.capabilities.holds) throw new ApiError("Layaways are unavailable", 403, "FORBIDDEN");
    const due = new Date(`${input.dueDate}T23:59:59.999Z`);
    if (!Number.isFinite(due.getTime()) || due.toISOString().slice(0, 10) !== input.dueDate || due.getTime() < Date.now()) throw new ApiError("Choose a valid future due date", 422, "INVALID_DATE");
    const result = await prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({where: {id: input.cartId, tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, status: "OPEN"}, include});
      if (!cart || !cart.lines.length || !cart.customerId) throw new ApiError("Choose a customer and add items before creating a layaway", 409, "NOT_READY");
      if (cart.creditReference || cart.payments.length || record(cart.fulfilment).layaway) throw new ApiError("This cart already carries a payment, credit or layaway", 409, "NOT_READY");
      if (cents(input.amount) < 1 || cents(input.amount) > cents(cart.grandTotal)) throw new ApiError("Deposit must be between 0.01 and the total", 422, "INVALID_DEPOSIT");
      const changed = await tx.cart.updateMany({where: {id: cart.id, status: "OPEN", version: cart.version}, data: {status: "HELD", expiresAt: null, heldName: String(record(cart.customerSnapshot).name ?? "Layaway"), fulfilment: {...record(cart.fulfilment), layaway: {dueDate: input.dueDate, note: input.note ?? "", openedBy: session.userId}} as Prisma.InputJsonValue, version: {increment: 1}}});
      if (changed.count !== 1) throw new ApiError("Cart changed; refresh and try again", 409, "CONFLICT");
      await tx.payment.create({data: {cartId: cart.id, method: input.method, amount: cents(input.amount) / 100, status: "CAPTURED", externalReference: input.reference, metadata: {layaway: true, recordedBy: session.userId}}});
      await tx.auditEvent.create({data: {tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, entityType: "layaway", entityId: cart.id, action: "layaway.created", correlationId: req.correlationId, after: input}});
      return summary(await tx.cart.findUniqueOrThrow({where: {id: cart.id}, include}));
    });
    res.status(201).json({success: true, data: result});
  } catch (error) { next(error); }
});

layawaysRouter.post("/:id/payments", async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const input = paymentSchema.parse(req.body);
    const key = z.string().uuid().parse(req.get("idempotency-key"));
    const result = await prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({where: {id: req.params.id, tenantId: session.tenantId, storeId: session.storeId, status: "HELD"}, include});
      if (!cart || !record(cart.fulfilment).layaway) throw new ApiError("Layaway not found", 404, "NOT_FOUND");
      if (cart.payments.some((p) => record(p.metadata).requestKey === key)) return summary(cart);
      const before = summary(cart);
      if (cents(input.amount) < 1 || cents(input.amount) > cents(before.remaining)) throw new ApiError("Payment exceeds the remaining balance", 422, "INVALID_PAYMENT");
      const changed = await tx.cart.updateMany({where: {id: cart.id, status: "HELD", version: cart.version}, data: {version: {increment: 1}}});
      if (changed.count !== 1) throw new ApiError("Layaway changed; refresh and try again", 409, "CONFLICT");
      await tx.payment.create({data: {cartId: cart.id, method: input.method, amount: cents(input.amount) / 100, status: "CAPTURED", externalReference: input.reference, metadata: {layaway: true, recordedBy: session.userId, requestKey: key}}});
      await tx.auditEvent.create({data: {tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, entityType: "layaway", entityId: cart.id, action: "layaway.payment", correlationId: req.correlationId, after: input}});
      return summary(await tx.cart.findUniqueOrThrow({where: {id: cart.id}, include}));
    });
    res.json({success: true, data: result});
  } catch (error) { next(error); }
});

layawaysRouter.post("/:id/checkout", async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const cart = await prisma.cart.findFirst({where: {id: req.params.id, tenantId: session.tenantId, storeId: session.storeId, status: "HELD"}, include});
    if (!cart || !record(cart.fulfilment).layaway) throw new ApiError("Layaway not found", 404, "NOT_FOUND");
    if (summary(cart).remaining > 0 && !record(record(cart.fulfilment).layaway).releaseAuthorized) throw new ApiError("Pay the remaining balance before final checkout", 409, "BALANCE_DUE");
    const open = await prisma.cart.findFirst({where: {tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, status: "OPEN", lines: {some: {}}}});
    if (open) throw new ApiError("Finish the current cart before opening a layaway", 409, "OPEN_CART");
    res.json({success: true, data: await resumeCart(session, cart.id)});
  } catch (error) { next(error); }
});

layawaysRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const session = sessionOf(req);
    const {reason} = z.object({reason: z.string().trim().min(3).max(1000)}).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({where: {id: req.params.id, tenantId: session.tenantId, storeId: session.storeId, status: "HELD"}, include});
      if (!cart || !record(cart.fulfilment).layaway) throw new ApiError("Layaway not found", 404, "NOT_FOUND");
      const fulfilment = record(cart.fulfilment);
      const changed = await tx.cart.updateMany({where: {id: cart.id, status: "HELD", version: cart.version}, data: {status: "CANCELLED", version: {increment: 1}, fulfilment: {...fulfilment, layaway: {...record(fulfilment.layaway), cancellationReason: reason}} as Prisma.InputJsonValue}});
      if (changed.count !== 1) throw new ApiError("Layaway changed; refresh and try again", 409, "CONFLICT");
      await tx.cartLine.updateMany({where: {cartId: cart.id}, data: {reservationKey: null}});
      await tx.auditEvent.create({data: {tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, entityType: "layaway", entityId: cart.id, action: "layaway.cancelled", correlationId: req.correlationId, after: {reason, paymentsToSettle: summary(cart).paid}}});
      return summary(await tx.cart.findUniqueOrThrow({where: {id: cart.id}, include}));
    });
    res.json({success: true, data: result});
  } catch (error) { next(error); }
});

layawaysRouter.post("/:id/authorize-release", async (req, res, next) => {
  try {
    const session = sessionOf(req);
    if (!session.permissions.includes("pos:manage")) throw new ApiError("Manager permission is required to release an unpaid layaway", 403, "FORBIDDEN");
    const {reason} = z.object({reason: z.string().trim().min(3).max(1000)}).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({where: {id: req.params.id, tenantId: session.tenantId, storeId: session.storeId, status: "HELD"}, include});
      if (!cart || !record(cart.fulfilment).layaway) throw new ApiError("Layaway not found", 404, "NOT_FOUND");
      const details = record(cart.fulfilment);
      const changed = await tx.cart.updateMany({where: {id: cart.id, version: cart.version, status: "HELD"}, data: {version: {increment: 1}, fulfilment: {...details, layaway: {...record(details.layaway), releaseAuthorized: {reason, userId: session.userId, at: new Date().toISOString()}}} as Prisma.InputJsonValue}});
      if (changed.count !== 1) throw new ApiError("Layaway changed; refresh and try again", 409, "CONFLICT");
      await tx.auditEvent.create({data: {tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, entityType: "layaway", entityId: cart.id, action: "layaway.release_authorized", correlationId: req.correlationId, after: {reason}}});
      return summary(await tx.cart.findUniqueOrThrow({where: {id: cart.id}, include}));
    });
    res.json({success: true, data: result});
  } catch (error) { next(error); }
});
