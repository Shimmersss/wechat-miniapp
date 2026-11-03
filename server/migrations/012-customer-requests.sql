CREATE TABLE customer_requests (
 id CHAR(36) PRIMARY KEY, owner_id CHAR(36) NOT NULL, kind ENUM('consult','appointment') NOT NULL,
 unit_id CHAR(36) NULL, unit_snapshot JSON NULL, content VARCHAR(2000) NOT NULL DEFAULT '',
 phone VARCHAR(30) NOT NULL, name VARCHAR(100) NOT NULL DEFAULT '', appointment_date DATE NULL, time_slot VARCHAR(60) NULL,
 source ENUM('natural','customer','peer','agent') NOT NULL, share_id VARCHAR(24) NULL, share_owner_id CHAR(36) NULL,
 request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(owner_id,request_key),
 FOREIGN KEY(owner_id) REFERENCES users(id), FOREIGN KEY(unit_id) REFERENCES units(id),
 FOREIGN KEY(share_id) REFERENCES share_links(id), FOREIGN KEY(share_owner_id) REFERENCES users(id),
 INDEX(created_at,kind), INDEX(share_owner_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE customer_request_states (
 request_id CHAR(36) PRIMARY KEY, status VARCHAR(20) NOT NULL DEFAULT 'new', version INT NOT NULL DEFAULT 1,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(request_id) REFERENCES customer_requests(id), INDEX(status,updated_at)
) ENGINE=InnoDB;
CREATE TABLE customer_request_events (
 id CHAR(36) PRIMARY KEY, request_id CHAR(36) NOT NULL, actor_id CHAR(36) NOT NULL, actor_kind ENUM('staff','customer') NOT NULL,
 from_status VARCHAR(20) NULL, to_status VARCHAR(20) NOT NULL, version INT NOT NULL,
 note VARCHAR(500) NOT NULL DEFAULT '', request_key VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(request_id,actor_id,request_key),
 FOREIGN KEY(request_id) REFERENCES customer_requests(id), FOREIGN KEY(actor_id) REFERENCES users(id), INDEX(request_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE sales_attributions (
 order_id CHAR(36) PRIMARY KEY, customer_request_id CHAR(36) NOT NULL UNIQUE, customer_id CHAR(36) NOT NULL,
 source VARCHAR(20) NOT NULL, share_id VARCHAR(24) NULL, share_owner_id CHAR(36) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES sales_orders(id),
 FOREIGN KEY(customer_request_id) REFERENCES customer_requests(id), FOREIGN KEY(customer_id) REFERENCES users(id),
 FOREIGN KEY(share_id) REFERENCES share_links(id), FOREIGN KEY(share_owner_id) REFERENCES users(id)
) ENGINE=InnoDB;
UPDATE roles SET permissions=JSON_ARRAY_APPEND(permissions,'$','consult:manage') WHERE role_key IN ('boss','manager','sales') AND NOT JSON_CONTAINS(permissions,JSON_QUOTE('consult:manage'));
