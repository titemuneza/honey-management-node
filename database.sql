-- Honey Management System: database tables for MySQL / MariaDB (phpMyAdmin).
--
-- You do NOT have to import this by hand: starting the server (npm start) creates these tables
-- for you, and also creates the database itself if it does not exist.
-- If you prefer phpMyAdmin:
--   1. Create a database (for example: honey_management) with collation utf8mb4_general_ci.
--   2. Click that database in the left list, open the Import tab, choose this file, click Import.
--   3. Start the server and open /setup once to create the first administrator.
--
-- Safe to run again: every statement is CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
    id            INT NOT NULL AUTO_INCREMENT,
    username      VARCHAR(32)  NOT NULL,
    full_name     VARCHAR(100) NOT NULL DEFAULT '',
    role          ENUM('admin', 'staff') NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    active        TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    DATETIME     NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS login_attempts (
    id           INT NOT NULL AUTO_INCREMENT,
    ip           VARCHAR(45) NOT NULL,
    attempted_at DATETIME    NOT NULL,
    PRIMARY KEY (id),
    KEY idx_login_attempts_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
    id                  INT NOT NULL AUTO_INCREMENT,
    name                VARCHAR(255)  NOT NULL,
    honey_type          VARCHAR(100)  NOT NULL DEFAULT '',
    unit                VARCHAR(100)  NOT NULL DEFAULT '',
    price               DECIMAL(12,2) NOT NULL,
    stock               INT           NOT NULL DEFAULT 0,
    low_stock_threshold INT           NOT NULL DEFAULT 10,
    created_at          DATETIME      NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS suppliers (
    id         INT NOT NULL AUTO_INCREMENT,
    name       VARCHAR(255) NOT NULL,
    phone      VARCHAR(50)  NOT NULL DEFAULT '',
    location   VARCHAR(255) NOT NULL DEFAULT '',
    notes      TEXT NULL,
    created_at DATETIME     NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
    id         INT NOT NULL AUTO_INCREMENT,
    name       VARCHAR(255) NOT NULL,
    phone      VARCHAR(50)  NOT NULL DEFAULT '',
    email      VARCHAR(255) NOT NULL DEFAULT '',
    address    TEXT NULL,
    created_at DATETIME     NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_in (
    id            INT NOT NULL AUTO_INCREMENT,
    batch_code    VARCHAR(50)   NOT NULL DEFAULT '',
    product_id    INT           NOT NULL,
    supplier_id   INT           NULL,
    quantity      INT           NOT NULL,
    cost_per_unit DECIMAL(12,2) NOT NULL DEFAULT 0,
    harvest_date  DATE          NULL,
    notes         TEXT          NULL,
    created_by    INT           NULL,
    created_at    DATETIME      NOT NULL,
    PRIMARY KEY (id),
    KEY idx_stock_in_product (product_id),
    CONSTRAINT fk_stock_in_product  FOREIGN KEY (product_id)  REFERENCES products (id),
    CONSTRAINT fk_stock_in_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL,
    CONSTRAINT fk_stock_in_user     FOREIGN KEY (created_by)  REFERENCES users (id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales (
    id             INT NOT NULL AUTO_INCREMENT,
    customer_id    INT           NULL,
    payment_method ENUM('cash', 'mobile_money', 'card', 'bank_transfer') NOT NULL,
    total          DECIMAL(12,2) NOT NULL,
    status         ENUM('completed', 'void') NOT NULL DEFAULT 'completed',
    created_by     INT           NULL,
    created_at     DATETIME      NOT NULL,
    PRIMARY KEY (id),
    KEY idx_sales_created (created_at),
    CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL,
    CONSTRAINT fk_sales_user     FOREIGN KEY (created_by)  REFERENCES users (id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sale_items (
    id         INT NOT NULL AUTO_INCREMENT,
    sale_id    INT           NOT NULL,
    product_id INT           NOT NULL,
    quantity   INT           NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_sale_items_sale (sale_id),
    CONSTRAINT fk_sale_items_sale    FOREIGN KEY (sale_id)    REFERENCES sales (id) ON DELETE CASCADE,
    CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
