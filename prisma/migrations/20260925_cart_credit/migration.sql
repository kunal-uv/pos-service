-- A credit the platform already holds for the customer, spent against a cart.
--
-- Rent Buddy issues one when a machine is handed back over the counter for a
-- replacement; the till names the reference and the platform decides what it is
-- worth. Additive and rerunnable, like the rest of this ledger.

ALTER TABLE "Cart" ADD COLUMN IF NOT EXISTS "creditTotal" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "Cart" ADD COLUMN IF NOT EXISTS "creditReference" TEXT;
ALTER TABLE "Cart" ADD COLUMN IF NOT EXISTS "creditLabel" TEXT;
