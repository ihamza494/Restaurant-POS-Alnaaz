# Basic Restaurant POS

Plain HTML/JS frontend, Node.js backend, SQLite database. No npm packages needed.

## Run

Requires Node.js 22.5 or newer (`node --version`).

```
node server.js
```

Open http://localhost:3000. Other devices on the same Wi-Fi can use http://<this-computer-ip>:3000.

Optional settings (environment variables):

- `PORT` (default 3000)
- `TAX_PERCENT` (default 0), for example `TAX_PERCENT=16`
- `CURRENCY` (default `Rs`)

Windows PowerShell example: `$env:TAX_PERCENT=16; node server.js`

The database is the file `pos.db`, created on first run with a sample menu. Back it up by copying that file.
An existing `pos.db` from the earlier version upgrades automatically.

## Menu

The Al Naaz Biryani menu lives in `menu.js`. A new database loads it automatically.
If you already ran an earlier version (so `pos.db` exists), load it with:

```
node server.js --load-menu
```

This replaces the menu. Items that appear in past orders are hidden, not deleted, so old receipts and reports stay correct.
Small price changes are easier from the **Menu** screen in the app. Set the name on receipts with `RESTAURANT_NAME`.

## Login

On the first run the terminal prints a one-time admin password:

```
ADMIN LOGIN   username: admin   password: xxxxxxxx
```

Log in, click **Password** (top right) to change it, then add staff in the **Users** tab.

- **Admin:** everything (menu, reports, users, orders)
- **Cashier:** orders and payments only

Forgot the admin password? Stop the server and run `node server.js --reset-admin` to get a new one.
Sessions last 12 hours. Five wrong passwords from one device lock it for a minute.
The login cookie works over plain http on your restaurant network. If you ever put this on the internet, put it behind https.

## What it does

- Order screen: tap items, set quantity, table or takeaway, discount
- Open orders: edit, pay, or cancel
- Payment: cash (with change) or card, then a printable receipt
- Menu: add, edit, hide, delete items and categories
- Reports: daily sales, payment methods, top items

Prices are whole numbers (no decimals).
