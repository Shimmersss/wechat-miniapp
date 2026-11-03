CREATE TABLE sales_order_locks (
 order_id CHAR(36) PRIMARY KEY, FOREIGN KEY(order_id) REFERENCES sales_orders(id)
) ENGINE=InnoDB;
