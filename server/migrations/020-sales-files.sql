CREATE TABLE sales_files (
 order_id CHAR(36) NOT NULL, file_id CHAR(36) NOT NULL, added_by CHAR(36) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(order_id,file_id), UNIQUE(file_id),
 FOREIGN KEY(order_id) REFERENCES sales_orders(id), FOREIGN KEY(file_id) REFERENCES files(id), FOREIGN KEY(added_by) REFERENCES users(id)
) ENGINE=InnoDB;
