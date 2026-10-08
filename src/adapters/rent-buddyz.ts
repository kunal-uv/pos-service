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
	PlatformCredit,
	StaffSession,
} from "../types.js";

export class RentBuddyzAdapter implements PlatformAdapter {
	readonly tenantId = "rent-buddyz" as const;
	private readonly baseUrl = config.RENT_BUDDY_API_URL.replace(/\/$/, "");

	/**
	 * Rent Buddyz verifies the raw `Authorization` header value, so the token
	 * goes over without a "Bearer " prefix. Sending one makes every call to this
	 * platform fail as "Invalid Token", which the till shows as a session
	 * expiry and a bounce back to the login screen.
	 */
	private request<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
		return upstreamRequest<T>(url, token, init, { scheme: "raw" });
	}

	async authenticate(token: string, storeId: string): Promise<StaffSession> {
		const data = await this.request<Omit<StaffSession, "tenantId" | "storeId" | "token">>(
			withQuery(`${this.baseUrl}/admin/pos/session`, { store_id: storeId }),
			token,
		);
		return { ...data, tenantId: this.tenantId, storeId, token };
	}

	async listCatalog(session: StaffSession, query: CatalogQuery): Promise<Page<CatalogProduct>> {
		return this.request<Page<CatalogProduct>>(
			withQuery(`${this.baseUrl}/admin/pos/catalog`, {
				store_id: session.storeId,
				search: query.search,
				category_id: query.categoryId,
				page_size: query.pageSize,
				page_offset: query.pageOffset,
			}),
			session.token,
		);
	}

	async listUnits(session: StaffSession, productId: string): Promise<InventoryUnit[]> {
		return this.request<InventoryUnit[]>(
			withQuery(`${this.baseUrl}/admin/pos/products/${encodeURIComponent(productId)}/units`, { store_id: session.storeId }),
			session.token,
		);
	}

	async resolveSellable(
		session: StaffSession,
		input: { productId: string; unitId?: string },
	): Promise<{ product: CatalogProduct; unit: InventoryUnit | null }> {
		const data = await this.request<{ product: CatalogProduct; units: InventoryUnit[] }>(
			withQuery(`${this.baseUrl}/admin/pos/products/${encodeURIComponent(input.productId)}`, { store_id: session.storeId }),
			session.token,
		);
		const unit = input.unitId ? data.units.find((candidate) => candidate.id === input.unitId) ?? null : null;
		if (input.unitId && !unit) throw new ApiError("That rental unit is no longer available", 409, "UNIT_UNAVAILABLE");
		return { product: data.product, unit };
	}

	async searchCustomers(session: StaffSession, search: string): Promise<CustomerSummary[]> {
		return this.request<CustomerSummary[]>(
			withQuery(`${this.baseUrl}/admin/pos/customers`, { store_id: session.storeId, search }),
			session.token,
		);
	}

	async getCustomerAddresses(session: StaffSession, customerId: string): Promise<CustomerAddress[]> {
		return this.request<CustomerAddress[]>(
			withQuery(`${this.baseUrl}/admin/pos/customers/${encodeURIComponent(customerId)}/addresses`, {
				store_id: session.storeId,
			}),
			session.token,
		);
	}

	async createCustomer(session: StaffSession, input: Record<string, unknown>): Promise<CustomerSummary> {
		return this.request<CustomerSummary>(
			withQuery(`${this.baseUrl}/admin/pos/customers`, { store_id: session.storeId }),
			session.token,
			{ method: "POST", body: JSON.stringify(input) },
		);
	}

	async sendCustomerEmailCode(session: StaffSession, email: string): Promise<void> {
		await this.request<unknown>(
			withQuery(`${this.baseUrl}/admin/pos/customers/email-code`, { store_id: session.storeId }),
			session.token,
			{ method: "POST", body: JSON.stringify({ email }) },
		);
	}

	async verifyCustomerEmailCode(session: StaffSession, email: string, code: string): Promise<void> {
		await this.request<unknown>(
			withQuery(`${this.baseUrl}/admin/pos/customers/email-verify`, { store_id: session.storeId }),
			session.token,
			{ method: "POST", body: JSON.stringify({ email, code }) },
		);
	}

	/**
	 * A replacement credit, as Rent Buddy recorded it when the old machine came
	 * back over the counter. One that has already been spent is not returned at
	 * all, so a stale link in the browser cannot discount a second sale.
	 */
	async resolveCredit(session: StaffSession, reference: string): Promise<PlatformCredit> {
		return this.request<PlatformCredit>(
			withQuery(`${this.baseUrl}/admin/pos/credit/${encodeURIComponent(reference)}`, {
				store_id: session.storeId,
			}),
			session.token,
		);
	}

	async commitCheckout(session: StaffSession, checkout: PlatformCheckout): Promise<PlatformCheckoutResult> {
		return this.request<PlatformCheckoutResult>(
			withQuery(`${this.baseUrl}/admin/pos/checkout`, { store_id: session.storeId }),
			session.token,
			{ method: "POST", body: JSON.stringify(checkout) },
		);
	}
}
