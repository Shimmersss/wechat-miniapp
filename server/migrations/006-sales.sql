CREATE TABLE sales_orders (
 id CHAR(36) PRIMARY KEY, no VARCHAR(40) NOT NULL UNIQUE, seller_id CHAR(36) NOT NULL, pay_method VARCHAR(20) NOT NULL,
 customer VARCHAR(100) NOT NULL DEFAULT '', phone VARCHAR(30) NOT NULL DEFAULT '', remark VARCHAR(1000) NOT NULL DEFAULT '',
 amount DECIMAL(14,2) NOT NULL, cost_total DECIMAL(14,2) NOT NULL,
 request_key VARCHAR(80) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(seller_id) REFERENCES users(id), INDEX(created_at)
) ENGINE=InnoDB;
CREATE TABLE sales_items (
 id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, unit_id CHAR(36) NOT NULL, model_id VARCHAR(60) NOT NULL,
 name VARCHAR(100) NOT NULL, spec VARCHAR(300) NOT NULL, store VARCHAR(100) NOT NULL DEFAULT '',
 price DECIMAL(14,2) NOT NULL, cost DECIMAL(14,2) NOT NULL, price_version INT NOT NULL, channel VARCHAR(20) NOT NULL,
 FOREIGN KEY(order_id) REFERENCES sales_orders(id), FOREIGN KEY(unit_id) REFERENCES units(id), UNIQUE(order_id,unit_id), INDEX(unit_id)
) ENGINE=InnoDB;
CREATE TABLE sales_refunds (
 id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, operator_id CHAR(36) NOT NULL, reason VARCHAR(500) NOT NULL,
 kind ENUM('return','adjustment') NOT NULL, amount DECIMAL(14,2) NOT NULL,
 request_key VARCHAR(80) NOT NULL UNIQUE, request_hash CHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(order_id) REFERENCES sales_orders(id), FOREIGN KEY(operator_id) REFERENCES users(id), INDEX(created_at)
) ENGINE=InnoDB;
CREATE TABLE sales_refund_items (
 refund_id CHAR(36) NOT NULL, sale_item_id CHAR(36) NOT NULL, amount DECIMAL(14,2) NOT NULL, cost_reversal DECIMAL(14,2) NOT NULL,
 PRIMARY KEY(refund_id,sale_item_id), FOREIGN KEY(refund_id) REFERENCES sales_refunds(id), FOREIGN KEY(sale_item_id) REFERENCES sales_items(id)
) ENGINE=InnoDB;
