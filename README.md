# Honey Management System (Node.js + MySQL)

A web app for running a honey business: products, stock batches (with supplier and harvest date), customers, suppliers, sales, a dashboard with charts, CSV reports and user accounts with roles.

- **Backend:** Node.js (`server.js`, `lib/*.js`) using only Node's built-in web server, plus one package, `mysql2`.
- **Database:** MySQL / MariaDB, the one that comes with XAMPP. Visible in phpMyAdmin.
- **Frontend:** plain HTML, CSS and JavaScript in `public/`. No build step.

Everything supports full **CRUD**, done by you through the screens: **C**reate (`INSERT`), **R**ead (`SELECT`), **U**pdate (`UPDATE`), **D**elete (`DELETE`). The system starts **empty**; nothing is added for you.

## Run it (about 5 minutes)

1. Install **Node.js 18 or newer** from https://nodejs.org (once).
2. Start **MySQL** in the XAMPP Control Panel. (Apache is not needed.)
3. Open a terminal (Command Prompt or PowerShell) **in this folder** and run:

   ```
   npm install
   npm start
   ```

   On start-up the server creates the database `honey_management` if it is missing and creates all the tables.
4. Open **http://localhost:3000/setup** and create the first administrator (username and password).
5. Open **http://localhost:3000** and sign in.

Open **http://localhost/phpmyadmin** and click `honey_management` to see the tables and rows.

### If you already imported `database.sql` in phpMyAdmin

That is fine: the server sees the tables and uses them. Two things to check:

- **Database name.** If you imported into a database with a different name, set it in `config.js` (`dbName`).
- **Administrator.** Accounts created by the PHP version of this system cannot sign in here (a different password format). If you already created one, open the `users` table in phpMyAdmin, delete that row, then open `/setup` again.

## Settings

Edit **`config.js`**, or set environment variables of the same purpose:

| Setting | Environment variable | Default |
|---|---|---|
| `port` | `PORT` | 3000 |
| `dbHost`, `dbPort` | `DB_HOST`, `DB_PORT` | 127.0.0.1, 3306 |
| `dbName` | `DB_NAME` | honey_management |
| `dbUser`, `dbPass` | `DB_USER`, `DB_PASS` | root, empty (XAMPP default) |
| `currency` | `APP_CURRENCY` | USD |
| `timezone` | `APP_TIMEZONE` | Africa/Kigali |
| `dbDriver` | `DB_DRIVER` | mysql (or `sqlite`, see below) |

## Run with Docker Compose (optional)

If you have Docker installed, one command starts the app, a MariaDB database and phpMyAdmin:

```
docker compose up -d --build
```

- App: http://localhost:3000 (first time: http://localhost:3000/setup)
- phpMyAdmin: http://localhost:8081 (server `db`, user `honey`, password `honeypass`)

Your data is kept in a Docker volume, so it survives restarts. Change the passwords in `docker-compose.yml` before using it anywhere other than your own computer. Stop it with `docker compose down` (add `-v` to also delete the data).

## No MySQL? Use the built-in SQLite option

With **Node 22.5 or newer** you can run without any database server. Data is kept in one file, `honey.db`:

```
# Windows PowerShell
$env:DB_DRIVER="sqlite"; npm start

# macOS / Linux
DB_DRIVER=sqlite npm start
```

(This mode does not need `npm install`.)

## What it does

| Page | Create | Read | Update | Delete |
|---|---|---|---|---|
| Products | Add product | List and search | Edit | Delete (admin) |
| Customers | Add customer | List and search | Edit | Delete (admin) |
| Suppliers | Add supplier | List and search | Edit | Delete (admin) |
| Stock & batches | Receive stock | Batch history | Edit batch | Delete batch (admin) |
| Sales | New sale | List, filter by date, receipt | Edit sale | Delete sale (admin), or void |
| Users (admin) | Add user | User list | Edit, reset password, disable | Delete |

Other screens: **Dashboard** (sales today and this month, stock value, 14-day chart, top products, low-stock alerts), **Reports** (CSV for sales, inventory, batches, customers) and **Database** (admin: every table with its columns and row count).

Good to know:
- Stock counts follow your records: a batch adds its quantity, a sale removes its items. Editing or deleting a batch or sale corrects the count too. Overselling is blocked, and a batch cannot be cut or deleted if some of its stock is already sold.
- Editing a sale keeps the price each item was sold at, even if the product price changed since.
- A product used by a sale or batch cannot be deleted. Void a sale to cancel it but keep it on record.
- Every change runs as one all-or-nothing step, so a failed request never leaves half-saved data.

**Roles:** *staff* can create, read and update everything except users. *Admin* can additionally delete records, void sales and manage users.

## Files

```
honey-management-node/
├── server.js            # web server, sessions, setup page
├── config.js            # your settings
├── lib/db.js            # database connection (MySQL, or SQLite option)
├── lib/routes.js        # every operation (the CRUD code and SQL)
├── lib/util.js          # validation, passwords, dates
├── public/              # the frontend: index.html, style.css, app.js
├── database.sql         # table definitions for MySQL / MariaDB
├── database.sqlite.sql  # same tables for the SQLite option
├── test/api.test.js     # automatic tests (npm test, needs Node 22.5+)
├── Dockerfile  docker-compose.yml
└── package.json
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module` / "mysql2 package is missing" | Run `npm install` in this folder. |
| "Could not start the database" | Start **MySQL** in the XAMPP Control Panel. Check `dbUser` / `dbPass` in `config.js`. |
| `'npm' is not recognized` | Install Node.js, then open a **new** terminal window. |
| Port 3000 already in use | Set another port: `PORT=3001` (PowerShell: `$env:PORT="3001"`). |
| Signed out after restarting the server | Expected: sign-in sessions are kept in memory. Just sign in again. |
| Sign-in keeps failing | After 8 wrong attempts from one address you are blocked for 5 minutes. |

## Security notes

- Passwords are stored with scrypt (built into Node). Sessions use an HttpOnly, SameSite=Lax cookie and last 12 hours; a disabled user is locked out immediately.
- Repeated failed sign-ins from one address are temporarily blocked.
- All database access uses parameters (no SQL built from user input); all text shown in the UI is HTML-escaped; CSV exports neutralise spreadsheet formulas.
- Built for a single shop or small team on a trusted network. Before putting it on the internet, use HTTPS (a reverse proxy such as Caddy or nginx) and set a MySQL password.

## Back up your data

In phpMyAdmin choose the database, then **Export** and save the `.sql` file.
