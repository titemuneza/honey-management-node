'use strict';

// Honey Management System - settings.
// Plain Node.js: edit the default values below (or set environment variables).
// Docker Compose: the values come from environment variables in docker-compose.yml.
const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',

  // 'mysql' uses the MySQL / MariaDB database you see in phpMyAdmin (XAMPP).
  // 'sqlite' needs no database server (Node 22.5 or newer); data is kept in a single file.
  dbDriver: env.DB_DRIVER || 'mysql',

  dbHost: env.DB_HOST || '127.0.0.1',
  dbPort: Number(env.DB_PORT) || 3306,
  dbName: env.DB_NAME || 'honey_management', // created for you if it does not exist
  dbUser: env.DB_USER || 'root',              // XAMPP default
  dbPass: env.DB_PASS !== undefined ? env.DB_PASS : '', // XAMPP default is an empty password
  sqliteFile: env.SQLITE_FILE || 'honey.db',

  currency: env.APP_CURRENCY || 'USD',            // any ISO code, e.g. USD, EUR, RWF, ZAR
  timezone: env.APP_TIMEZONE || 'Africa/Kigali',  // used for dates and times
};
