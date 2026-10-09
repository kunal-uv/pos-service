export const TENANTS = ["appliance-outlet", "rent-buddyz"] as const;
export type TenantId = (typeof TENANTS)[number];
export type TransactionKind = "SALE" | "RENTAL";

export interface StaffSession {
	tenantId: TenantId;
	storeId: string;
	userId: string;
	roleId: string | null;
	displayName: string | null;
	permissions: string[];
	currency: string;
	/** The combined rate every cart is priced with. */
	taxRate: number;
	/**
	 * The same rate itemised, as the platform has it configured (GST, PST, ...).
	 * Display only - pricing uses `taxRate`. Absent when the platform does not
	 * report a breakdown, in which case the till shows the combined rate alone.
	 */
	taxes?: { name: string; rate: number }[];
	/** Store-configured delivery charge. Zero/undefined means delivery is free. */
	shippingFee?: number;
	capabilities: PosCapabilities;
	/**
	 * The store's letterhead and terms, for the documents the till prints. The
	 * platform supplies whatever it actually holds; absent fields are simply not
	 * printed rather than guessed at.
	 */
	business?: {
		name: string;
		addressLines?: string[];
		phone?: string | null;
		website?: string | null;
		email?: string | null;
		registrationLabel?: string | null;
		registrationNumber?: string | null;
		terms?: string | null;
	} | null;
	token: string;
}

export interface PosCapabilities {
	transactionKinds: TransactionKind[];
	serializedInventory: boolean;
	rentalDates: boolean;
	securityDeposits: boolean;
	holds: boolean;
	splitPayments: boolean;
	signature: boolean;
	fulfilment: Array<"PICKUP" | "DELIVERY">;
}

export interface CatalogProduct {
	id: string;
	name: string;
	sku: string | null;
	imageUrl: string | null;
	category: { id: string; name: string } | null;
	availableCount: number;
	price: number;
	originalPrice: number | null;
	deposit: number;
	currency: string;
	metadata: Record<string, unknown>;
}

export interface InventoryUnit {
	id: string;
	productId: string;
	serial: string;
	status: string;
	price: number;
	originalPrice: number | null;
	deposit: number;
	metadata: Record<string, unknown>;
}

export interface CustomerSummary {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	metadata?: Record<string, unknown>;
}

export interface CustomerAddress {
	id: string;
	line1: string;
	line2: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	countryCode: string;
}

export interface CatalogQuery {
	search?: string;
	categoryId?: string;
	pageSize: number;
	pageOffset: number;
}

export interface Page<T> {
	items: T[];
	total: number | null;
	pageSize: number;
	pageOffset: number;
}

export interface PosLineAttribute {
	id: string;
	name: string;
	value: number;
	/** Billed with the rent every period, rather than once at the counter. */
	recurring: boolean;
	/** Optional store fees may be removed by the cashier before checkout. */
	optional?: boolean;
	/** False only when an optional fee was explicitly removed from this cart line. */
	selected?: boolean;
}

export interface PlatformCheckoutLine {
	productId: string;
	unitId: string | null;
	serial: string | null;
	quantity: number;
	/** The whole recurring charge for one period, add-ons included. */
	unitPrice: number;
	/** Non-recurring add-ons, charged once at the till. */
	feeAmount: number;
	depositAmount: number;
	/** Store attributes applied to this line, already split by `recurring`. */
	attributes: PosLineAttribute[];
	rentalStart: string | null;
	rentalEnd: string | null;
	rentalTenure: number | null;
	/** The warranty plan chosen for this line, and what it costs for the quantity on it. */
	warranty?: { id: string; price: number } | null;
	/** How this item goes out; null means the order's own method. */
	fulfilment?: "pickup" | "delivery" | null;
	metadata: Record<string, unknown>;
}

export interface PlatformCheckout {
	correlationId: string;
	storeId: string;
	userId: string;
	kind: TransactionKind;
	customerId: string | null;
	lines: PlatformCheckoutLine[];
	payments: Array<{ method: string; amount: number; reference: string | null }>;
	fulfilment: unknown;
	notes: string | null;
	/** The platform credit being spent, for the platform to verify and claim. */
	creditReference: string | null;
	totals: {
		subtotal: number;
		discount: number;
		tax: number;
		fees: number;
		/** Warranty plans on the sale, taxed with it. */
		warranty?: number;
		shipping: number;
		deposit: number;
		grandTotal: number;
	};
}

export interface PlatformCheckoutResult {
	externalOrderId: string;
	number: string | null;
	/**
	 * The code a customer shows to collect, when the platform issues one. AO
	 * requires it at release when its pickup-proof setting is on, so a pickup
	 * slip without it leaves the customer unable to collect what they paid for.
	 */
	pickupCode?: string | null;
	snapshot: Record<string, unknown>;
}

export interface PlatformAdapter {
	readonly tenantId: TenantId;
	authenticate(token: string, storeId: string): Promise<StaffSession>;
	listCatalog(session: StaffSession, query: CatalogQuery): Promise<Page<CatalogProduct>>;
	listUnits(session: StaffSession, productId: string): Promise<InventoryUnit[]>;
	resolveSellable(
		session: StaffSession,
		input: { productId: string; unitId?: string },
	): Promise<{ product: CatalogProduct; unit: InventoryUnit | null }>;
	searchCustomers(session: StaffSession, search: string): Promise<CustomerSummary[]>;
	getCustomerAddresses(session: StaffSession, customerId: string): Promise<CustomerAddress[]>;
	createCustomer(session: StaffSession, input: Record<string, unknown>): Promise<CustomerSummary>;
	/**
	 * Proving a new customer's email with an emailed code, for platforms whose
	 * New Customer form asks for it. Absent on a platform that does not.
	 */
	sendCustomerEmailCode?(session: StaffSession, email: string): Promise<void>;
	verifyCustomerEmailCode?(session: StaffSession, email: string, code: string): Promise<void>;
	commitCheckout(session: StaffSession, checkout: PlatformCheckout): Promise<PlatformCheckoutResult>;
	/**
	 * Whether this customer is exempt from sales tax, as the platform decides it.
	 *
	 * Optional: a platform that has no exemption concept leaves it out and every
	 * customer is taxed at the session rate. One that has it must implement it,
	 * or the till charges tax the platform will not invoice.
	 */
	resolveCustomerTax?(session: StaffSession, customerId: string): Promise<{ exempt: boolean; reason: string | null }>;
	/**
	 * What a credit the platform issued is worth, and whose it is.
	 *
	 * Optional: a platform with no credits leaves it out and the till never
	 * offers one. The amount is always the platform's answer, never a number
	 * the browser sent - a credit is money, and the till is not trusted with
	 * how much of it a customer has.
	 */
	resolveCredit?(session: StaffSession, reference: string): Promise<PlatformCredit>;
}

/** A credit the platform holds for a customer, as the till displays it. */
export interface PlatformCredit {
	reference: string;
	amount: number;
	label: string;
	/** The customer it belongs to; the till refuses to spend it on anyone else. */
	customerId: string | null;
	/** Enough of that customer for the till to name them on screen. */
	customer?: { id: string; name?: string | null; email?: string | null; phone?: string | null } | null;
}

declare global {
	namespace Express {
		interface Request {
			posSession?: StaffSession;
			correlationId: string;
		}
	}
}
