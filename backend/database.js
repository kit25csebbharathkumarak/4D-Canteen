const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Set DATABASE_URL in your environment.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.PG_MAX_POOL || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  statement_timeout: 30000,
});

pool.on('error', (err) => {
  console.error('[pg pool] Unexpected error on idle database client:', err.message);
});

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ... style
const formatQuery = (sql, params = []) => {
  let index = 0;
  const formattedSql = sql.replace(/\?/g, () => `$${++index}`);
  return { sql: formattedSql, params };
};

const db = {
  isPostgres: true,
  pool,
  run(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: formatted, params: converted } = formatQuery(sql, params);
    pool.query(formatted, converted)
      .then(result => {
        const info = { changes: result.rowCount, lastID: result.rows?.[0]?.id ?? null };
        if (callback) callback(null, info);
      })
      .catch(err => { if (callback) callback(err); });
  },
  get(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: formatted, params: converted } = formatQuery(sql, params);
    pool.query(formatted, converted)
      .then(result => callback(null, result.rows[0] || null))
      .catch(err => callback(err));
  },
  all(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: formatted, params: converted } = formatQuery(sql, params);
    pool.query(formatted, converted)
      .then(result => callback(null, result.rows))
      .catch(err => callback(err));
  },
  serialize(fn) { fn(); },
  close() { return pool.end(); }
};

// --- DEFAULT SEED DATA ---
const defaultItems = [
  ['Empty Biryani',   20,  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=500&q=80', 50],
  ['Chicken Biryani', 110, 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=500&q=80', 30],
  ['Curd Rice',        30, 'https://images.unsplash.com/photo-1576107232684-1279f3908594?auto=format&fit=crop&w=500&q=80', 100],
  ['Parota Set',       30, 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=500&q=80', 40],
  ['Chicken Rice',    110, 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=500&q=80', 25],
];

// --- DATABASE INITIALISATION ---
const initializeDatabase = async () => {
  // Subscription plans table for SaaS monetization
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      price_monthly      NUMERIC NOT NULL DEFAULT 0,
      max_items          INTEGER DEFAULT 50,
      max_monthly_orders INTEGER DEFAULT 500,
      commission_percent NUMERIC DEFAULT 0,
      features           JSONB DEFAULT '[]'::jsonb,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tenants / Canteens table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      slug          TEXT UNIQUE NOT NULL,
      tagline       TEXT,
      description   TEXT,
      logo_url      TEXT,
      banner_url    TEXT,
      theme_color   TEXT DEFAULT '#f97316',
      contact_email TEXT,
      contact_phone TEXT,
      address       TEXT,
      upi_id        TEXT,
      upi_name      TEXT,
      is_shop_open  BOOLEAN DEFAULT TRUE,
      plan_tier     TEXT DEFAULT 'growth',
      status        TEXT DEFAULT 'active',
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)`);

  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL,
      email              TEXT UNIQUE NOT NULL,
      password           TEXT NOT NULL,
      role               TEXT DEFAULT 'student',
      tenant_id          INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
      is_superadmin      BOOLEAN DEFAULT FALSE,
      reset_token        TEXT,
      reset_token_expiry TIMESTAMP
    )
  `);

  // Multi-tenant column migrations for users
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE`);

  // Menu items table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id        SERIAL PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      price     NUMERIC NOT NULL,
      image     TEXT NOT NULL,
      available BOOLEAN DEFAULT TRUE,
      stock     INTEGER DEFAULT 0
    )
  `);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_tenant_id ON items(tenant_id)`);

  // Settings table (legacy global fallback)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await pool.query(`
    INSERT INTO settings (key, value) 
    VALUES ('shop_open', 'true') 
    ON CONFLICT (key) DO NOTHING
  `);

  // Tenant-specific settings table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key)
    )
  `);

  // Orders table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      items           TEXT NOT NULL,
      total           NUMERIC NOT NULL,
      status          TEXT DEFAULT 'Pending',
      paytm_order_id  TEXT,
      paytm_payment_id TEXT,
      user_id         INTEGER REFERENCES users(id),
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      txn_ref         TEXT,
      txn_id          TEXT,
      paid_at         TIMESTAMP,
      is_cleared      BOOLEAN DEFAULT FALSE
    )
  `);

  // Multi-tenant columns for orders
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS txn_ref TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS txn_id  TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS zoho_payment_session_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_cleared BOOLEAN DEFAULT FALSE`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_txn_id ON orders(txn_id) WHERE txn_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders(tenant_id)`);

  // Orders Archive table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders_archive (
      id              TEXT PRIMARY KEY,
      tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      items           TEXT NOT NULL,
      total           NUMERIC NOT NULL,
      status          TEXT DEFAULT 'Delivered',
      paytm_order_id  TEXT,
      paytm_payment_id TEXT,
      user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      txn_ref         TEXT,
      txn_id          TEXT,
      paid_at         TIMESTAMP,
      zoho_payment_session_id TEXT,
      is_cleared      BOOLEAN DEFAULT TRUE
    )
  `);
  await pool.query(`ALTER TABLE orders_archive ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_archive_created_at ON orders_archive(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_archive_tenant_id ON orders_archive(tenant_id)`);

  // Transactions table — for webhook idempotency
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      txn_id     TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL,
      status     TEXT NOT NULL,
      amount     NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Bulk Orders table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bulk_orders (
      id                  TEXT PRIMARY KEY,
      tenant_id           INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
      event_name          TEXT NOT NULL,
      event_date          DATE NOT NULL,
      event_time          TEXT NOT NULL,
      headcount           INTEGER NOT NULL,
      items               TEXT NOT NULL,
      custom_requirements TEXT,
      contact_name        TEXT NOT NULL,
      contact_phone       TEXT NOT NULL,
      delivery_location   TEXT NOT NULL,
      estimated_total     NUMERIC NOT NULL DEFAULT 0,
      final_price         NUMERIC,
      status              TEXT NOT NULL DEFAULT 'Pending Review',
      admin_notes         TEXT,
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE bulk_orders ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bulk_orders_tenant_id ON bulk_orders(tenant_id)`);

  // --- SEED SUBSCRIPTION PLANS ---
  const existingPlans = await pool.query('SELECT COUNT(*)::int AS count FROM subscription_plans');
  if (parseInt(existingPlans.rows[0].count, 10) === 0) {
    const plans = [
      ['free_trial', '14-Day Free Trial', 0, 20, 200, 2.0, JSON.stringify(['Instant Setup', 'QR Menu', 'Basic Order Management', '14-Day Access'])],
      ['starter', 'Campus Starter', 1499, 40, 1000, 1.5, JSON.stringify(['Up to 40 Menu Items', 'QR Code Ordering', 'Live Kitchen Screen', 'Email Receipts', 'Daily Revenue Stats'])],
      ['growth', 'Pro Canteen', 2999, 100, 5000, 1.0, JSON.stringify(['Up to 100 Menu Items', 'Priority Kitchen Display', 'Bulk Event Catering Module', 'Detailed Analytics & Export', 'Custom Branding & Domain', 'Dedicated Support'])],
      ['enterprise', 'Campus Enterprise', 5999, 500, 25000, 0.5, JSON.stringify(['Unlimited Menu Items', 'Multi-Counter Operations', 'Custom Payment Gateway Integration', 'Automated Daily Financial Reconciliation', 'SLA & 24/7 Priority Hotline'])]
    ];
    for (const plan of plans) {
      await pool.query(
        'INSERT INTO subscription_plans (id, name, price_monthly, max_items, max_monthly_orders, commission_percent, features) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        plan
      );
    }
    console.log('[SaaS] Subscription plans seeded.');
  }

  // --- SEED OR LOAD DEFAULT TENANT (TENANT 1) ---
  let defaultTenant = await pool.query("SELECT id FROM tenants WHERE slug = 'kit-coimbatore' LIMIT 1");
  let defaultTenantId;
  if (defaultTenant.rows.length === 0) {
    const insertRes = await pool.query(`
      INSERT INTO tenants (
        name, slug, tagline, description,
        logo_url, banner_url, theme_color,
        contact_email, contact_phone, address,
        upi_id, upi_name, is_shop_open, plan_tier, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      ) RETURNING id
    `, [
      'Sri Cumin Seeds - KIT Coimbatore',
      'kit-coimbatore',
      'Campus Canteen & Fresh Bites',
      'Order fresh campus meals online at Kalaignar Karunanidhi Institute of Technology (KIT), Coimbatore. Skip the queue, pay online, and pick up hot food.',
      'logo.png',
      'biryani.jpg',
      '#f97316',
      'canteen@kitcbe.com',
      '+91 9876543210',
      'KIT Campus, Kannampalayam Post, Coimbatore - 641402',
      'sricuminseeds@okaxis',
      'SRI CUMIN SEEDS CATERING',
      true,
      'growth',
      'active'
    ]);
    defaultTenantId = insertRes.rows[0].id;
    console.log(`[SaaS] Default tenant 1 (Sri Cumin Seeds - KIT Coimbatore) created with ID ${defaultTenantId}.`);
  } else {
    defaultTenantId = defaultTenant.rows[0].id;
  }

  // --- SEED DEMO TENANT (TENANT 2) FOR MULTI-TENANCY DEMONSTRATION ---
  const demoTenant = await pool.query("SELECT id FROM tenants WHERE slug = 'techhub-diner' LIMIT 1");
  if (demoTenant.rows.length === 0) {
    const insertDemo = await pool.query(`
      INSERT INTO tenants (
        name, slug, tagline, description,
        logo_url, banner_url, theme_color,
        contact_email, contact_phone, address,
        upi_id, upi_name, is_shop_open, plan_tier, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      ) RETURNING id
    `, [
      'TechHub Metro Diner',
      'techhub-diner',
      'Artisanal Cafe & Express Meals',
      'Premium gourmet coffee, continental bowls, wraps, and quick bites for busy creators & tech teams.',
      'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=200&q=80',
      'https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&w=1200&q=80',
      '#0ea5e9',
      'hello@techhubdiner.com',
      '+91 9123456780',
      'Floor 2, TechHub Innovation Park, Coimbatore',
      'techhubdiner@icici',
      'TECHHUB METRO DINER',
      true,
      'enterprise',
      'active'
    ]);
    const demoTenantId = insertDemo.rows[0].id;

    // Seed demo items for tenant 2
    const demoItems = [
      ['Artisan Cold Brew', 90, 'https://images.unsplash.com/photo-1517701550927-30cf4ba1dba5?auto=format&fit=crop&w=500&q=80', 50, demoTenantId],
      ['Grilled Paneer Wrap', 120, 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?auto=format&fit=crop&w=500&q=80', 40, demoTenantId],
      ['Mediterranean Quinoa Bowl', 160, 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=500&q=80', 30, demoTenantId],
      ['Smoked Chicken Sub', 150, 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=500&q=80', 25, demoTenantId],
      ['Belgian Chocolate Waffle', 110, 'https://images.unsplash.com/photo-1562376552-0d160a2f238d?auto=format&fit=crop&w=500&q=80', 35, demoTenantId]
    ];
    for (const item of demoItems) {
      await pool.query(
        'INSERT INTO items (name, price, image, stock, tenant_id) VALUES ($1, $2, $3, $4, $5)',
        item
      );
    }
    console.log('[SaaS] Demo tenant 2 (TechHub Metro Diner) created with curated menu.');
  }

  // Seed menu items for tenant 1 if empty
  const itemsCount = await pool.query('SELECT COUNT(*)::int AS count FROM items WHERE tenant_id = $1', [defaultTenantId]);
  if (parseInt(itemsCount.rows[0].count, 10) === 0) {
    for (const item of defaultItems) {
      await pool.query(
        'INSERT INTO items (name, price, image, stock, tenant_id) VALUES ($1, $2, $3, $4, $5)',
        [...item, defaultTenantId]
      );
    }
    console.log('[SaaS] Seeded default menu items for Tenant 1.');
  }

  // Auto-migrate any existing records lacking tenant_id to tenant 1
  await pool.query('UPDATE items SET tenant_id = $1 WHERE tenant_id IS NULL', [defaultTenantId]);
  await pool.query('UPDATE orders SET tenant_id = $1 WHERE tenant_id IS NULL', [defaultTenantId]);
  await pool.query('UPDATE orders_archive SET tenant_id = $1 WHERE tenant_id IS NULL', [defaultTenantId]);
  await pool.query('UPDATE bulk_orders SET tenant_id = $1 WHERE tenant_id IS NULL', [defaultTenantId]);

  // --- INITIALIZE SUPERADMIN ACCOUNT ---
  const superAdminEmail = (process.env.SUPERADMIN_EMAIL || 'superadmin@smartcanteen.io').trim();
  const superAdminPassword = (process.env.SUPERADMIN_PASSWORD || 'SuperAdmin@2026!').trim();
  const superHash = bcrypt.hashSync(superAdminPassword, 10);

  const existingSuper = await pool.query("SELECT id FROM users WHERE is_superadmin = TRUE OR email = $1 LIMIT 1", [superAdminEmail]);
  if (existingSuper.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (name, email, password, role, is_superadmin) VALUES ($1, $2, $3, $4, TRUE)',
      ['SmartCanteen Super Admin', superAdminEmail, superHash, 'superadmin']
    );
    console.log(`[SaaS] Super Admin account initialized (${superAdminEmail}).`);
  } else {
    await pool.query(
      'UPDATE users SET name = $1, email = $2, password = $3, role = $4, is_superadmin = TRUE WHERE id = $5',
      ['SmartCanteen Super Admin', superAdminEmail, superHash, 'superadmin', existingSuper.rows[0].id]
    );
    console.log(`[SaaS] Super Admin account synchronized (${superAdminEmail}).`);
  }

  // Initialize or update tenant 1 canteen admin credentials from environment variables
  const adminIdentifier = (process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME || process.env.ADMIN_USER || '').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || '').trim();

  if (adminIdentifier && adminPassword) {
    const hash = bcrypt.hashSync(adminPassword, 10);
    const existingAdmin = await pool.query("SELECT id FROM users WHERE role = 'admin' AND tenant_id = $1 LIMIT 1", [defaultTenantId]);

    if (existingAdmin.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (name, email, password, role, tenant_id) VALUES ($1, $2, $3, $4, $5)',
        ['Sri Cumin Admin', adminIdentifier, hash, 'admin', defaultTenantId]
      );
      console.log('Canteen Admin account initialized for Tenant 1.');
    } else {
      await pool.query(
        'UPDATE users SET name = $1, email = $2, password = $3, tenant_id = $4 WHERE id = $5',
        ['Sri Cumin Admin', adminIdentifier, hash, defaultTenantId, existingAdmin.rows[0].id]
      );
      console.log('Canteen Admin account synchronized for Tenant 1.');
    }
  } else {
    // If no admin credentials provided in env, make sure existing admin has tenant_id = defaultTenantId
    await pool.query("UPDATE users SET tenant_id = $1 WHERE role = 'admin' AND tenant_id IS NULL", [defaultTenantId]);
  }

  console.log('[SaaS] Multi-tenant database initialised successfully.');
};

const startWithRetry = async (retries = 5, delayMs = 3000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await initializeDatabase();
      return;
    } catch (err) {
      console.error(`PostgreSQL initialization attempt ${attempt}/${retries} failed:`, err.message || err);
      if (attempt < retries) {
        console.log(`Retrying database connection in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.error('All PostgreSQL initialization attempts exhausted. Exiting...');
        process.exit(1);
      }
    }
  }
};

startWithRetry();

module.exports = db;
