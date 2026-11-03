CREATE TABLE repair_orders (
 id CHAR(36) PRIMARY KEY, no VARCHAR(40) NOT NULL UNIQUE, kind ENUM('external','inventory') NOT NULL,
 unit_id CHAR(36) NULL, model VARCHAR(120) NOT NULL, identifier VARCHAR(80) NOT NULL DEFAULT '',
 customer VARCHAR(100) NOT NULL DEFAULT '', phone VARCHAR(30) NOT NULL DEFAULT '', fault VARCHAR(2000) NOT NULL,
 engineer_id CHAR(36) NULL, expected_date DATE NULL, status VARCHAR(24) NOT NULL DEFAULT 'pending_check', version INT NOT NULL DEFAULT 1,
 diagnosis VARCHAR(2000) NOT NULL DEFAULT '', waiting_parts BOOLEAN NOT NULL DEFAULT FALSE,
 quote DECIMAL(14,2) NULL, quote_version INT NOT NULL DEFAULT 0, confirmed_version INT NULL,
 warranty_days INT NULL, pickup_name VARCHAR(100) NOT NULL DEFAULT '', completed_at DATETIME(3) NULL,
 request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL, creator_id CHAR(36) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE(creator_id,request_key), FOREIGN KEY(unit_id) REFERENCES units(id), FOREIGN KEY(engineer_id) REFERENCES users(id), FOREIGN KEY(creator_id) REFERENCES users(id),
 INDEX(status,expected_date), INDEX(engineer_id,status), INDEX(unit_id,status)
) ENGINE=InnoDB;
CREATE TABLE repair_events (
 id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, actor_id CHAR(36) NOT NULL, action VARCHAR(40) NOT NULL,
 from_status VARCHAR(24) NOT NULL, to_status VARCHAR(24) NOT NULL, version INT NOT NULL, note VARCHAR(1000) NOT NULL,
 public_data JSON NOT NULL, internal_data JSON NULL, request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(order_id,request_key), FOREIGN KEY(order_id) REFERENCES repair_orders(id), FOREIGN KEY(actor_id) REFERENCES users(id), INDEX(order_id,version)
) ENGINE=InnoDB;
CREATE TABLE repair_files (
 order_id CHAR(36) NOT NULL, file_id CHAR(36) NOT NULL, purpose ENUM('appearance','pickup','payment') NOT NULL,
 position INT NOT NULL, PRIMARY KEY(order_id,file_id,purpose), FOREIGN KEY(order_id) REFERENCES repair_orders(id), FOREIGN KEY(file_id) REFERENCES files(id)
) ENGINE=InnoDB;
CREATE TABLE repair_parts (
 id CHAR(36) PRIMARY KEY, sku VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, unit VARCHAR(20) NOT NULL DEFAULT '件',
 quantity INT NOT NULL DEFAULT 0, stock_value DECIMAL(14,2) NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1,
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE repair_part_ledger (
 id CHAR(36) PRIMARY KEY, part_id CHAR(36) NOT NULL, order_id CHAR(36) NULL, issue_id CHAR(36) NULL,
 kind ENUM('receive','issue','return') NOT NULL, quantity INT NOT NULL, cost_amount DECIMAL(14,2) NOT NULL,
 actor_id CHAR(36) NOT NULL, reason VARCHAR(500) NOT NULL, request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(actor_id,request_key), FOREIGN KEY(part_id) REFERENCES repair_parts(id),
 FOREIGN KEY(order_id) REFERENCES repair_orders(id), FOREIGN KEY(actor_id) REFERENCES users(id), INDEX(part_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE repair_payments (
 id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, kind ENUM('receipt','refund','expense','expense_refund') NOT NULL,
 amount DECIMAL(14,2) NOT NULL, method VARCHAR(20) NOT NULL, actor_id CHAR(36) NOT NULL, reason VARCHAR(500) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES repair_orders(id), FOREIGN KEY(actor_id) REFERENCES users(id), INDEX(order_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE repair_cost_allocations (
 order_id CHAR(36) PRIMARY KEY, unit_id CHAR(36) NOT NULL, policy ENUM('capitalize','separate') NOT NULL,
 parts_cost DECIMAL(14,2) NOT NULL, expenses DECIMAL(14,2) NOT NULL, total_cost DECIMAL(14,2) NOT NULL,
 old_unit_cost DECIMAL(14,2) NOT NULL, new_unit_cost DECIMAL(14,2) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(order_id) REFERENCES repair_orders(id), FOREIGN KEY(unit_id) REFERENCES units(id)
) ENGINE=InnoDB;
UPDATE roles SET permissions=JSON_ARRAY_APPEND(permissions,'$','repair:assign','$','repair:cash','$','parts:manage') WHERE role_key IN ('boss','manager') AND NOT JSON_CONTAINS(permissions,JSON_QUOTE('repair:assign'));
UPDATE roles SET permissions=JSON_ARRAY_APPEND(permissions,'$','repair:cash') WHERE role_key='finance' AND NOT JSON_CONTAINS(permissions,JSON_QUOTE('repair:cash'));
UPDATE roles SET permissions=JSON_ARRAY_APPEND(permissions,'$','parts:manage') WHERE role_key='purchaser' AND NOT JSON_CONTAINS(permissions,JSON_QUOTE('parts:manage'));
