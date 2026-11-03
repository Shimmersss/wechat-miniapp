ALTER TABLE repair_files MODIFY purpose ENUM('appearance','pickup','payment','expense') NOT NULL;
UPDATE repair_files f SET purpose='expense' WHERE purpose='payment' AND EXISTS (SELECT 1 FROM repair_payments p WHERE p.order_id=f.order_id AND p.kind IN ('expense','expense_refund'));
