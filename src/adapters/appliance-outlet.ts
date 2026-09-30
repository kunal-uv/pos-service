import { config } from "../config.js";
import { ApiError } from "../errors.js";
import { upstreamRequest, withQuery } from "../http.js";
import type {
  CatalogProduct,
  CatalogQuery,
  CustomerAddress,
  CustomerSummary,
  InventoryUnit,
  Page,
  PlatformAdapter,
  PlatformCheckout,
  PlatformCheckoutResult,
  StaffSession,
} from "../types.js";

const money = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

interface AoSessionResponse {
  user_id: string;
  role_id: string | null;
  name: string | null;
  permissions: string[];
  currency?: string;
  tax_rate?: number;
}

export class ApplianceOutletAdapter implements PlatformAdapter {
  readonly tenantId = "appliance-outlet" as const;
  private readonly baseUrl = config.AO_API_URL.replace(/\/$/, "");

  /**
   * AO says "your session is over" with 420, not 401 - and its admin logs the
   * operator out on 420, 498 and 499 alike. Declared here so the till does
   * the same instead of printing "jwt expired" and waiting.
   */
  private request<T>(
    url: string,
    token: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<T> {
    return upstreamRequest<T>(url, token, init, {
      sessionExpiredStatuses: [401, 420, 498, 499],
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  async authenticate(token: string, storeId: string): Promise<StaffSession> {
    const data = await this.request<AoSessionResponse>(
      withQuery(`${this.baseUrl}/pos/session`, { location: storeId }),
      token,
    );
    return {
      tenantId: this.tenantId,
      storeId,
      userId: data.user_id,
      roleId: data.role_id,
      displayName: data.name,
      permissions: data.permissions,
      currency: data.currency ?? "USD",
      taxRate: money(data.tax_rate),
      token,
      capabilities: {
        transactionKinds: ["SALE"],
        serializedInventory: true,
        rentalDates: false,
        securityDeposits: false,
        holds: true,
        splitPayments: true,
        signature: true,
        fulfilment: ["PICKUP", "DELIVERY"],
      },
    };
  }

  private categoryLabels: { at: number; labels: Map<string, string> } | null =
    null;

  /**
   * A name for every category that cannot be mistaken for another.
   *
   * ! AO's categories are a tree and its leaf names repeat: "Electric" is a
   * ! cooktop, a freestanding range, a slide-in range and a dryer. The product
   * ! rows carry only the leaf, so the rail showed "Electric" four times with
   * ! nothing to say which was which. Each label is the leaf with as many
   * ! ancestors prepended as it takes to be unique - "Dryer > Electric",
   * ! "Slide In > Electric" - which keeps the rail short where it can be.
   *
   * Cached for five minutes: the tree changes when someone edits categories,
   * not between one search and the next.
   */
  private async labelCategories(
    session: StaffSession,
  ): Promise<Map<string, string>> {
    if (
      this.categoryLabels &&
      Date.now() - this.categoryLabels.at < 5 * 60 * 1000
    ) {
      return this.categoryLabels.labels;
    }
    type Node = {
      category_id: string | number;
      name: string;
      children?: Node[];
    };
    const data = await this.request<{ categories: Node[] }>(
      withQuery(`${this.baseUrl}/category`, {
        tree: "true",
        location: session.storeId,
      }),
      session.token,
    );
    const paths = new Map<string, string[]>();
    const walk = (node: Node, trail: string[]) => {
      const path = [...trail, String(node.name)];
      paths.set(String(node.category_id), path);
      for (const child of node.children ?? []) walk(child, path);
    };
    for (const root of data.categories ?? []) walk(root, []);

    const depth = new Map([...paths.keys()].map((id) => [id, 1]));
    const labelOf = (id: string) =>
      (paths.get(id) ?? []).slice(-(depth.get(id) ?? 1)).join(" > ");
    for (let guard = 0; guard < 8; guard += 1) {
      const byLabel = new Map<string, string[]>();
      for (const id of paths.keys())
        byLabel.set(labelOf(id), [...(byLabel.get(labelOf(id)) ?? []), id]);
      let widened = false;
      for (const ids of byLabel.values()) {
        if (ids.length < 2) continue;
        for (const id of ids) {
          if ((depth.get(id) ?? 1) < (paths.get(id)?.length ?? 1)) {
            depth.set(id, (depth.get(id) ?? 1) + 1);
            widened = true;
          }
        }
      }
      if (!widened) break;
    }

    const labels = new Map([...paths.keys()].map((id) => [id, labelOf(id)]));
    this.categoryLabels = { at: Date.now(), labels };
    return labels;
  }

  async listCatalog(
    session: StaffSession,
    query: CatalogQuery,
  ): Promise<Page<CatalogProduct>> {
    // The catalogue must not fail because the tree could not be read; the
    // leaf names are worse but still usable.
    const categoryLabels = await this.labelCategories(session).catch(
      () => new Map<string, string>(),
    );
    const data = await this.request<{
      products: Array<Record<string, unknown>>;
      products_count: number;
    }>(
      withQuery(`${this.baseUrl}/pos/products`, {
        location: session.storeId,
        search: query.search,
        category_id: query.categoryId,
        page_size: query.pageSize,
        page_offset: query.pageOffset,
      }),
      session.token,
    );

    return {
      items: data.products.map((product) => {
        const category = product.category as {
          category_id: string;
          name: string;
        } | null;
        const images = Array.isArray(product.images) ? product.images : [];
        return {
          id: String(product.product_id),
          name: String(product.name ?? ""),
          sku: product.model_number ? String(product.model_number) : null,
          imageUrl: images[0] ? String(images[0]) : null,
          category: category
            ? {
                id: String(category.category_id),
                name:
                  categoryLabels.get(String(category.category_id)) ??
                  category.name,
              }
            : null,
          availableCount: money(product.available_count),
          price: money(product.from_price),
          originalPrice: product.msrp == null ? null : money(product.msrp),
          deposit: 0,
          currency: session.currency,
          metadata: {
            brand: product.brand ?? null,
            gradeChips: product.grade_chips ?? [],
          },
        };
      }),
      total: data.products_count,
      pageSize: query.pageSize,
      pageOffset: query.pageOffset,
    };
  }

  async listUnits(
    session: StaffSession,
    productId: string,
  ): Promise<InventoryUnit[]> {
    const data = await this.request<{
      product: { product_id: string; model_number: string; name: string };
      units: Array<Record<string, unknown>>;
    }>(
      withQuery(
        `${this.baseUrl}/pos/products/${encodeURIComponent(productId)}/units`,
        { location: session.storeId },
      ),
      session.token,
    );
    return data.units.map((unit) => ({
      id: String(unit.inventory_unit_id),
      productId,
      serial: String(unit.serial),
      status: "AVAILABLE",
      price: money(unit.effective_price),
      originalPrice: unit.tag_price == null ? null : money(unit.tag_price),
      deposit: 0,
      metadata: {
        productName: data.product.name,
        sku: data.product.model_number,
        grade: unit.grade,
        gradeLabel: unit.grade_label,
        conditionNote: unit.condition_note,
        markdown: unit.markdown,
      },
    }));
  }

  async resolveSellable(
    session: StaffSession,
    input: { productId: string; unitId?: string },
  ): Promise<{ product: CatalogProduct; unit: InventoryUnit | null }> {
    const units = await this.listUnits(session, input.productId);
    const unit = units.find((candidate) => candidate.id === input.unitId);
    if (!unit)
      throw new ApiError(
        "That serialized unit is no longer available",
        409,
        "UNIT_UNAVAILABLE",
      );
    return {
      product: {
        id: input.productId,
        name: String(unit.metadata.productName ?? "Product"),
        sku: unit.metadata.sku ? String(unit.metadata.sku) : null,
        imageUrl: null,
        category: null,
        availableCount: units.length,
        price: unit.price,
        originalPrice: unit.originalPrice,
        deposit: 0,
        currency: session.currency,
        metadata: {},
      },
      unit,
    };
  }

  async searchCustomers(
    session: StaffSession,
    search: string,
  ): Promise<CustomerSummary[]> {
    const data = await this.request<{
      customers: Array<Record<string, unknown>>;
    }>(
      withQuery(`${this.baseUrl}/customers`, {
        location: session.storeId,
        q: search,
        pageSize: 20,
        pageOffset: 0,
      }),
      session.token,
    );
    return data.customers.map((customer) => ({
      id: String(customer.customer_id),
      name: String(
        customer.name ??
          `${customer.first_name ?? ""} ${customer.last_name ?? ""}`,
      ).trim(),
      email: customer.email ? String(customer.email) : null,
      phone: customer.phone ? String(customer.phone) : null,
    }));
  }

  /**
   * AO's exemption rule, mirrored from `nca-crm-api/src/services/tax/exemption.ts`
   * (`resolveTaxExemption`): an explicitly tax-exempt customer, or a reseller
   * who holds a permit number. A reseller flag without a permit is taxed.
   *
   * ! AO applies this at checkout and will not invoice the tax - but it accepts
   * ! a tender above the total without complaint. A till that ignored it
   * ! charged these customers 9.1% that AO then kept as an unrefunded
   * ! overpayment.
   */
  async resolveCustomerTax(
    session: StaffSession,
    customerId: string,
  ): Promise<{ exempt: boolean; reason: string | null }> {
    const data = await this.request<{ customer: Record<string, unknown> }>(
      withQuery(`${this.baseUrl}/customers/${encodeURIComponent(customerId)}`, {
        location: session.storeId,
      }),
      session.token,
    );
    const customer = data.customer ?? {};
    if (customer.is_tax_exempt === true) {
      return {
        exempt: true,
        reason:
          String(customer.tax_exempt_reason ?? "").trim() ||
          "Tax-exempt customer",
      };
    }
    const permit = String(customer.reseller_permit_number ?? "").trim();
    if (customer.is_reseller === true && permit) {
      return { exempt: true, reason: `Reseller - WA permit ${permit}` };
    }
    return { exempt: false, reason: null };
  }

  async getCustomerAddresses(
    session: StaffSession,
    customerId: string,
  ): Promise<CustomerAddress[]> {
    const data = await this.request<{
      addresses: Array<Record<string, unknown>>;
    }>(
      withQuery(
        `${this.baseUrl}/pos/customers/${encodeURIComponent(customerId)}/addresses`,
        {
          location: session.storeId,
        },
      ),
      session.token,
    );
    return data.addresses.map((address) => ({
      id: String(address.customer_address_id),
      line1: String(address.street ?? ""),
      line2: "",
      city: String(address.city ?? ""),
      state: String(address.region ?? ""),
      postalCode: String(address.postal ?? ""),
      country: "United States",
      countryCode: "US",
    }));
  }

  async createCustomer(
    session: StaffSession,
    input: Record<string, unknown>,
  ): Promise<CustomerSummary> {
    const fullName = String(input.name ?? "").trim();
    const [firstName, ...lastParts] = fullName.split(/\s+/);
    const data = await this.request<{ customer: Record<string, unknown> }>(
      withQuery(`${this.baseUrl}/customers`, { location: session.storeId }),
      session.token,
      {
        method: "POST",
        body: JSON.stringify({
          name: fullName,
          first_name: firstName,
          last_name: lastParts.join(" "),
          email: input.email,
          phone: input.phone,
        }),
      },
    );
    const customer = data.customer;
    return {
      id: String(customer.customer_id),
      name: String(
        customer.name ??
          `${customer.first_name ?? ""} ${customer.last_name ?? ""}`,
      ).trim(),
      email: customer.email ? String(customer.email) : null,
      phone: customer.phone ? String(customer.phone) : null,
    };
  }

  /**
   * AO keeps one open cart per operator and `POST /pos/checkout` invoices that
   * whole draft. Anything already sitting on it was put there by AO's own till,
   * so borrowing the draft would sell lines this POS never priced. An empty
   * draft is reused rather than orphaned; a draft with anything on it is
   * refused, because only the operator can say which sale it belongs to.
   */
  private async claimCart(session: StaffSession): Promise<string | null> {
    const current = await this.request<{
      cart: {
        cart_draft_id: string;
        lines?: unknown[];
        payments?: unknown[];
      } | null;
    }>(
      withQuery(`${this.baseUrl}/pos/cart`, { location: session.storeId }),
      session.token,
    );

    if (!current.cart) return null;
    const used =
      (current.cart.lines?.length ?? 0) > 0 ||
      (current.cart.payments?.length ?? 0) > 0;
    if (used) {
      throw new ApiError(
        "This till already has an open Appliance Outlet cart. Finish or clear that sale before checking out here.",
        409,
        "PLATFORM_CART_IN_USE",
      );
    }
    return current.cart.cart_draft_id;
  }

  /**
   * Adding a line reserves the unit inside AO. Leaving those reservations
   * behind after a failed commit is what makes a retry impossible: AO reports
   * its own held unit as "in another till's cart" and nothing in this service
   * can release it.
   */
  private async releaseLines(
    session: StaffSession,
    lineIds: string[],
  ): Promise<void> {
    for (const lineId of lineIds.reverse()) {
      try {
        await this.request(
          withQuery(
            `${this.baseUrl}/pos/cart/lines/${encodeURIComponent(lineId)}`,
            { location: session.storeId },
          ),
          session.token,
          { method: "DELETE" },
        );
      } catch (error) {
        console.error(
          "Failed to release an AO cart line after a checkout failure",
          lineId,
          error,
        );
      }
    }
  }

  async commitCheckout(
    session: StaffSession,
    checkout: PlatformCheckout,
  ): Promise<PlatformCheckoutResult> {
    if (checkout.kind !== "SALE")
      throw new ApiError(
        "AO accepts sale transactions only",
        422,
        "UNSUPPORTED_TRANSACTION",
      );
    if (!checkout.lines.length)
      throw new ApiError("Cart is empty", 422, "EMPTY_CART");
    for (const line of checkout.lines) {
      if (!line.unitId)
        throw new ApiError(
          "AO checkout requires a serialized unit",
          422,
          "UNIT_REQUIRED",
        );
    }

    const addedLineIds: string[] = [];
    try {
      return await this.commitToCart(
        session,
        checkout,
        await this.claimCart(session),
        addedLineIds,
      );
    } catch (error) {
      // Nothing is released when the outcome is unknown: those lines may
      // already be on an invoice, and deleting them is not ours to decide.
      if (
        !(error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN")
      ) {
        await this.releaseLines(session, addedLineIds);
      }
      throw error;
    }
  }

  private async commitToCart(
    session: StaffSession,
    checkout: PlatformCheckout,
    startingCartId: string | null,
    addedLineIds: string[],
  ): Promise<PlatformCheckoutResult> {
    let aoCartId = startingCartId;
    for (const line of checkout.lines) {
      const added = await this.request<{
        cart_draft_id: string;
        line: { cart_draft_line_id: string };
      }>(
        withQuery(`${this.baseUrl}/pos/cart/lines`, {
          location: session.storeId,
        }),
        session.token,
        {
          method: "POST",
          body: JSON.stringify({
            cart_draft_id: aoCartId ?? undefined,
            inventory_unit_id: line.unitId,
            selling_price: line.unitPrice.toFixed(2),
          }),
        },
      );
      aoCartId = added.cart_draft_id;
      if (added.line?.cart_draft_line_id) {
        addedLineIds.push(added.line.cart_draft_line_id);
        const additionalNote =
          typeof line.metadata?.additionalNote === "string"
            ? line.metadata.additionalNote.trim()
            : "";
        if (additionalNote) {
          await this.request(
            withQuery(
              `${this.baseUrl}/pos/cart/lines/${added.line.cart_draft_line_id}`,
              { location: session.storeId },
            ),
            session.token,
            {
              method: "PATCH",
              body: JSON.stringify({ additional_note: additionalNote }),
            },
          );
        }
      }
    }

    if (!aoCartId) throw new ApiError("Cart is empty", 422, "EMPTY_CART");
    const fulfilment = (checkout.fulfilment ?? {}) as Record<string, unknown>;
    let shipAddressId: string | undefined;
    if (fulfilment.method === "delivery") {
      if (!checkout.customerId)
        throw new ApiError("A customer is required", 422, "CUSTOMER_REQUIRED");
      const address = fulfilment.shippingAddress as
        | Record<string, unknown>
        | undefined;
      if (!address)
        throw new ApiError(
          "A delivery address is required",
          422,
          "DELIVERY_ADDRESS_REQUIRED",
        );
      const saved = await this.request<{
        address: { customer_address_id: string };
      }>(
        withQuery(
          `${this.baseUrl}/pos/customers/${encodeURIComponent(checkout.customerId)}/addresses`,
          {
            location: session.storeId,
          },
        ),
        session.token,
        {
          method: "POST",
          body: JSON.stringify({
            street: [address.line1, address.line2].filter(Boolean).join(", "),
            city: address.city,
            region: address.state,
            postal: address.postalCode,
            label: "POS delivery",
          }),
        },
      );
      shipAddressId = saved.address.customer_address_id;
    }
    const patch = {
      ...(typeof fulfilment.cart === "object" && fulfilment.cart
        ? fulfilment.cart
        : {}),
      customer_id: checkout.customerId,
      ...(shipAddressId ? { ship_address_id: shipAddressId } : {}),
      order_note: checkout.notes ?? undefined,
      payments: checkout.payments.map((payment) => ({
        payment_type: payment.method,
        amount: payment.amount.toFixed(2),
      })),
    };
    await this.request(
      withQuery(`${this.baseUrl}/pos/cart/${aoCartId}`, {
        location: session.storeId,
      }),
      session.token,
      { method: "PATCH", body: JSON.stringify(patch) },
    );

    const signatureData =
      typeof fulfilment.signatureData === "string"
        ? fulfilment.signatureData
        : null;
    if (!signatureData)
      throw new ApiError(
        "AO checkout requires the customer signature",
        422,
        "SIGNATURE_REQUIRED",
      );
    const marketingConsent = fulfilment.marketingConsent === true;
    await this.request(
      withQuery(`${this.baseUrl}/pos/cart/${aoCartId}/signature`, {
        location: session.storeId,
      }),
      session.token,
      {
        method: "POST",
        body: JSON.stringify({
          signature_data: signatureData,
          marketing_consent: marketingConsent,
        }),
      },
    );

    /**
     * ! The one irreversible call, given its own long timeout.
     *
     * ! AO's checkout handler was measured at ~8.3s end to end against the
     * ! dev database - more than half the 15s default. Timing out here does
     * ! not stop AO: it goes on to write the invoice and take the units, while
     * ! this side reports failure and releases lines that are already sold.
     * ! Waiting longer costs a slow till; abandoning costs a paid invoice the
     * ! POS knows nothing about.
     */
    let result: {
      invoice: { invoice_id: string };
      document: Record<string, unknown>;
    };
    try {
      result = await this.request<{
        invoice: { invoice_id: string };
        document: Record<string, unknown>;
      }>(
        withQuery(`${this.baseUrl}/pos/checkout`, {
          location: session.storeId,
        }),
        session.token,
        { method: "POST", body: JSON.stringify({ cart_draft_id: aoCartId }) },
        90_000,
      );
    } catch (error) {
      // No HTTP answer at all - a timeout or a dropped connection - is the
      // only ambiguous case. AO's checkout is one transaction, so an actual
      // error response means nothing was written and the cart can reopen.
      if (
        error instanceof ApiError &&
        (error.code === "UPSTREAM_TIMEOUT" ||
          error.code === "UPSTREAM_UNAVAILABLE")
      ) {
        throw new ApiError(
          "Appliance Outlet did not confirm the sale in time. It may still have been invoiced - check AO's invoices for this customer before taking payment again.",
          504,
          "COMMIT_OUTCOME_UNKNOWN",
          { platformCartId: aoCartId },
        );
      }
      throw error;
    }
    const pickupCode = (
      result.document as { pickup_code?: unknown } | undefined
    )?.pickup_code;
    return {
      externalOrderId: result.invoice.invoice_id,
      pickupCode:
        pickupCode === undefined || pickupCode === null || pickupCode === ""
          ? null
          : String(pickupCode),
      number: result.invoice.invoice_id,
      snapshot: { invoice: result.invoice, document: result.document },
    };
  }
}
