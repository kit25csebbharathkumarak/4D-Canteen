# 🍽️ SmartCanteen Cloud (CanteenOS)

> Modern Multi-Tenant Campus Dining & Food Court SaaS Platform

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-blue.svg)](https://www.postgresql.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-orange.svg)](https://socket.io)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

SmartCanteen Cloud transforms single-canteen cafeterias into a multi-tenant cloud ecosystem where multiple universities, colleges, corporate campuses, and food courts can operate independently with their own digital storefronts, customized UPI payments, kitchen order displays, and printable table QR standees.

---

## ✨ Features

- 🏢 **Multi-Tenant Architecture**: Complete data isolation across tenants (`tenants`, `items`, `orders`, `users`, `bulk_orders`).
- ⚡ **Zero-Wait Campus Ordering**: Diners browse today's menu, customize carts, and checkout with contactless UPI.
- 📱 **Table QR Standees**: Canteen operators can generate and download high-resolution QR codes to place on dining tables.
- 🛠️ **SaaS Super Admin Command Center**: Platform-wide metrics (GMV, order volume, revenue), tenant provisioning, and plan management.
- 🚀 **Self-Service Canteen Onboarding**: New cafeterias can launch in under 60 seconds with auto-generated slugs and starter menus.
- 🔔 **Scoped Real-Time WebSockets**: Live order board updates and kitchen audio chimes strictly routed to the canteen's own staff.
- 💳 **Decentralized UPI & Payment Support**: Each canteen accepts payments directly to their own UPI ID or payment gateway.
- 🛡️ **Defense-in-Depth Security**: Phone OTP verification, invisible Google reCAPTCHA, rate limiting, and SQL injection defenses.

---

## 🧭 Portals & Navigation

| Portal | Path | Purpose |
|---|---|---|
| **Platform Landing Page** | `/frontend/index.html` | SaaS pricing, features, and canteen discovery |
| **All Canteens Directory** | `/frontend/canteens.html` | Browse all active campus cafeterias with live open/closed badges |
| **Canteen Self-Registration** | `/frontend/canteen-signup.html` | Instant 14-day free trial cafeteria onboarding |
| **Super Admin Console** | `/frontend/super-admin.html` | Platform owner controls, global GMV, tenant provisioning |
| **Canteen Admin Dashboard** | `/frontend/admin.html` | Live order queue, scan order QR, table QR standee, canteen branding & UPI |
| **Menu Storefront** | `/frontend/menu.html?canteen=<slug>` | Customized customer menu & contactless ordering |

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL (`pg` pool) with automated table migrations
- **Real-Time Engine**: Socket.IO
- **Frontend**: HTML5, Vanilla JavaScript, Responsive CSS3
- **Security**: JWT Authentication, bcrypt, Helmet, Express Rate Limit, Google reCAPTCHA

---

## 🚀 Getting Started

### 1. Clone the Repository
```bash
git clone https://github.com/kit25csebbharathkumarak/4D-Canteen.git
cd 4D-Canteen
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and configure your database and secrets:
```bash
cp .env.example .env
```

Key environment variables:
```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/canteen_db
JWT_SECRET=your_jwt_secret_key_here
SUPERADMIN_EMAIL=superadmin@smartcanteen.io
SUPERADMIN_PASSWORD=SuperAdmin@2026!
```

### 4. Run the Platform
```bash
# Start server (auto-runs database migrations)
npm start

# Or with live reload in development
npm run dev
```

Visit `http://localhost:3000/frontend/index.html` in your browser.

---

## 👤 Default Credentials

- **Super Admin**: `superadmin@smartcanteen.io` / `SuperAdmin@2026!`
- **Canteen #1 Admin**: Defined via `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
- **Customer / Diner**: Register directly at `/frontend/register.html` or login with Google.

---

## 📄 License
MIT License. Built for modern campus dining.
