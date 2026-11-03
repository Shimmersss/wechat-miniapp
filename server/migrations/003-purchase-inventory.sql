CREATE TABLE suppliers (
  id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, contact VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '', settle VARCHAR(100) NOT NULL DEFAULT '', note VARCHAR(1000) NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE purchase_orders (
  id CHAR(36) PRIMARY KEY, no VARCHAR(40) NOT NULL UNIQUE, supplier_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_ship', expected_at DATE NOT NULL, freight DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount DECIMAL(14,2) NOT NULL, quantity INT NOT NULL, owner_id CHAR(36) NOT NULL, remark VARCHAR(1000) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (owner_id) REFERENCES users(id), INDEX (status,created_at)
) ENGINE=InnoDB;
CREATE TABLE purchase_lines (
  id CHAR(36) PRIMARY KEY, purchase_id CHAR(36) NOT NULL, model_id VARCHAR(60) NOT NULL, expected_attributes JSON NOT NULL,
  quantity INT NOT NULL, unit_cost DECIMAL(14,2) NOT NULL, received_count INT NOT NULL DEFAULT 0,
  accepted_count INT NOT NULL DEFAULT 0, rejected_count INT NOT NULL DEFAULT 0,
  FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id), FOREIGN KEY (model_id) REFERENCES models(id)
) ENGINE=InnoDB;
CREATE TABLE shipments (
  id CHAR(36) PRIMARY KEY, purchase_id CHAR(36) NOT NULL, carrier VARCHAR(10) NOT NULL, tracking_no VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_transit', shipped_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  signed_at DATETIME(3), receipt_file_id CHAR(36), FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (receipt_file_id) REFERENCES files(id), UNIQUE (carrier,tracking_no)
) ENGINE=InnoDB;
CREATE TABLE acceptance_batches (
  id CHAR(36) PRIMARY KEY, purchase_id CHAR(36) NOT NULL, request_key VARCHAR(80) NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL, operator_id CHAR(36) NOT NULL, result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id)
) ENGINE=InnoDB;
CREATE TABLE acceptance_items (
  id CHAR(36) PRIMARY KEY, batch_id CHAR(36) NOT NULL, purchase_line_id CHAR(36) NOT NULL,
  imei1 CHAR(15) NOT NULL, imei2 CHAR(15), model_id VARCHAR(60) NOT NULL,
  result ENUM('pass','fail') NOT NULL, resolution ENUM('none','returned','dispute','reinspected') NOT NULL DEFAULT 'none',
  reason VARCHAR(500) NOT NULL DEFAULT '', unit_id CHAR(36), attributes JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY (batch_id) REFERENCES acceptance_batches(id),
  FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id), FOREIGN KEY (model_id) REFERENCES models(id)
) ENGINE=InnoDB;
CREATE TABLE units (
  id CHAR(36) PRIMARY KEY, model_id VARCHAR(60) NOT NULL, imei1 CHAR(15) NOT NULL, imei2 CHAR(15),
  status VARCHAR(32) NOT NULL, ownership ENUM('own','borrowed') NOT NULL DEFAULT 'own', condition_type ENUM('used','new') NOT NULL,
  attributes JSON NOT NULL, template_snapshot JSON NOT NULL, cost DECIMAL(14,2) NOT NULL,
  retail DECIMAL(14,2) NOT NULL, wholesale DECIMAL(14,2) NOT NULL, agent_base DECIMAL(14,2) NOT NULL,
  share_flags JSON NOT NULL, peer_desc TEXT NOT NULL, customer_desc TEXT NOT NULL, internal_note TEXT NOT NULL,
  purchase_line_id CHAR(36), acceptance_item_id CHAR(36), inbound_operator_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), price_version INT NOT NULL DEFAULT 1,
  FOREIGN KEY (model_id) REFERENCES models(id), FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id),
  FOREIGN KEY (acceptance_item_id) REFERENCES acceptance_items(id), INDEX (status,created_at), INDEX (model_id),
  UNIQUE (imei1), UNIQUE (imei2)
) ENGINE=InnoDB;
CREATE TABLE unit_identifiers (
  imei CHAR(15) PRIMARY KEY, unit_id CHAR(36), acceptance_item_id CHAR(36), slot ENUM('imei1','imei2') NOT NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id), FOREIGN KEY (acceptance_item_id) REFERENCES acceptance_items(id),
  UNIQUE (unit_id,slot), CHECK (unit_id IS NOT NULL OR acceptance_item_id IS NOT NULL)
) ENGINE=InnoDB;
CREATE TABLE unit_files (
  unit_id CHAR(36) NOT NULL, file_id CHAR(36) NOT NULL, field_key VARCHAR(40) NOT NULL, position INT NOT NULL,
  PRIMARY KEY (unit_id,field_key,position), FOREIGN KEY (unit_id) REFERENCES units(id), FOREIGN KEY (file_id) REFERENCES files(id)
) ENGINE=InnoDB;
CREATE TABLE inventory_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, unit_id CHAR(36) NOT NULL, from_status VARCHAR(32), to_status VARCHAR(32) NOT NULL,
  doc_type VARCHAR(40) NOT NULL, doc_id VARCHAR(80) NOT NULL, operator_id CHAR(36) NOT NULL, reason VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY (unit_id) REFERENCES units(id), INDEX (unit_id,id)
) ENGINE=InnoDB;
CREATE TABLE unit_inspections (
  id CHAR(36) PRIMARY KEY, unit_id CHAR(36) NOT NULL, result ENUM('pass','fail') NOT NULL, attributes JSON NOT NULL,
  operator_id CHAR(36) NOT NULL, reason VARCHAR(500) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (unit_id) REFERENCES units(id)
) ENGINE=InnoDB;
CREATE TABLE stocktakes (
  id CHAR(36) PRIMARY KEY, operator_id CHAR(36) NOT NULL, scope JSON NOT NULL, result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE OR REPLACE VIEW report_inventory AS SELECT u.id,m.name,u.status,u.condition_type,u.created_at FROM units u JOIN models m ON m.id=u.model_id;
