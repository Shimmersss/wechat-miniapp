-- 22 份 MySQL 迁移的最终表结构。已有核心表保持原位；不修改前两份迁移。

-- UUID/JSONB/timestamptz；原 ENUM 转 CHECK；保留 numeric(14,2) 金额范围。

CREATE TABLE files (
  id uuid PRIMARY KEY,
  scope text CHECK (scope IN ('public','internal')) NOT NULL,
  stored_name VARCHAR(100) NOT NULL UNIQUE,
  mime VARCHAR(80) NOT NULL,
  byte_size BIGINT  NOT NULL,
  sha256 CHAR(64) NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id VARCHAR(60) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category_id VARCHAR(60) NOT NULL,
  current_version INT NOT NULL DEFAULT 1
);

CREATE TABLE template_versions (
  template_id VARCHAR(60) NOT NULL,
  version INT NOT NULL,
  fields jsonb NOT NULL,
  description_presets jsonb NOT NULL,
  operator_id uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id,version)
);

CREATE TABLE tac_mappings (
  tac CHAR(8) PRIMARY KEY,
  model_id VARCHAR(60) NOT NULL,
  source VARCHAR(200) NOT NULL
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  contact VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  settle VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(1000) NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  no VARCHAR(40) NOT NULL UNIQUE,
  supplier_id uuid NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_ship',
  expected_at DATE NOT NULL,
  freight numeric(14,2) NOT NULL DEFAULT 0,
  amount numeric(14,2) NOT NULL,
  quantity INT NOT NULL,
  owner_id uuid NOT NULL,
  remark VARCHAR(1000) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_lines (
  id uuid PRIMARY KEY,
  purchase_id uuid NOT NULL,
  model_id VARCHAR(60) NOT NULL,
  expected_attributes jsonb NOT NULL,
  quantity INT NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  received_count INT NOT NULL DEFAULT 0,
  accepted_count INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY,
  purchase_id uuid NOT NULL,
  carrier VARCHAR(10) NOT NULL,
  tracking_no VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_transit',
  shipped_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  receipt_file_id uuid,
  UNIQUE (carrier,tracking_no)
);

CREATE TABLE acceptance_batches (
  id uuid PRIMARY KEY,
  purchase_id uuid NOT NULL,
  request_key VARCHAR(80) NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  operator_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acceptance_items (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  purchase_line_id uuid NOT NULL,
  imei1 CHAR(15) NOT NULL,
  imei2 CHAR(15),
  model_id VARCHAR(60) NOT NULL,
  result text CHECK (result IN ('pass','fail')) NOT NULL,
  resolution text CHECK (resolution IN ('none','returned','dispute','reinspected')) NOT NULL DEFAULT 'none',
  reason VARCHAR(500) NOT NULL DEFAULT '',
  unit_id uuid,
  attributes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unit_identifiers (
  imei CHAR(15) PRIMARY KEY,
  unit_id uuid,
  acceptance_item_id uuid,
  slot text CHECK (slot IN ('imei1','imei2')) NOT NULL,
  UNIQUE (unit_id,slot),
  CHECK (unit_id IS NOT NULL OR acceptance_item_id IS NOT NULL)
);

CREATE TABLE unit_files (
  unit_id uuid NOT NULL,
  file_id uuid NOT NULL,
  field_key VARCHAR(40) NOT NULL,
  position INT NOT NULL,
  PRIMARY KEY (unit_id,field_key,position)
);

CREATE TABLE inventory_ledger (
  id BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id uuid NOT NULL,
  from_status VARCHAR(32),
  to_status VARCHAR(32) NOT NULL,
  doc_type VARCHAR(40) NOT NULL,
  doc_id VARCHAR(80) NOT NULL,
  operator_id uuid NOT NULL,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unit_inspections (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL,
  result text CHECK (result IN ('pass','fail')) NOT NULL,
  attributes jsonb NOT NULL,
  operator_id uuid NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stocktakes (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL,
  scope jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_key VARCHAR(80) NULL,
  request_hash CHAR(64) NULL,
  UNIQUE (request_key),
  session_id uuid NULL,
  UNIQUE (session_id)
);

CREATE TABLE sales_orders (
  id uuid PRIMARY KEY,
  no VARCHAR(40) NOT NULL UNIQUE,
  seller_id uuid NOT NULL,
  pay_method VARCHAR(20) NOT NULL,
  customer VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  remark VARCHAR(1000) NOT NULL DEFAULT '',
  amount numeric(14,2) NOT NULL,
  cost_total numeric(14,2) NOT NULL,
  request_key VARCHAR(80) NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  model_id VARCHAR(60) NOT NULL,
  name VARCHAR(100) NOT NULL,
  spec VARCHAR(300) NOT NULL,
  store VARCHAR(100) NOT NULL DEFAULT '',
  price numeric(14,2) NOT NULL,
  cost numeric(14,2) NOT NULL,
  price_version INT NOT NULL,
  channel VARCHAR(20) NOT NULL,
  UNIQUE(order_id,unit_id)
);

CREATE TABLE sales_refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  reason VARCHAR(500) NOT NULL,
  kind text CHECK (kind IN ('return','adjustment')) NOT NULL,
  amount numeric(14,2) NOT NULL,
  request_key VARCHAR(80) NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_refund_items (
  refund_id uuid NOT NULL,
  sale_item_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  cost_reversal numeric(14,2) NOT NULL,
  PRIMARY KEY(refund_id,sale_item_id)
);

CREATE TABLE sales_order_locks (
  order_id uuid PRIMARY KEY
);

CREATE TABLE visit_events (
  visitor_hash CHAR(64) NOT NULL,
  event_id VARCHAR(100) NOT NULL,
  type text CHECK (type IN ('pv','event')) NOT NULL,
  name VARCHAR(40) NOT NULL DEFAULT '',
  route VARCHAR(150) NOT NULL DEFAULT '',
  unit_id VARCHAR(60) NULL,
  source VARCHAR(20) NOT NULL,
  share_hash CHAR(64) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(visitor_hash,event_id),
  share_id VARCHAR(24) NULL,
  share_owner_id uuid NULL
);

CREATE TABLE report_exports (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  request_key VARCHAR(80) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_key)
);

CREATE TABLE share_links (
  id VARCHAR(24) PRIMARY KEY,
  owner_id uuid NOT NULL,
  owner_kind text CHECK (owner_kind IN ('staff','peer','customer','agent')) NOT NULL,
  channel text CHECK (channel IN ('customer','peer','agent')) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE share_items (
  share_id VARCHAR(24) NOT NULL,
  unit_id uuid NOT NULL,
  price_version INT NOT NULL,
  price numeric(14,2) NOT NULL,
  PRIMARY KEY(share_id,unit_id),
  markup numeric(14,2) NULL
);

CREATE TABLE customer_requests (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  kind text CHECK (kind IN ('consult','appointment','order')) NOT NULL,
  unit_id uuid NULL,
  unit_snapshot jsonb NULL,
  content VARCHAR(2000) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  appointment_date DATE NULL,
  time_slot VARCHAR(60) NULL,
  source text CHECK (source IN ('natural','customer','peer','agent')) NOT NULL,
  share_id VARCHAR(24) NULL,
  share_owner_id uuid NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,request_key)
);

CREATE TABLE customer_request_states (
  request_id uuid PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  version INT NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_request_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  actor_kind text CHECK (actor_kind IN ('staff','customer')) NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NOT NULL,
  version INT NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,actor_id,request_key)
);

CREATE TABLE sales_attributions (
  order_id uuid PRIMARY KEY,
  customer_request_id uuid NOT NULL UNIQUE,
  customer_id uuid NOT NULL,
  source VARCHAR(20) NOT NULL,
  share_id VARCHAR(24) NULL,
  share_owner_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repair_orders (
  id uuid PRIMARY KEY,
  no VARCHAR(40) NOT NULL UNIQUE,
  kind text CHECK (kind IN ('external','inventory')) NOT NULL,
  unit_id uuid NULL,
  model VARCHAR(120) NOT NULL,
  identifier VARCHAR(80) NOT NULL DEFAULT '',
  customer VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  fault VARCHAR(2000) NOT NULL,
  engineer_id uuid NULL,
  expected_date DATE NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending_check',
  version INT NOT NULL DEFAULT 1,
  diagnosis VARCHAR(2000) NOT NULL DEFAULT '',
  waiting_parts BOOLEAN NOT NULL DEFAULT FALSE,
  quote numeric(14,2) NULL,
  quote_version INT NOT NULL DEFAULT 0,
  confirmed_version INT NULL,
  warranty_days INT NULL,
  pickup_name VARCHAR(100) NOT NULL DEFAULT '',
  completed_at timestamptz NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  creator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(creator_id,request_key)
);

CREATE TABLE repair_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(24) NOT NULL,
  to_status VARCHAR(24) NOT NULL,
  version INT NOT NULL,
  note VARCHAR(1000) NOT NULL,
  public_data jsonb NOT NULL,
  internal_data jsonb NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,request_key)
);

CREATE TABLE repair_files (
  order_id uuid NOT NULL,
  file_id uuid NOT NULL,
  purpose text CHECK (purpose IN ('appearance','pickup','payment','expense')) NOT NULL,
  position INT NOT NULL,
  PRIMARY KEY(order_id,file_id,purpose)
);

CREATE TABLE repair_parts (
  id uuid PRIMARY KEY,
  sku VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT '件',
  quantity INT NOT NULL DEFAULT 0,
  stock_value numeric(14,2) NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repair_part_ledger (
  id uuid PRIMARY KEY,
  part_id uuid NOT NULL,
  order_id uuid NULL,
  issue_id uuid NULL,
  kind text CHECK (kind IN ('receive','issue','return')) NOT NULL,
  quantity INT NOT NULL,
  cost_amount numeric(14,2) NOT NULL,
  actor_id uuid NOT NULL,
  reason VARCHAR(500) NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_key)
);

CREATE TABLE repair_payments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  kind text CHECK (kind IN ('receipt','refund','expense','expense_refund')) NOT NULL,
  amount numeric(14,2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  actor_id uuid NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repair_cost_allocations (
  order_id uuid PRIMARY KEY,
  unit_id uuid NOT NULL,
  policy text CHECK (policy IN ('capitalize','separate')) NOT NULL,
  parts_cost numeric(14,2) NOT NULL,
  expenses numeric(14,2) NOT NULL,
  total_cost numeric(14,2) NOT NULL,
  old_unit_cost numeric(14,2) NOT NULL,
  new_unit_cost numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repair_external_slots (
  identifier VARCHAR(80) PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE
);

CREATE TABLE loan_orders (
  id uuid PRIMARY KEY,
  no VARCHAR(40) NOT NULL UNIQUE,
  type text CHECK (type IN ('loan_out','borrow_in')) NOT NULL,
  counterparty VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  due_date DATE NOT NULL,
  remark VARCHAR(2000) NOT NULL,
  creator_id uuid NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(creator_id,request_key)
);

CREATE TABLE loan_states (
  order_id uuid PRIMARY KEY,
  status text CHECK (status IN ('active','returned_recheck','closed')) NOT NULL DEFAULT 'active',
  version INT NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loan_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  UNIQUE(order_id,unit_id)
);

CREATE TABLE loan_item_states (
  item_id uuid PRIMARY KEY,
  status text CHECK (status IN ('active','returned_recheck','closed')) NOT NULL DEFAULT 'active',
  returned_at timestamptz NULL,
  inspection_version INT NULL,
  return_ledger_id BIGINT  NULL
);

CREATE TABLE loan_active_units (
  unit_id uuid PRIMARY KEY,
  order_id uuid NOT NULL
);

CREATE TABLE loan_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action VARCHAR(30) NOT NULL,
  version INT NOT NULL,
  reason VARCHAR(500) NOT NULL,
  data jsonb NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,request_key)
);

CREATE TABLE loan_files (
  order_id uuid NOT NULL,
  file_id uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY(order_id,file_id,event_id)
);

CREATE TABLE agent_settings (
  id smallint PRIMARY KEY,
  default_markup_max numeric(14,2) NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  user_id uuid PRIMARY KEY,
  status text CHECK (status IN ('pending','active','rejected','disabled')) NOT NULL DEFAULT 'pending',
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  region VARCHAR(100) NOT NULL,
  inviter_id uuid NULL,
  invite_code CHAR(8) NULL UNIQUE,
  markup_max numeric(14,2) NULL,
  review_remark VARCHAR(500) NOT NULL DEFAULT '',
  reviewed_by uuid NULL,
  reviewed_at timestamptz NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  version INT NOT NULL DEFAULT 1
);

CREATE TABLE agent_markups (
  agent_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  markup numeric(14,2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id,unit_id)
);

CREATE TABLE agent_orders (
  request_id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  share_id VARCHAR(24) NOT NULL,
  agent_base numeric(14,2) NOT NULL,
  markup numeric(14,2) NOT NULL,
  share_price numeric(14,2) NOT NULL,
  price_version INT NOT NULL,
  lock_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_order_states (
  request_id uuid PRIMARY KEY,
  status text CHECK (status IN ('locked','sold','released')) NOT NULL DEFAULT 'locked',
  sale_order_id uuid NULL,
  release_reason VARCHAR(100) NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_unit_locks (
  unit_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE
);

CREATE TABLE agent_earnings (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  request_id uuid NOT NULL,
  sale_order_id uuid NOT NULL,
  kind text CHECK (kind IN ('earning','reversal')) NOT NULL,
  amount numeric(14,2) NOT NULL,
  reversal_of uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,kind)
);

CREATE TABLE agent_earning_states (
  earning_id uuid PRIMARY KEY,
  status text CHECK (status IN ('pending','settled','reversed')) NOT NULL DEFAULT 'pending',
  settled_by uuid NULL,
  settled_at timestamptz NULL,
  settle_reason VARCHAR(500) NOT NULL DEFAULT ''
);

CREATE TABLE sales_files (
  order_id uuid NOT NULL,
  file_id uuid NOT NULL,
  added_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(order_id,file_id),
  UNIQUE(file_id)
);

CREATE TABLE stocktake_sessions (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL,
  scope jsonb NOT NULL,
  note VARCHAR(200) NOT NULL DEFAULT '',
  status text CHECK (status IN ('open','closed','cancelled')) NOT NULL DEFAULT 'open',
  stocktake_id uuid NULL,
  closed_by uuid NULL,
  closed_at timestamptz NULL,
  cancel_reason VARCHAR(200) NULL,
  request_key VARCHAR(80) NULL,
  request_hash CHAR(64) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_key)
);

CREATE TABLE stocktake_session_units (
  session_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  start_status VARCHAR(30) NOT NULL,
  scanned_by uuid NULL,
  scanned_at timestamptz NULL,
  scanned_code VARCHAR(80) NULL,
  PRIMARY KEY (session_id, unit_id)
);

CREATE TABLE stocktake_extras (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  code VARCHAR(80) NOT NULL,
  unit_id uuid NULL,
  unit_status VARCHAR(30) NULL,
  reason VARCHAR(100) NOT NULL,
  scanned_by uuid NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, code)
);

CREATE TABLE stocktake_resolutions (
  id uuid PRIMARY KEY,
  stocktake_id uuid NOT NULL,
  target_type text CHECK (target_type IN ('unit','extra')) NOT NULL,
  target VARCHAR(80) NOT NULL,
  resolution text CHECK (resolution IN ('pending','found','lost','handled')) NOT NULL,
  note VARCHAR(200) NOT NULL,
  operator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE files ADD FOREIGN KEY (owner_id) REFERENCES users(id);

ALTER TABLE templates ADD FOREIGN KEY (category_id) REFERENCES categories(id);

ALTER TABLE template_versions ADD FOREIGN KEY (template_id) REFERENCES templates(id);

ALTER TABLE tac_mappings ADD FOREIGN KEY (model_id) REFERENCES models(id);

ALTER TABLE purchase_orders ADD FOREIGN KEY (supplier_id) REFERENCES suppliers(id);

ALTER TABLE purchase_orders ADD FOREIGN KEY (owner_id) REFERENCES users(id);

CREATE INDEX purchase_orders_6_idx ON purchase_orders (status,created_at);

ALTER TABLE purchase_lines ADD FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id);

ALTER TABLE purchase_lines ADD FOREIGN KEY (model_id) REFERENCES models(id);

ALTER TABLE shipments ADD FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id);

ALTER TABLE shipments ADD FOREIGN KEY (receipt_file_id) REFERENCES files(id);

ALTER TABLE acceptance_batches ADD FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id);

ALTER TABLE acceptance_items ADD FOREIGN KEY (batch_id) REFERENCES acceptance_batches(id);

ALTER TABLE acceptance_items ADD FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id);

ALTER TABLE acceptance_items ADD FOREIGN KEY (model_id) REFERENCES models(id);

ALTER TABLE unit_identifiers ADD FOREIGN KEY (unit_id) REFERENCES units(id);

ALTER TABLE unit_identifiers ADD FOREIGN KEY (acceptance_item_id) REFERENCES acceptance_items(id);

ALTER TABLE unit_files ADD FOREIGN KEY (unit_id) REFERENCES units(id);

ALTER TABLE unit_files ADD FOREIGN KEY (file_id) REFERENCES files(id);

ALTER TABLE inventory_ledger ADD FOREIGN KEY (unit_id) REFERENCES units(id);

CREATE INDEX inventory_ledger_20_idx ON inventory_ledger (unit_id,id);

ALTER TABLE unit_inspections ADD FOREIGN KEY (unit_id) REFERENCES units(id);

ALTER TABLE sales_orders ADD FOREIGN KEY(seller_id) REFERENCES users(id);

CREATE INDEX sales_orders_23_idx ON sales_orders (created_at);

ALTER TABLE sales_items ADD FOREIGN KEY(order_id) REFERENCES sales_orders(id);

ALTER TABLE sales_items ADD FOREIGN KEY(unit_id) REFERENCES units(id);

CREATE INDEX sales_items_26_idx ON sales_items (unit_id);

ALTER TABLE sales_refunds ADD FOREIGN KEY(order_id) REFERENCES sales_orders(id);

ALTER TABLE sales_refunds ADD FOREIGN KEY(operator_id) REFERENCES users(id);

CREATE INDEX sales_refunds_29_idx ON sales_refunds (created_at);

ALTER TABLE sales_refund_items ADD FOREIGN KEY(refund_id) REFERENCES sales_refunds(id);

ALTER TABLE sales_refund_items ADD FOREIGN KEY(sale_item_id) REFERENCES sales_items(id);

ALTER TABLE sales_order_locks ADD FOREIGN KEY(order_id) REFERENCES sales_orders(id);

CREATE INDEX visit_events_33_idx ON visit_events (created_at,type);

ALTER TABLE visit_events ADD FOREIGN KEY(share_id) REFERENCES share_links(id);

ALTER TABLE visit_events ADD FOREIGN KEY(share_owner_id) REFERENCES users(id);

CREATE INDEX visit_events_36_idx ON visit_events (share_owner_id,created_at);

ALTER TABLE report_exports ADD FOREIGN KEY(actor_id) REFERENCES users(id);

ALTER TABLE share_links ADD FOREIGN KEY(owner_id) REFERENCES users(id);

CREATE INDEX share_links_39_idx ON share_links (owner_id,created_at);

ALTER TABLE share_items ADD FOREIGN KEY(share_id) REFERENCES share_links(id);

ALTER TABLE share_items ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE customer_requests ADD FOREIGN KEY(owner_id) REFERENCES users(id);

ALTER TABLE customer_requests ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE customer_requests ADD FOREIGN KEY(share_id) REFERENCES share_links(id);

ALTER TABLE customer_requests ADD FOREIGN KEY(share_owner_id) REFERENCES users(id);

CREATE INDEX customer_requests_46_idx ON customer_requests (created_at,kind);

CREATE INDEX customer_requests_47_idx ON customer_requests (share_owner_id,created_at);

ALTER TABLE customer_request_states ADD FOREIGN KEY(request_id) REFERENCES customer_requests(id);

CREATE INDEX customer_request_states_49_idx ON customer_request_states (status,updated_at);

ALTER TABLE customer_request_events ADD FOREIGN KEY(request_id) REFERENCES customer_requests(id);

ALTER TABLE customer_request_events ADD FOREIGN KEY(actor_id) REFERENCES users(id);

CREATE INDEX customer_request_events_52_idx ON customer_request_events (request_id,created_at);

ALTER TABLE sales_attributions ADD FOREIGN KEY(order_id) REFERENCES sales_orders(id);

ALTER TABLE sales_attributions ADD FOREIGN KEY(customer_request_id) REFERENCES customer_requests(id);

ALTER TABLE sales_attributions ADD FOREIGN KEY(customer_id) REFERENCES users(id);

ALTER TABLE sales_attributions ADD FOREIGN KEY(share_id) REFERENCES share_links(id);

ALTER TABLE sales_attributions ADD FOREIGN KEY(share_owner_id) REFERENCES users(id);

ALTER TABLE repair_orders ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE repair_orders ADD FOREIGN KEY(engineer_id) REFERENCES users(id);

ALTER TABLE repair_orders ADD FOREIGN KEY(creator_id) REFERENCES users(id);

CREATE INDEX repair_orders_61_idx ON repair_orders (status,expected_date);

CREATE INDEX repair_orders_62_idx ON repair_orders (engineer_id,status);

CREATE INDEX repair_orders_63_idx ON repair_orders (unit_id,status);

ALTER TABLE repair_events ADD FOREIGN KEY(order_id) REFERENCES repair_orders(id);

ALTER TABLE repair_events ADD FOREIGN KEY(actor_id) REFERENCES users(id);

CREATE INDEX repair_events_66_idx ON repair_events (order_id,version);

ALTER TABLE repair_files ADD FOREIGN KEY(order_id) REFERENCES repair_orders(id);

ALTER TABLE repair_files ADD FOREIGN KEY(file_id) REFERENCES files(id);

ALTER TABLE repair_part_ledger ADD FOREIGN KEY(part_id) REFERENCES repair_parts(id);

ALTER TABLE repair_part_ledger ADD FOREIGN KEY(order_id) REFERENCES repair_orders(id);

ALTER TABLE repair_part_ledger ADD FOREIGN KEY(actor_id) REFERENCES users(id);

CREATE INDEX repair_part_ledger_72_idx ON repair_part_ledger (part_id,created_at);

ALTER TABLE repair_payments ADD FOREIGN KEY(order_id) REFERENCES repair_orders(id);

ALTER TABLE repair_payments ADD FOREIGN KEY(actor_id) REFERENCES users(id);

CREATE INDEX repair_payments_75_idx ON repair_payments (order_id,created_at);

ALTER TABLE repair_cost_allocations ADD FOREIGN KEY(order_id) REFERENCES repair_orders(id);

ALTER TABLE repair_cost_allocations ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE repair_external_slots ADD FOREIGN KEY(order_id) REFERENCES repair_orders(id);

ALTER TABLE loan_orders ADD FOREIGN KEY(creator_id) REFERENCES users(id);

ALTER TABLE loan_states ADD FOREIGN KEY(order_id) REFERENCES loan_orders(id);

ALTER TABLE loan_items ADD FOREIGN KEY(order_id) REFERENCES loan_orders(id);

ALTER TABLE loan_items ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE loan_item_states ADD FOREIGN KEY(item_id) REFERENCES loan_items(id);

ALTER TABLE loan_active_units ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE loan_active_units ADD FOREIGN KEY(order_id) REFERENCES loan_orders(id);

ALTER TABLE loan_events ADD FOREIGN KEY(order_id) REFERENCES loan_orders(id);

ALTER TABLE loan_events ADD FOREIGN KEY(actor_id) REFERENCES users(id);

ALTER TABLE loan_files ADD FOREIGN KEY(order_id) REFERENCES loan_orders(id);

ALTER TABLE loan_files ADD FOREIGN KEY(file_id) REFERENCES files(id);

ALTER TABLE loan_files ADD FOREIGN KEY(event_id) REFERENCES loan_events(id);

ALTER TABLE agent_settings ADD FOREIGN KEY(updated_by) REFERENCES users(id);

ALTER TABLE agents ADD FOREIGN KEY(user_id) REFERENCES users(id);

ALTER TABLE agents ADD FOREIGN KEY(inviter_id) REFERENCES users(id);

ALTER TABLE agents ADD FOREIGN KEY(reviewed_by) REFERENCES users(id);

CREATE INDEX agents_95_idx ON agents (status,applied_at);

CREATE INDEX agents_96_idx ON agents (inviter_id);

ALTER TABLE agent_markups ADD FOREIGN KEY(agent_id) REFERENCES users(id);

ALTER TABLE agent_markups ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE agent_orders ADD FOREIGN KEY(request_id) REFERENCES customer_requests(id);

ALTER TABLE agent_orders ADD FOREIGN KEY(agent_id) REFERENCES users(id);

ALTER TABLE agent_orders ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE agent_orders ADD FOREIGN KEY(share_id) REFERENCES share_links(id);

CREATE INDEX agent_orders_103_idx ON agent_orders (agent_id,created_at);

ALTER TABLE agent_order_states ADD FOREIGN KEY(request_id) REFERENCES agent_orders(request_id);

ALTER TABLE agent_order_states ADD FOREIGN KEY(sale_order_id) REFERENCES sales_orders(id);

CREATE INDEX agent_order_states_106_idx ON agent_order_states (status);

ALTER TABLE agent_unit_locks ADD FOREIGN KEY(unit_id) REFERENCES units(id);

ALTER TABLE agent_unit_locks ADD FOREIGN KEY(request_id) REFERENCES agent_orders(request_id);

ALTER TABLE agent_earnings ADD FOREIGN KEY(agent_id) REFERENCES users(id);

ALTER TABLE agent_earnings ADD FOREIGN KEY(request_id) REFERENCES agent_orders(request_id);

ALTER TABLE agent_earnings ADD FOREIGN KEY(sale_order_id) REFERENCES sales_orders(id);

CREATE INDEX agent_earnings_112_idx ON agent_earnings (agent_id,created_at);

ALTER TABLE agent_earning_states ADD FOREIGN KEY(earning_id) REFERENCES agent_earnings(id);

ALTER TABLE agent_earning_states ADD FOREIGN KEY(settled_by) REFERENCES users(id);

CREATE INDEX agent_earning_states_115_idx ON agent_earning_states (status);

ALTER TABLE sales_files ADD FOREIGN KEY(order_id) REFERENCES sales_orders(id);

ALTER TABLE sales_files ADD FOREIGN KEY(file_id) REFERENCES files(id);

ALTER TABLE sales_files ADD FOREIGN KEY(added_by) REFERENCES users(id);

CREATE INDEX stocktake_sessions_stocktake_session_status_idx ON stocktake_sessions (status, created_at);

ALTER TABLE stocktake_sessions ADD FOREIGN KEY (operator_id) REFERENCES users(id);

ALTER TABLE stocktake_sessions ADD FOREIGN KEY (closed_by) REFERENCES users(id);

ALTER TABLE stocktake_sessions ADD FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id);

CREATE INDEX stocktake_session_units_stocktake_session_scanned_idx ON stocktake_session_units (session_id, scanned_at);

ALTER TABLE stocktake_session_units ADD FOREIGN KEY (session_id) REFERENCES stocktake_sessions(id);

ALTER TABLE stocktake_session_units ADD FOREIGN KEY (unit_id) REFERENCES units(id);

ALTER TABLE stocktake_session_units ADD FOREIGN KEY (scanned_by) REFERENCES users(id);

CREATE INDEX stocktake_extras_stocktake_extra_unit_idx ON stocktake_extras (session_id, unit_id);

ALTER TABLE stocktake_extras ADD FOREIGN KEY (session_id) REFERENCES stocktake_sessions(id);

ALTER TABLE stocktake_extras ADD FOREIGN KEY (unit_id) REFERENCES units(id);

ALTER TABLE stocktake_extras ADD FOREIGN KEY (scanned_by) REFERENCES users(id);

CREATE INDEX stocktake_resolutions_stocktake_resolution_target_idx ON stocktake_resolutions (stocktake_id, target_type, target, created_at);

ALTER TABLE stocktake_resolutions ADD FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id);

ALTER TABLE stocktake_resolutions ADD FOREIGN KEY (operator_id) REFERENCES users(id);

ALTER TABLE units ADD CONSTRAINT units_supplier_fk FOREIGN KEY (supplier_id) REFERENCES suppliers(id), ADD CONSTRAINT units_purchase_line_fk FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id), ADD CONSTRAINT units_acceptance_item_fk FOREIGN KEY (acceptance_item_id) REFERENCES acceptance_items(id);

INSERT INTO unit_identifiers(imei,unit_id,slot) SELECT imei1,id,'imei1' FROM units UNION ALL SELECT imei2,id,'imei2' FROM units WHERE imei2 IS NOT NULL;

CREATE INDEX audit_action_time ON audit_logs(action,created_at);

CREATE INDEX audit_object ON audit_logs(object_id);

CREATE VIEW report_catalog WITH (security_invoker=true) AS SELECT c.label category,m.brand_label brand,m.name model FROM models m JOIN categories c ON c.id=m.category_id;

CREATE VIEW report_inventory WITH (security_invoker=true) AS SELECT u.id,m.name,u.status,u.condition_type,u.created_at FROM units u JOIN models m ON m.id=u.model_id;

INSERT INTO agent_settings(id) VALUES(1);

CREATE UNIQUE INDEX categories_label_ci ON categories(lower(label));

CREATE UNIQUE INDEX models_name_ci ON models(lower(name));

CREATE UNIQUE INDEX suppliers_name_ci ON suppliers(lower(name));

CREATE UNIQUE INDEX repair_parts_sku_ci ON repair_parts(lower(sku));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['roles','users','staff','sessions','sms_challenges','audit_logs','files','categories','templates','template_versions','models','tac_mappings','suppliers','purchase_orders','purchase_lines','shipments','acceptance_batches','acceptance_items','units','unit_identifiers','unit_files','inventory_ledger','unit_inspections','stocktakes','sales_orders','sales_items','sales_refunds','sales_refund_items','sales_order_locks','visit_events','report_exports','share_links','share_items','customer_requests','customer_request_states','customer_request_events','sales_attributions','repair_orders','repair_events','repair_files','repair_parts','repair_part_ledger','repair_payments','repair_cost_allocations','repair_external_slots','loan_orders','loan_states','loan_items','loan_item_states','loan_active_units','loan_events','loan_files','agent_settings','agents','agent_markups','agent_orders','agent_order_states','agent_unit_locks','agent_earnings','agent_earning_states','sales_files','stocktake_sessions','stocktake_session_units','stocktake_extras','stocktake_resolutions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
  END LOOP;
END $$;
REVOKE UPDATE,DELETE,TRUNCATE ON audit_logs,inventory_ledger,stocktakes,stocktake_resolutions FROM service_role;
GRANT USAGE,SELECT ON SEQUENCE inventory_ledger_id_seq TO service_role;
REVOKE ALL ON report_inventory,report_catalog FROM PUBLIC,anon,authenticated;
GRANT SELECT ON report_inventory,report_catalog TO service_role;
