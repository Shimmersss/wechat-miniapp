CREATE TABLE agent_settings (
 id TINYINT PRIMARY KEY, default_markup_max DECIMAL(14,2) NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1,
 updated_by CHAR(36) NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;
INSERT INTO agent_settings(id) VALUES (1);
CREATE TABLE agents (
 user_id CHAR(36) PRIMARY KEY, status ENUM('pending','active','rejected','disabled') NOT NULL DEFAULT 'pending',
 name VARCHAR(100) NOT NULL, phone VARCHAR(30) NOT NULL, region VARCHAR(100) NOT NULL,
 inviter_id CHAR(36) NULL, invite_code CHAR(8) NULL UNIQUE, markup_max DECIMAL(14,2) NULL,
 review_remark VARCHAR(500) NOT NULL DEFAULT '', reviewed_by CHAR(36) NULL, reviewed_at DATETIME(3) NULL,
 applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), version INT NOT NULL DEFAULT 1,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(inviter_id) REFERENCES users(id), FOREIGN KEY(reviewed_by) REFERENCES users(id),
 INDEX(status,applied_at), INDEX(inviter_id)
) ENGINE=InnoDB;
CREATE TABLE agent_markups (
 agent_id CHAR(36) NOT NULL, unit_id CHAR(36) NOT NULL, markup DECIMAL(14,2) NOT NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(agent_id,unit_id),
 FOREIGN KEY(agent_id) REFERENCES users(id), FOREIGN KEY(unit_id) REFERENCES units(id)
) ENGINE=InnoDB;
ALTER TABLE share_items ADD COLUMN markup DECIMAL(14,2) NULL;
ALTER TABLE customer_requests MODIFY kind ENUM('consult','appointment','order') NOT NULL;
CREATE TABLE agent_orders (
 request_id CHAR(36) PRIMARY KEY, agent_id CHAR(36) NOT NULL, unit_id CHAR(36) NOT NULL, share_id VARCHAR(24) NOT NULL,
 agent_base DECIMAL(14,2) NOT NULL, markup DECIMAL(14,2) NOT NULL, share_price DECIMAL(14,2) NOT NULL, price_version INT NOT NULL,
 lock_expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(request_id) REFERENCES customer_requests(id), FOREIGN KEY(agent_id) REFERENCES users(id),
 FOREIGN KEY(unit_id) REFERENCES units(id), FOREIGN KEY(share_id) REFERENCES share_links(id), INDEX(agent_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE agent_order_states (
 request_id CHAR(36) PRIMARY KEY, status ENUM('locked','sold','released') NOT NULL DEFAULT 'locked',
 sale_order_id CHAR(36) NULL, release_reason VARCHAR(100) NOT NULL DEFAULT '', updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(request_id) REFERENCES agent_orders(request_id), FOREIGN KEY(sale_order_id) REFERENCES sales_orders(id), INDEX(status)
) ENGINE=InnoDB;
CREATE TABLE agent_unit_locks (
 unit_id CHAR(36) PRIMARY KEY, request_id CHAR(36) NOT NULL UNIQUE,
 FOREIGN KEY(unit_id) REFERENCES units(id), FOREIGN KEY(request_id) REFERENCES agent_orders(request_id)
) ENGINE=InnoDB;
CREATE TABLE agent_earnings (
 id CHAR(36) PRIMARY KEY, agent_id CHAR(36) NOT NULL, request_id CHAR(36) NOT NULL, sale_order_id CHAR(36) NOT NULL,
 kind ENUM('earning','reversal') NOT NULL, amount DECIMAL(14,2) NOT NULL, reversal_of CHAR(36) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(request_id,kind),
 FOREIGN KEY(agent_id) REFERENCES users(id), FOREIGN KEY(request_id) REFERENCES agent_orders(request_id),
 FOREIGN KEY(sale_order_id) REFERENCES sales_orders(id), INDEX(agent_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE agent_earning_states (
 earning_id CHAR(36) PRIMARY KEY, status ENUM('pending','settled','reversed') NOT NULL DEFAULT 'pending',
 settled_by CHAR(36) NULL, settled_at DATETIME(3) NULL, settle_reason VARCHAR(500) NOT NULL DEFAULT '',
 FOREIGN KEY(earning_id) REFERENCES agent_earnings(id), FOREIGN KEY(settled_by) REFERENCES users(id), INDEX(status)
) ENGINE=InnoDB;
