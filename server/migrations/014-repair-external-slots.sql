CREATE TABLE repair_external_slots (
 identifier VARCHAR(80) PRIMARY KEY, order_id CHAR(36) NOT NULL UNIQUE, FOREIGN KEY(order_id) REFERENCES repair_orders(id)
) ENGINE=InnoDB;
