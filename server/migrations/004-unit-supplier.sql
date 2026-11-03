ALTER TABLE units ADD COLUMN supplier_id CHAR(36), ADD FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
