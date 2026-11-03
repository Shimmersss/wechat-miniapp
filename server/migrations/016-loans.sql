CREATE TABLE loan_orders (
 id CHAR(36) PRIMARY KEY, no VARCHAR(40) NOT NULL UNIQUE, type ENUM('loan_out','borrow_in') NOT NULL,
 counterparty VARCHAR(120) NOT NULL, phone VARCHAR(30) NOT NULL, due_date DATE NOT NULL, remark VARCHAR(2000) NOT NULL,
 creator_id CHAR(36) NOT NULL, request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(creator_id,request_key), FOREIGN KEY(creator_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE loan_states (
 order_id CHAR(36) PRIMARY KEY, status ENUM('active','returned_recheck','closed') NOT NULL DEFAULT 'active', version INT NOT NULL DEFAULT 1,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES loan_orders(id)
) ENGINE=InnoDB;
CREATE TABLE loan_items (
 id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, unit_id CHAR(36) NOT NULL, snapshot JSON NOT NULL,
 UNIQUE(order_id,unit_id), FOREIGN KEY(order_id) REFERENCES loan_orders(id), FOREIGN KEY(unit_id) REFERENCES units(id)
) ENGINE=InnoDB;
CREATE TABLE loan_item_states (
 item_id CHAR(36) PRIMARY KEY, status ENUM('active','returned_recheck','closed') NOT NULL DEFAULT 'active',
 returned_at DATETIME(3) NULL, inspection_version INT NULL, FOREIGN KEY(item_id) REFERENCES loan_items(id)
) ENGINE=InnoDB;
CREATE TABLE loan_active_units (
 unit_id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, FOREIGN KEY(unit_id) REFERENCES units(id), FOREIGN KEY(order_id) REFERENCES loan_orders(id)
) ENGINE=InnoDB;
CREATE TABLE loan_events (
 id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, actor_id CHAR(36) NOT NULL, action VARCHAR(30) NOT NULL,
 version INT NOT NULL, reason VARCHAR(500) NOT NULL, data JSON NOT NULL, request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(order_id,request_key), FOREIGN KEY(order_id) REFERENCES loan_orders(id), FOREIGN KEY(actor_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE loan_files (
 order_id CHAR(36) NOT NULL, file_id CHAR(36) NOT NULL, event_id CHAR(36) NOT NULL, PRIMARY KEY(order_id,file_id,event_id),
 FOREIGN KEY(order_id) REFERENCES loan_orders(id), FOREIGN KEY(file_id) REFERENCES files(id), FOREIGN KEY(event_id) REFERENCES loan_events(id)
) ENGINE=InnoDB;
