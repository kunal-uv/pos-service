import { createHash } from "node:crypto";
import { CartStatus, Prisma } from "@prisma/client";
import { getAdapter } from "./adapters/index.js";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";
import { priceLines } from "./pricing.js";
import type {
  PlatformCheckout,
  PosLineAttribute,
  StaffSession,
  TransactionKind,
} from "./types.js";

const cartInclude = {
  lines: { orderBy: { createdAt: "asc" as const } },
  payments: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.CartInclude;

type LoadedCart = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

const json = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;
const number = (value: Prisma.Decimal | number | string) => Number(value);

const fulfilmentRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const shippingFromFulfilment = (value: unknown): number => {
  const fulfilment = fulfilmentRecord(value);
  return String(fulfilment.method ?? "").toLowerCase() === "delivery"
    ? Math.max(0, Number(fulfilment.shippingFee) || 0)
    : 0;
};

const withStoreShipping = (
  value: unknown,
  shippingFee: number | undefined,
): Record<string, unknown> => {
  const fulfilment = fulfilmentRecord(value);
  return {
    ...fulfilment,
    shippingFee:
      String(fulfilment.method ?? "").toLowerCase() === "delivery"
        ? Math.max(0, Number(shippingFee) || 0)
        : 0,
  };
};

const normalizeAttributes = (source: unknown): PosLineAttribute[] => {
  if (!Array.isArray(source)) return [];
  return source.flatMap((entry): PosLineAttribute[] => {
    const attribute = entry as Partial<PosLineAttribute>;
    if (!attribute?.id || !attribute?.name) return [];
    return [
      {
        id: String(attribute.id),
        name: String(attribute.name),
        value: Math.max(0, Number(attribute.value ?? 0) || 0),
        recurring: Boolean(attribute.recurring),
        optional: Boolean(attribute.optional),
        selected: !attribute.optional || attribute.selected !== false,
      },
    ];
  });
};

const attributesFromProduct = (
  metadata: Record<string, unknown>,
): PosLineAttribute[] => normalizeAttributes(metadata.attributes);

/** The store attributes a line was priced with, read back off its snapshot. */
const lineAttributes = (metadata: unknown): PosLineAttribute[] => {
  const product = (metadata as { product?: { attributes?: unknown } } | null)
    ?.product;
  return normalizeAttributes(product?.attributes);
};

/** A warranty plan as the platform offered it with a product. */
export interface OfferedWarranty {
  id: string;
  title: string;
  kind: string;
  price: number;
  minPrice: number;
  maxPrice: number;
  durationMonths: number;
  terms: string | null;
}

const offeredWarranties = (metadata: unknown): OfferedWarranty[] => {
  const raw = (metadata as { product?: { warranties?: unknown } } | null)
    ?.product?.warranties;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OfferedWarranty[] => {
    const plan = entry as Record<string, unknown>;
    if (!plan || typeof plan.id !== "string") return [];
    return [
      {
        id: plan.id,
        title: String(plan.title ?? ""),
        kind: String(plan.kind ?? "EXTENDED"),
        price: Math.max(0, Number(plan.price ?? 0) || 0),
        minPrice: Math.max(0, Number(plan.minPrice ?? 0) || 0),
        maxPrice: Math.max(0, Number(plan.maxPrice ?? 0) || 0),
        durationMonths: Math.max(0, Math.trunc(Number(plan.durationMonths ?? 0) || 0)),
        terms: typeof plan.terms === "string" ? plan.terms : null,
      },
    ];
  });
};

/** Offered at this line's rent: a plan is priced for a band of rents. */
const offeredAt = (plan: OfferedWarranty, unitPrice: number) =>
  unitPrice >= plan.minPrice && unitPrice <= plan.maxPrice;

/** The plan chosen for a line, as it was when it was chosen. */
const chosenWarranty = (metadata: unknown): OfferedWarranty | null => {
  const chosen = (metadata as { warranty?: unknown } | null)?.warranty;
  if (!chosen || typeof chosen !== "object") return null;
  return offeredWarranties({ product: { warranties: [chosen] } })[0] ?? null;
};

/** What the chosen plan costs for the quantity on the line. */
const warrantyAmount = (line: { quantity: number; metadata: unknown }) =>
  Math.round((chosenWarranty(line.metadata)?.price ?? 0) * Math.max(1, line.quantity) * 100) / 100;

/** How long a cart may sit untouched before its units go back on the floor. */
export const CART_TTL_MS = 8 * 60 * 60 * 1000;
const expiry = () => new Date(Date.now() + CART_TTL_MS);

/**
 * Returns abandoned carts' units to the floor.
 *
 * A line holds `reservationKey`, which is unique across the whole tenant, so a
 * cart nobody ever finished blocks that unit for every other till - there is no
 * operator-facing way to release it and the platform's own sweep cannot see a
 * reservation this service is holding. Staleness is measured from the cart's
 * last change, not its creation: a cart being actively worked on is not stale.
 * Held carts are parked deliberately and are left alone.
 */
export const releaseStaleCarts = async () => {
  const staleBefore = new Date(Date.now() - CART_TTL_MS);
  const stale = await prisma.cart.findMany({
    where: { status: "OPEN", updatedAt: { lt: staleBefore } },
    select: { id: true },
  });
  if (!stale.length) return 0;

  const ids = stale.map((cart) => cart.id);
  await prisma.$transaction([
    prisma.cartLine.updateMany({
      where: { cartId: { in: ids } },
      data: { reservationKey: null },
    }),
    prisma.cart.updateMany({
      where: { id: { in: ids }, status: "OPEN" },
      data: { status: "EXPIRED" },
    }),
  ]);
  return ids.length;
};

export const presentCart = (cart: LoadedCart) => ({
  ...cart,
  taxRate: number(cart.taxRate),
  subtotal: number(cart.subtotal),
  discountTotal: number(cart.discountTotal),
  taxTotal: number(cart.taxTotal),
  feeTotal: number(cart.feeTotal),
  shippingTotal: shippingFromFulfilment(cart.fulfilment),
  depositTotal: number(cart.depositTotal),
  creditTotal: number(cart.creditTotal),
  grandTotal: number(cart.grandTotal),
  warrantyTotal:
    Math.round(
      cart.lines.reduce((total, line) => total + warrantyAmount(line), 0) * 100,
    ) / 100,
  lines: cart.lines.map((line) => ({
    ...line,
    // The plan sold with the line, and the ones still on offer at its rent.
    warranty: chosenWarranty(line.metadata)
      ? { ...chosenWarranty(line.metadata), total: warrantyAmount(line) }
      : null,
    availableWarranties: offeredWarranties(line.metadata).filter((plan) =>
      offeredAt(plan, number(line.unitPrice)),
    ),
    unitPrice: number(line.unitPrice),
    originalUnitPrice:
      line.originalUnitPrice === null ? null : number(line.originalUnitPrice),
    discountAmount: number(line.discountAmount),
    feeAmount: number(line.feeAmount),
    depositAmount: number(line.depositAmount),
    taxAmount: number(line.taxAmount),
    lineTotal: number(line.lineTotal),
  })),
  payments: cart.payments.map((payment) => ({
    ...payment,
    amount: number(payment.amount),
  })),
});

const ownedCart = async (
  session: StaffSession,
  id: string,
  allowed: CartStatus[] = ["OPEN", "HELD"],
) => {
  const cart = await prisma.cart.findFirst({
    where: {
      id,
      tenantId: session.tenantId,
      storeId: session.storeId,
      userId: session.userId,
      status: { in: allowed },
    },
    include: cartInclude,
  });
  if (!cart)
    throw new ApiError(
      "Cart was not found or is no longer editable",
      404,
      "CART_NOT_FOUND",
    );
  return cart;
};

/**
 * Re-totals a cart at the tax rate the cart itself holds.
 *
 * ! Not `session.taxRate`. The rate belongs to the sale, not the operator: a
 * ! tax-exempt customer or a reseller with a permit is charged nothing, and
 * ! `updateCart` writes that onto the cart when the customer is chosen. Pricing
 * ! every change at the store's flat rate is what charged those customers tax
 * ! the platform then refused to invoice - and kept as an overpayment.
 */
const reprice = async (
  transaction: Prisma.TransactionClient,
  cartId: string,
) => {
  const [lines, cart] = await Promise.all([
    transaction.cartLine.findMany({
      where: { cartId },
      orderBy: { createdAt: "asc" },
    }),
    transaction.cart.findUniqueOrThrow({
      where: { id: cartId },
      select: { fulfilment: true, taxRate: true, creditTotal: true },
    }),
  ]);
  const taxRate = number(cart.taxRate);
  const priced = priceLines(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: number(line.unitPrice),
      originalUnitPrice:
        line.originalUnitPrice === null ? null : number(line.originalUnitPrice),
      feeAmount: number(line.feeAmount),
      depositAmount: number(line.depositAmount),
      warrantyAmount: warrantyAmount(line),
      rentalTenure: line.rentalTenure,
    })),
    taxRate,
    shippingFromFulfilment(cart.fulfilment),
    number(cart.creditTotal),
  );

  // Sequential: an interactive transaction is a single connection, and firing
  // these concurrently on one transaction client is what exhausts its pool.
  for (const [index, line] of lines.entries()) {
    await transaction.cartLine.update({
      where: { id: line.id },
      data: {
        discountAmount: priced.lines[index]?.discountAmount ?? 0,
        taxAmount: priced.lines[index]?.taxAmount ?? 0,
        lineTotal: priced.lines[index]?.lineTotal ?? 0,
      },
    });
  }

  await transaction.cart.update({
    where: { id: cartId },
    data: {
      expiresAt: expiry(),
      taxRate,
      subtotal: priced.totals.subtotal,
      discountTotal: priced.totals.discountTotal,
      taxTotal: priced.totals.taxTotal,
      feeTotal: priced.totals.feeTotal,
      depositTotal: priced.totals.depositTotal,
      grandTotal: priced.totals.grandTotal,
      version: { increment: 1 },
    },
  });
};

export const findOrCreateCart = async (
  session: StaffSession,
  kind: TransactionKind,
) => {
  if (!session.capabilities.transactionKinds.includes(kind)) {
    throw new ApiError(
      `${kind.toLowerCase()} transactions are not enabled for this platform`,
      422,
      "UNSUPPORTED_TRANSACTION",
    );
  }
  const existing = await prisma.cart.findFirst({
    where: {
      tenantId: session.tenantId,
      storeId: session.storeId,
      userId: session.userId,
      kind,
      status: "OPEN",
    },
    orderBy: { updatedAt: "desc" },
    include: cartInclude,
  });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      // A resumed cart picks up the store's current rate - unless its
      // customer is exempt, which the store rate has no bearing on.
      const exempt = Boolean(
        (existing.customerSnapshot as { taxExempt?: boolean } | null)
          ?.taxExempt,
      );
      await tx.cart.update({
        where: { id: existing.id },
        data: {
          fulfilment: json(
            withStoreShipping(existing.fulfilment, session.shippingFee),
          ),
          taxRate: exempt ? 0 : session.taxRate,
        },
      });
      await reprice(tx, existing.id);
    });
    return getCart(session, existing.id);
  }
  const created = await prisma.cart.create({
    data: {
      tenantId: session.tenantId,
      storeId: session.storeId,
      userId: session.userId,
      kind,
      currency: session.currency,
      taxRate: session.taxRate,
      expiresAt: expiry(),
    },
    include: cartInclude,
  });
  return presentCart(created);
};

/**
 * A line records the warranty plans its product offered at the moment it was
 * added. A cart that was already open when warranties were introduced - carts
 * live for hours - holds lines from before, and so offers nothing on them for
 * the rest of the shift. Those lines are brought up to date here, once, from
 * the platform: only the list of plans is written, nothing about price, tax or
 * the unit changes, and a platform that cannot answer simply leaves the line as
 * it was.
 */
const refreshWarrantyOffers = async (session: StaffSession, cart: LoadedCart) => {
  if (cart.status !== "OPEN" && cart.status !== "HELD") return cart;
  const stale = cart.lines.filter((line) => {
    const product = (line.metadata as { product?: { warranties?: unknown } } | null)
      ?.product;
    return product && typeof product === "object" && product.warranties === undefined;
  });
  if (stale.length === 0) return cart;

  let changed = false;
  for (const line of stale) {
    try {
      const { product } = await getAdapter(session.tenantId).resolveSellable(
        session,
        { productId: line.externalProductId },
      );
      const offered = product.metadata?.warranties;
      if (!Array.isArray(offered)) continue;
      const metadata = fulfilmentRecord(line.metadata);
      await prisma.cartLine.update({
        where: { id: line.id },
        data: {
          metadata: json({
            ...metadata,
            product: { ...(metadata.product as Record<string, unknown>), warranties: offered },
          }),
        },
      });
      changed = true;
    } catch {
      // Leave the line as it was; the next load tries again.
    }
  }
  return changed ? ownedCart(session, cart.id, ["OPEN", "HELD"]) : cart;
};

export const getCart = async (session: StaffSession, id: string) =>
  presentCart(
    await refreshWarrantyOffers(
      session,
      await ownedCart(session, id, ["OPEN", "HELD", "COMPLETED"]),
    ),
  );

export interface AddLineInput {
  productId: string;
  unitId?: string;
  quantity?: number;
  rentalStart?: string;
  rentalEnd?: string;
  rentalTenure?: number;
}

export const addLine = async (
  session: StaffSession,
  cartId: string,
  input: AddLineInput,
  correlationId: string,
) => {
  const cart = await ownedCart(session, cartId, ["OPEN"]);
  const resolved = await getAdapter(session.tenantId).resolveSellable(
    session,
    input,
  );
  // Rentals need one as much as sales do: both platforms key their checkout on
  // the unit, so accepting a line without one only defers the refusal to the
  // commit, where the cart has already been locked.
  if (session.capabilities.serializedInventory && !resolved.unit) {
    throw new ApiError("Choose a serialized unit", 422, "UNIT_REQUIRED");
  }
  let rentalTenure = input.rentalTenure;
  if (cart.kind === "RENTAL") {
    if (!input.rentalStart || !input.rentalEnd) {
      throw new ApiError(
        "Rental dates are required",
        422,
        "RENTAL_PERIOD_REQUIRED",
      );
    }
    if (
      new Date(input.rentalEnd).getTime() <=
      new Date(input.rentalStart).getTime()
    ) {
      throw new ApiError(
        "Rental end date must be after the start date",
        422,
        "INVALID_RENTAL_PERIOD",
      );
    }
    /**
     * The period and the tenure are one fact. The platform stores both -
     * an end date and a month count - so a caller that sends a twelve-month
     * tenure with a one-month period writes an order that contradicts
     * itself, and nothing downstream can tell which half was meant.
     * Tenure is therefore derived when it is not sent, and refused when it
     * disagrees with the dates.
     */
    const span = monthsBetween(input.rentalStart, input.rentalEnd);
    rentalTenure = input.rentalTenure ?? span;
    if (rentalTenure !== span) {
      throw new ApiError(
        `A ${rentalTenure}-month tenure does not match a rental period of ${span} month${span === 1 ? "" : "s"}`,
        422,
        "RENTAL_PERIOD_MISMATCH",
        {
          rentalTenure,
          periodMonths: span,
          rentalStart: input.rentalStart,
          rentalEnd: input.rentalEnd,
        },
      );
    }
  }
  const advertisedUnitPrice = resolved.unit?.price ?? resolved.product.price;
  const advertisedOriginalPrice =
    resolved.unit?.originalPrice ?? resolved.product.originalPrice;
  const deposit = resolved.unit?.deposit ?? resolved.product.deposit;
  const attributes = attributesFromProduct(resolved.product.metadata).map(
    (attribute) => ({
      ...attribute,
      selected: true,
    }),
  );
  const recurringAddOns = attributes
    .filter((attribute) => attribute.recurring)
    .reduce((total, attribute) => total + attribute.value, 0);
  const oneOffAddOns = attributes
    .filter((attribute) => !attribute.recurring)
    .reduce((total, attribute) => total + attribute.value, 0);
  const configuredBasePrice = Number(resolved.product.metadata?.baseRent);
  const baseUnitPrice = Number.isFinite(configuredBasePrice)
    ? Math.max(0, configuredBasePrice)
    : Math.max(0, advertisedUnitPrice - recurringAddOns);
  const baseOriginalUnitPrice =
    advertisedOriginalPrice === null
      ? null
      : Math.max(baseUnitPrice, advertisedOriginalPrice - recurringAddOns);
  const unitPrice = baseUnitPrice + recurringAddOns;
  const originalPrice =
    baseOriginalUnitPrice === null
      ? null
      : baseOriginalUnitPrice + recurringAddOns;
  const productMetadata = {
    ...resolved.product.metadata,
    baseUnitPrice,
    baseOriginalUnitPrice,
    attributes,
  };
  const reservationKey = resolved.unit
    ? `${session.tenantId}:${resolved.unit.id}`
    : null;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.cart.findFirst({
        where: { id: cartId, status: "OPEN", version: cart.version },
      });
      if (!current)
        throw new ApiError(
          "Cart changed; refresh and try again",
          409,
          "CART_VERSION_CONFLICT",
        );
      await tx.cartLine.create({
        data: {
          cartId,
          externalProductId: resolved.product.id,
          externalUnitId: resolved.unit?.id,
          reservationKey,
          sku: resolved.product.sku,
          serial: resolved.unit?.serial,
          name: resolved.product.name,
          imageUrl: resolved.product.imageUrl,
          quantity: Math.max(1, Math.trunc(input.quantity ?? 1)),
          unitPrice,
          originalUnitPrice: originalPrice,
          depositAmount: deposit,
          // Non-recurring store attributes are a single charge, which is
          // exactly what a line fee is. The recurring ones are already
          // inside `unitPrice`, so they bill again every period.
          feeAmount: oneOffAddOns,
          rentalStart: input.rentalStart ? new Date(input.rentalStart) : null,
          rentalEnd: input.rentalEnd ? new Date(input.rentalEnd) : null,
          rentalTenure,
          metadata: json({
            product: productMetadata,
            unit: resolved.unit?.metadata ?? null,
          }),
        },
      });
      await reprice(tx, cartId);
      await tx.auditEvent.create({
        data: {
          tenantId: session.tenantId,
          storeId: session.storeId,
          userId: session.userId,
          entityType: "cart",
          entityId: cartId,
          action: "line.added",
          correlationId,
          after: json({
            productId: input.productId,
            unitId: input.unitId ?? null,
          }),
        },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      reservationKey
    ) {
      throw new ApiError(
        "That unit is already reserved in another POS cart",
        409,
        "UNIT_RESERVED",
      );
    }
    throw error;
  }
  return getCart(session, cartId);
};

export const removeLine = async (
  session: StaffSession,
  cartId: string,
  lineId: string,
  correlationId: string,
) => {
  await ownedCart(session, cartId, ["OPEN"]);
  await prisma.$transaction(async (tx) => {
    const removed = await tx.cartLine.deleteMany({
      where: { id: lineId, cartId },
    });
    if (removed.count !== 1)
      throw new ApiError("Cart line not found", 404, "LINE_NOT_FOUND");
    await reprice(tx, cartId);
    await tx.auditEvent.create({
      data: {
        tenantId: session.tenantId,
        storeId: session.storeId,
        userId: session.userId,
        entityType: "cart",
        entityId: cartId,
        action: "line.removed",
        correlationId,
        after: json({ lineId }),
      },
    });
  });
  return getCart(session, cartId);
};

export const updateLine = async (
  session: StaffSession,
  cartId: string,
  lineId: string,
  input: { note?: string | null; warrantyId?: string | null },
  correlationId: string,
) => {
  await ownedCart(session, cartId, ["OPEN"]);
  await prisma.$transaction(async (tx) => {
    const line = await tx.cartLine.findFirst({ where: { id: lineId, cartId } });
    if (!line) throw new ApiError("Cart line not found", 404, "LINE_NOT_FOUND");

    const metadata = fulfilmentRecord(line.metadata);
    const next: Record<string, unknown> = { ...metadata };
    const warrantyChanged = input.warrantyId !== undefined;
    const noteChanged = input.note !== undefined;
    const previous = chosenWarranty(line.metadata);
    let plan: OfferedWarranty | null = null;

    // Choosing, changing or removing a warranty. The plan must be one the
    // product offers and must be offered at this line's rent; the platform
    // checks it again, against its own records, when the sale is committed.
    if (warrantyChanged) {
      if (input.warrantyId !== null) {
        plan =
          offeredWarranties(line.metadata).find(
            (candidate) => candidate.id === input.warrantyId,
          ) ?? null;
        if (!plan || !offeredAt(plan, number(line.unitPrice))) {
          throw new ApiError(
            "That warranty is not offered with this rental",
            422,
            "WARRANTY_NOT_OFFERED",
          );
        }
      }
      if (plan) next.warranty = plan;
      else delete next.warranty;
    }

    // Only a request that names the note touches it: a warranty change must
    // not wipe the line's note.
    const note = input.note?.trim() || null;
    if (noteChanged) next.additionalNote = note;
    if (!warrantyChanged && !noteChanged) return;

    await tx.cartLine.update({
      where: { id: lineId },
      data: { metadata: json(next) },
    });
    if (warrantyChanged) await reprice(tx, cartId);

    if (warrantyChanged) {
      await tx.auditEvent.create({
        data: {
          tenantId: session.tenantId,
          storeId: session.storeId,
          userId: session.userId,
          entityType: "cart",
          entityId: cartId,
          action: "line.warranty_changed",
          correlationId,
          before: json({ lineId, warrantyId: previous?.id ?? null }),
          after: json({ lineId, warrantyId: plan?.id ?? null }),
        },
      });
    }
    if (noteChanged) {
      await tx.auditEvent.create({
        data: {
          tenantId: session.tenantId,
          storeId: session.storeId,
          userId: session.userId,
          entityType: "cart",
          entityId: cartId,
          action: "line.note_changed",
          correlationId,
          before: json({
            lineId,
            note:
              typeof metadata.additionalNote === "string"
                ? metadata.additionalNote
                : null,
          }),
          after: json({ lineId, note }),
        },
      });
    }
  });
  return getCart(session, cartId);
};

export const selectOptionalFee = async (
  session: StaffSession,
  cartId: string,
  lineId: string,
  attributeId: string,
  selected: boolean,
  correlationId: string,
) => {
  await ownedCart(session, cartId, ["OPEN"]);
  await prisma.$transaction(async (tx) => {
    const line = await tx.cartLine.findFirst({ where: { id: lineId, cartId } });
    if (!line) throw new ApiError("Cart line not found", 404, "LINE_NOT_FOUND");

    const metadata = (line.metadata ?? {}) as Record<string, unknown>;
    const product = (metadata.product ?? {}) as Record<string, unknown>;
    const attributes = lineAttributes(metadata);
    const target = attributes.find((attribute) => attribute.id === attributeId);
    if (!target)
      throw new ApiError(
        "Fee was not found on this cart line",
        404,
        "FEE_NOT_FOUND",
      );
    if (!target.optional)
      throw new ApiError(
        "This fee is required and cannot be removed",
        422,
        "FEE_REQUIRED",
      );

    const nextAttributes = attributes.map((attribute) =>
      attribute.id === attributeId ? { ...attribute, selected } : attribute,
    );
    const currentSelectedRecurring = attributes
      .filter(
        (attribute) => attribute.recurring && attribute.selected !== false,
      )
      .reduce((total, attribute) => total + attribute.value, 0);
    const selectedRecurring = nextAttributes
      .filter(
        (attribute) => attribute.recurring && attribute.selected !== false,
      )
      .reduce((total, attribute) => total + attribute.value, 0);
    const selectedOneOff = nextAttributes
      .filter(
        (attribute) => !attribute.recurring && attribute.selected !== false,
      )
      .reduce((total, attribute) => total + attribute.value, 0);
    const baseUnitPrice = Math.max(
      0,
      Number(product.baseUnitPrice ?? product.baseRent ?? line.unitPrice) || 0,
    );
    const originalBaseValue = product.baseOriginalUnitPrice;
    const baseOriginalUnitPrice =
      originalBaseValue === null
        ? null
        : originalBaseValue === undefined
          ? line.originalUnitPrice === null
            ? null
            : Math.max(
                baseUnitPrice,
                number(line.originalUnitPrice) - currentSelectedRecurring,
              )
          : Math.max(baseUnitPrice, Number(originalBaseValue) || 0);

    await tx.cartLine.update({
      where: { id: lineId },
      data: {
        unitPrice: baseUnitPrice + selectedRecurring,
        originalUnitPrice:
          baseOriginalUnitPrice === null
            ? null
            : baseOriginalUnitPrice + selectedRecurring,
        feeAmount: selectedOneOff,
        metadata: json({
          ...metadata,
          product: { ...product, attributes: nextAttributes },
        }),
      },
    });
    await reprice(tx, cartId);
    await tx.auditEvent.create({
      data: {
        tenantId: session.tenantId,
        storeId: session.storeId,
        userId: session.userId,
        entityType: "cart",
        entityId: cartId,
        action: "optional_fee.selection_changed",
        correlationId,
        before: json({
          lineId,
          attributeId,
          selected: target.selected !== false,
        }),
        after: json({ lineId, attributeId, selected }),
      },
    });
  });
  return getCart(session, cartId);
};

export const updateCart = async (
  session: StaffSession,
  cartId: string,
  input: {
    customer?: { id: string; snapshot?: Record<string, unknown> };
    notes?: string | null;
    fulfilment?: unknown;
    heldName?: string;
  },
) => {
  const existingCart = await ownedCart(session, cartId, ["OPEN", "HELD"]);

  /**
   * ! A credit belongs to the customer whose machine paid for it. Moving the
   * ! cart to somebody else would spend it on a stranger's rental, so the
   * ! credit has to come off first - deliberately, by the operator.
   */
  if (
    input.customer &&
    existingCart.creditReference &&
    existingCart.customerId &&
    existingCart.customerId !== input.customer.id
  ) {
    throw new ApiError(
      "This cart holds a credit belonging to another customer. Remove the credit before changing who is buying.",
      409,
      "CREDIT_CUSTOMER_MISMATCH",
    );
  }

  /**
   * Resolved from the platform, never from the request. The snapshot the till
   * sends is display data; if it could carry "exempt", a cashier could zero
   * the tax on any sale by editing a request.
   */
  const exemption = input.customer
    ? ((await getAdapter(session.tenantId).resolveCustomerTax?.(
        session,
        input.customer.id,
      )) ?? null)
    : undefined;
  await prisma.$transaction(async (tx) => {
    const current = await tx.cart.findUniqueOrThrow({
      where: { id: cartId },
      select: { fulfilment: true },
    });
    const fulfilment =
      input.fulfilment !== undefined ? input.fulfilment : current.fulfilment;
    await tx.cart.update({
      where: { id: cartId },
      data: {
        ...(input.customer
          ? {
              customerId: input.customer.id,
              customerSnapshot: json({
                ...(input.customer.snapshot ?? {}),
                // Recorded so the ticket and the receipt can say why no tax.
                taxExempt: Boolean(exemption?.exempt),
                taxExemptReason: exemption?.exempt ? exemption.reason : null,
              }),
              // Choosing a different customer sets the rate afresh, so moving
              // from an exempt customer back to an ordinary one re-applies tax.
              taxRate: exemption?.exempt ? 0 : session.taxRate,
            }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
        fulfilment: json(withStoreShipping(fulfilment, session.shippingFee)),
        ...(input.heldName !== undefined
          ? { heldName: input.heldName || null }
          : {}),
      },
    });
    await reprice(tx, cartId);
  });
  return getCart(session, cartId);
};

/**
 * Attach a platform credit to the cart, or take it off again.
 *
 * The till names a reference; what it is worth is the platform's answer. A
 * customer is required first and must be the one the credit belongs to - a
 * replacement credit is the value of that customer's own machine, and letting
 * it pay for somebody else's rental would be handing the shop's money away.
 */
export const applyCredit = async (
  session: StaffSession,
  cartId: string,
  reference: string | null,
) => {
  const cart = await ownedCart(session, cartId, ["OPEN", "HELD"]);

  if (reference === null) {
    await prisma.$transaction(async (tx) => {
      await tx.cart.update({
        where: { id: cartId },
        data: { creditTotal: 0, creditReference: null, creditLabel: null },
      });
      await reprice(tx, cartId);
    });
    return getCart(session, cartId);
  }

  const adapter = getAdapter(session.tenantId);
  if (!adapter.resolveCredit) {
    throw new ApiError("This platform does not issue credits", 400, "CREDIT_UNSUPPORTED");
  }

  const credit = await adapter.resolveCredit(session, reference);

  if (credit.customerId && cart.customerId && credit.customerId !== cart.customerId) {
    throw new ApiError(
      "That credit belongs to a different customer",
      409,
      "CREDIT_CUSTOMER_MISMATCH",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.cart.update({
      where: { id: cartId },
      data: {
        creditTotal: Math.max(0, credit.amount),
        creditReference: credit.reference,
        creditLabel: credit.label,
        // A credit carries its owner with it: the till would otherwise let the
        // operator ring the replacement up against whoever is standing there.
        ...(credit.customerId && !cart.customerId
          ? {
              customerId: credit.customerId,
              // Named, so the checkout shows a person rather than an id.
              customerSnapshot: json(credit.customer ?? { id: credit.customerId }),
            }
          : {}),
      },
    });
    await reprice(tx, cartId);
  });

  return getCart(session, cartId);
};

export const replacePayments = async (
  session: StaffSession,
  cartId: string,
  payments: Array<{ method: string; amount: number; reference?: string }>,
) => {
  await ownedCart(session, cartId, ["OPEN"]);
  await prisma.$transaction(async (tx) => {
    await tx.payment.deleteMany({ where: { cartId, status: "PENDING" } });
    if (payments.length)
      await tx.payment.createMany({
        data: payments.map((payment) => ({
          cartId,
          method: payment.method,
          amount: payment.amount,
          externalReference: payment.reference,
        })),
      });
  });
  return getCart(session, cartId);
};

/**
 * Whole months covered by a rental period, counted on calendar months rather
 * than on 30-day blocks - the platforms bill monthly, so "1 Jan to 1 Feb" is
 * one month whatever February happens to be worth in days.
 */
export const monthsBetween = (startIso: string, endIso: string): number => {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const whole =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) -
    (end.getUTCDate() < start.getUTCDate() ? 1 : 0);
  return Math.max(1, whole);
};

const requestHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const checkout = async (
  session: StaffSession,
  cartId: string,
  idempotencyKey: string,
  correlationId: string,
) => {
  const hash = requestHash({
    cartId,
    tenantId: session.tenantId,
    storeId: session.storeId,
  });
  const previous = await prisma.idempotencyRecord.findUnique({
    where: {
      tenantId_key: { tenantId: session.tenantId, key: idempotencyKey },
    },
  });
  if (previous) {
    if (previous.requestHash !== hash)
      throw new ApiError(
        "Idempotency key was already used for another request",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    return previous.response;
  }

  const cart = await ownedCart(session, cartId, ["OPEN"]);
  if (!cart.lines.length)
    throw new ApiError("Cart is empty", 422, "EMPTY_CART");
  if (!cart.customerId)
    throw new ApiError(
      "Choose a customer before checkout",
      422,
      "CUSTOMER_REQUIRED",
    );
  const paid = cart.payments.reduce(
    (sum, payment) => sum + number(payment.amount),
    0,
  );
  if (Math.round(paid * 100) !== Math.round(number(cart.grandTotal) * 100)) {
    throw new ApiError(
      "Payment total must equal the amount due",
      422,
      "PAYMENT_MISMATCH",
      { paid, due: number(cart.grandTotal) },
    );
  }

  const locked = await prisma.cart.updateMany({
    where: { id: cartId, status: "OPEN", version: cart.version },
    data: { status: "CHECKING_OUT", version: { increment: 1 } },
  });
  if (locked.count !== 1)
    throw new ApiError(
      "Cart changed; refresh and try again",
      409,
      "CART_VERSION_CONFLICT",
    );

  const payload: PlatformCheckout = {
    correlationId,
    storeId: session.storeId,
    userId: session.userId,
    kind: cart.kind,
    customerId: cart.customerId,
    lines: cart.lines.map((line) => ({
      productId: line.externalProductId,
      unitId: line.externalUnitId,
      serial: line.serial,
      quantity: line.quantity,
      unitPrice: number(line.unitPrice),
      feeAmount: number(line.feeAmount),
      depositAmount: number(line.depositAmount),
      // Snapshotted when the line was priced, so an attribute repriced
      // mid-transaction cannot change what the customer agreed to.
      attributes: lineAttributes(line.metadata).filter(
        (attribute) => attribute.selected !== false,
      ),
      rentalStart: line.rentalStart?.toISOString() ?? null,
      rentalEnd: line.rentalEnd?.toISOString() ?? null,
      rentalTenure: line.rentalTenure,
      warranty: chosenWarranty(line.metadata)
        ? {
            id: chosenWarranty(line.metadata)!.id,
            price: warrantyAmount(line),
          }
        : null,
      metadata: line.metadata as Record<string, unknown>,
    })),
    payments: cart.payments.map((payment) => ({
      method: payment.method,
      amount: number(payment.amount),
      reference: payment.externalReference,
    })),
    fulfilment: cart.fulfilment,
    notes: cart.notes,
    creditReference: cart.creditReference,
    totals: {
      subtotal: number(cart.subtotal),
      discount: number(cart.discountTotal),
      tax: number(cart.taxTotal),
      fees: number(cart.feeTotal),
      warranty:
        Math.round(
          cart.lines.reduce((total, line) => total + warrantyAmount(line), 0) * 100,
        ) / 100,
      shipping: shippingFromFulfilment(cart.fulfilment),
      deposit: number(cart.depositTotal),
      grandTotal: number(cart.grandTotal),
    },
  };

  let committed;
  try {
    committed = await getAdapter(session.tenantId).commitCheckout(
      session,
      payload,
    );
  } catch (error) {
    /**
     * ! An unknown outcome leaves the cart locked in CHECKING_OUT. Reopening
     * ! it invites the obvious next move - press checkout again - on a sale
     * ! the platform may already have invoiced and taken payment for. Held
     * ! locked, the operator has to look first, which is exactly right.
     */
    if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") {
      await prisma.auditEvent.create({
        data: {
          tenantId: session.tenantId,
          storeId: session.storeId,
          userId: session.userId,
          entityType: "cart",
          entityId: cartId,
          action: "checkout.outcome_unknown",
          correlationId,
          after: json(error.details ?? null),
        },
      });
      throw error;
    }
    await prisma.cart.updateMany({
      where: { id: cartId, status: "CHECKING_OUT" },
      data: { status: "OPEN", version: { increment: 1 } },
    });
    throw error;
  }

  const response = await prisma.$transaction(async (tx) => {
    const numberValue = committed.number ?? `POS-${Date.now()}`;
    const order = await tx.order.create({
      data: {
        number: `${session.tenantId.slice(0, 3).toUpperCase()}-${numberValue}`,
        tenantId: session.tenantId,
        storeId: session.storeId,
        userId: session.userId,
        kind: cart.kind,
        cartId,
        externalOrderId: committed.externalOrderId,
        customerId: cart.customerId,
        customerSnapshot: cart.customerSnapshot ?? undefined,
        currency: cart.currency,
        subtotal: cart.subtotal,
        discountTotal: cart.discountTotal,
        taxTotal: cart.taxTotal,
        feeTotal: cart.feeTotal,
        depositTotal: cart.depositTotal,
        grandTotal: cart.grandTotal,
        platformSnapshot: json(committed.snapshot),
        lines: {
          create: cart.lines.map((line) => ({
            externalProductId: line.externalProductId,
            externalUnitId: line.externalUnitId,
            sku: line.sku,
            serial: line.serial,
            name: line.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountAmount: line.discountAmount,
            feeAmount: line.feeAmount,
            depositAmount: line.depositAmount,
            taxAmount: line.taxAmount,
            lineTotal: line.lineTotal,
            rentalStart: line.rentalStart,
            rentalEnd: line.rentalEnd,
            rentalTenure: line.rentalTenure,
            snapshot: json(line.metadata),
          })),
        },
      },
    });
    await tx.cart.update({
      where: { id: cartId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await tx.cartLine.updateMany({
      where: { cartId },
      data: { reservationKey: null },
    });
    await tx.payment.updateMany({
      where: { cartId },
      data: { status: "CAPTURED" },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: session.tenantId,
        storeId: session.storeId,
        userId: session.userId,
        entityType: "order",
        entityId: order.id,
        action: "checkout.completed",
        correlationId,
        after: json({
          externalOrderId: committed.externalOrderId,
          grandTotal: number(cart.grandTotal),
        }),
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: session.tenantId,
        topic: "pos.order.completed",
        aggregateId: order.id,
        payload: json({
          orderId: order.id,
          externalOrderId: committed.externalOrderId,
        }),
      },
    });
    return {
      orderId: order.id,
      // Customer paperwork uses the platform's order/invoice number. The
      // tenant-prefixed value remains the shared service's internal key.
      number: committed.number ?? numberValue,
      externalOrderId: committed.externalOrderId,
      // Printed on the pickup slip; the platform may demand it at release.
      pickupCode: committed.pickupCode ?? null,
      platform: committed.snapshot,
    };
  });

  await prisma.idempotencyRecord.create({
    data: {
      tenantId: session.tenantId,
      key: idempotencyKey,
      requestHash: hash,
      statusCode: 201,
      response: json(response),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return response;
};
