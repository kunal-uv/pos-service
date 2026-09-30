import { ApiError } from "../errors.js";
import type { PlatformAdapter, TenantId } from "../types.js";
import { ApplianceOutletAdapter } from "./appliance-outlet.js";
import { RentBuddyzAdapter } from "./rent-buddyz.js";

const adapters: Record<TenantId, PlatformAdapter> = {
	"appliance-outlet": new ApplianceOutletAdapter(),
	"rent-buddyz": new RentBuddyzAdapter(),
};

export const getAdapter = (tenantId: string): PlatformAdapter => {
	const adapter = adapters[tenantId as TenantId];
	if (!adapter) throw new ApiError("Unknown POS tenant", 400, "INVALID_TENANT");
	return adapter;
};
