require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const emailjs = require('@emailjs/nodejs');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const axios = require('axios');
const db = require('./database');
const { OAuth2Client } = require('google-auth-library');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET is required. Set JWT_SECRET in your environment.');
}
const JWT_SECRET = process.env.JWT_SECRET;

const app = express();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const server = http.createServer(app);

// Origin validation for CORS & WebSocket defense-in-depth
const parseAllowedOrigins = () => {
  const envOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  return Array.from(new Set([
    ...envOrigins,
    'https://kitcbecanteen.online',
    'https://www.kitcbecanteen.online',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173'
  ]));
};

const isOriginAllowed = (origin) => {
  if (!origin) return true; // Allow non-browser, server-to-server, or same-origin requests
  const allowed = parseAllowedOrigins();
  if (allowed.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.endsWith('onrender.com')) return true;
    if (parsed.hostname === 'kitcbecanteen.online' || parsed.hostname.endsWith('.kitcbecanteen.online')) return true;
  } catch (_) {}
  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true
};

const io = new Server(server, { cors: { origin: '*' } });

let isShopOpen = true;

// Initialize shop status from DB
setTimeout(() => {
  db.get("SELECT value FROM settings WHERE key = 'shop_open'", (err, row) => {
    if (row) isShopOpen = row.value === 'true';
  });
}, 2000); // slight delay to ensure DB is initialized

const activeCarts = {}; // activeCarts[userId] = { itemId: qty }
const activeConnections = {}; // activeConnections[userId] = count
const disconnectTimeouts = {}; // disconnectTimeouts[userId] = timerId

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.userId = decoded.id;
    socket.userRole = decoded.role;
    socket.tenantId = decoded.tenant_id;
    socket.isSuperAdmin = Boolean(decoded.is_superadmin);
    next();
  });
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  
  // Join private room for this specific user
  if (userId) {
    socket.join(`user_${userId}`);
  }

  // If authenticated user is staff/admin or superadmin, join dedicated admin room
  if (socket.userRole === 'admin' || socket.isSuperAdmin) {
    socket.join('admin');
    if (socket.tenantId) {
      socket.join(`tenant_${socket.tenantId}_admin`);
    }
  }

  // Allow client to subscribe to a specific canteen updates (menu, shop status)
  socket.on('subscribe_canteen', (canteenId) => {
    if (canteenId) {
      socket.join(`canteen_${canteenId}`);
    }
  });
  
  if (!activeCarts[userId]) activeCarts[userId] = {};
  if (!activeConnections[userId]) activeConnections[userId] = 0;
  
  activeConnections[userId]++;
  
  if (disconnectTimeouts[userId]) {
    clearTimeout(disconnectTimeouts[userId]);
    delete disconnectTimeouts[userId];
  }

  // Initial emit to restore cart state if any
  socket.emit('cart_updated', activeCarts[userId]);

  socket.on('update_cart', (data) => {
    if (!data || typeof data !== 'object') return;
    const cleanId = parseInt(data.itemId, 10);
    const cleanChange = parseInt(data.change, 10);
    if (isNaN(cleanId) || cleanId <= 0 || isNaN(cleanChange) || cleanChange === 0) return;

    db.get('SELECT id, name, stock, available FROM items WHERE id = ?', [cleanId], (err, item) => {
      if (err || !item) return socket.emit('cart_error', 'Item not found');
      if (!item.available) return socket.emit('cart_error', `${item.name} is currently unavailable`);

      const currentInCart = (activeCarts[userId] && activeCarts[userId][cleanId]) || 0;
      const targetQty = currentInCart + cleanChange;

      if (cleanChange > 0) {
        if (targetQty > item.stock) {
          return socket.emit('cart_error', `Cannot add more. Only ${item.stock} available in stock.`);
        }
        activeCarts[userId][cleanId] = targetQty;
        socket.emit('cart_updated', activeCarts[userId]);
      } else if (cleanChange < 0) {
        if (targetQty <= 0) {
          delete activeCarts[userId][cleanId];
        } else {
          activeCarts[userId][cleanId] = targetQty;
        }
        socket.emit('cart_updated', activeCarts[userId]);
      }
    });
  });

  socket.on('disconnect', () => {
    activeConnections[userId]--;
    if (activeConnections[userId] <= 0) {
      delete activeConnections[userId];
      disconnectTimeouts[userId] = setTimeout(() => {
        delete activeCarts[userId];
        delete disconnectTimeouts[userId];
      }, 30000);
    }
  });
});

// --- ZOHO PAYMENTS TOKEN CACHE ---
let cachedZohoToken = null;
let zohoTokenExpiry = null;
let lastTokenAcquiredAt = 0;
let tokenRefreshPromise = null;

function invalidateZohoToken(force = false) {
  // Only invalidate if token was acquired more than 10s ago, unless forced,
  // to avoid infinite refresh loops and OAuth 429 lockout
  if (force || Date.now() - lastTokenAcquiredAt > 10000) {
    cachedZohoToken = null;
    zohoTokenExpiry = null;
  }
}

const getZohoAccessToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedZohoToken && zohoTokenExpiry && Date.now() < zohoTokenExpiry) {
    return cachedZohoToken;
  }

  // Deduplicate concurrent token refresh requests
  if (tokenRefreshPromise) {
    return tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
    try {
      const params = new URLSearchParams();
      params.append('refresh_token', process.env.ZOHO_REFRESH_TOKEN || '');
      params.append('client_id', process.env.ZOHO_CLIENT_ID || '');
      params.append('client_secret', process.env.ZOHO_CLIENT_SECRET || '');
      params.append('grant_type', 'refresh_token');

      // Use .in or .com depending on your Zoho region (defaulting to .in)
      const accountsUrl = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';

      const res = await axios.post(`${accountsUrl}/oauth/v2/token`, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      });

      if (res.data && res.data.access_token) {
        cachedZohoToken = res.data.access_token;
        lastTokenAcquiredAt = Date.now();
        // Zoho returns expires_in in seconds (usually 3600). We subtract 5 minutes (300000ms) for safety
        const expiresInMs = (res.data.expires_in * 1000) || (60 * 60 * 1000);
        zohoTokenExpiry = Date.now() + expiresInMs - 300000;
        return cachedZohoToken;
      } else {
        const errMsg = res.data?.error_description || res.data?.error || 'No access token in response';
        console.error('[Zoho Auth] Error response:', res.data);
        invalidateZohoToken(true);
        throw new Error(errMsg);
      }
    } catch (err) {
      invalidateZohoToken(true);
      const errMsg = err.response?.data?.error_description || err.response?.data?.error || err.message;
      console.error('[Zoho Auth] Error getting token:', errMsg);
      throw new Error(`Failed to get Zoho Access Token: ${errMsg}`);
    } finally {
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
};

async function createZohoPaymentSession(amount, orderId = '', retryOn401 = true) {
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  if (!accountId || !process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_REFRESH_TOKEN) {
    const err = new Error('Payment gateway is not currently configured on the server.');
    err.statusCode = 503;
    throw err;
  }

  const accessToken = await getZohoAccessToken();
  try {
    const payload = {
      amount: Math.round(Number(amount) * 100) / 100,
      currency: "INR"
    };
    if (orderId) {
      payload.description = `Order ${orderId}`;
    }

    const zohoRes = await axios.post(
      `https://payments.zoho.in/api/v1/paymentsessions?account_id=${accountId}`,
      payload,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const paymentSessionId = zohoRes.data?.payments_session?.payments_session_id;
    if (!paymentSessionId) {
      throw new Error('Zoho did not return a valid payments_session_id');
    }
    return paymentSessionId;
  } catch (err) {
    if (err.response?.status === 401 && retryOn401) {
      console.warn('[Zoho Payments] Session creation received 401 Unauthorized, forcing token refresh and retrying once...');
      invalidateZohoToken(true);
      return createZohoPaymentSession(amount, orderId, false);
    }
    const gatewayMsg = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[Zoho Payments] Session creation failed:', err.response?.status, gatewayMsg);
    const errorToThrow = new Error(gatewayMsg || 'Failed to initiate payment session with Zoho Payments.');
    errorToThrow.statusCode = err.response?.status === 429 ? 429 : 502;
    throw errorToThrow;
  }
}


// --- HELMET + CORS + STATIC FILES ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://accounts.google.com",
        "https://static.zohocdn.com",
        "https://payments.zoho.in",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
        "https://www.gstatic.com",
        "https://apis.google.com",
        "https://www.google.com",
        "https://*.google.com",
        "https://www.google.com/recaptcha/",
        "https://recaptcha.google.com/",
        "https://applepay.cdn-apple.com",
        "https://*.cdn-apple.com",
        "https://*.apple.com"
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdnjs.cloudflare.com",
        "https://static.zohocdn.com"
      ],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdnjs.cloudflare.com",
        "https://static.zohocdn.com",
        "https://applepay.cdn-apple.com",
        "https://*.cdn-apple.com",
        "https://*.apple.com"
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https:"
      ],
      connectSrc: [
        "'self'",
        "https://accounts.google.com",
        "https://payments.zoho.in",
        "https://static.zohocdn.com",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://*.firebaseio.com",
        "https://*.googleapis.com",
        "https://www.google.com",
        "https://*.google.com",
        "https://www.gstatic.com",
        "https://applepay.cdn-apple.com",
        "https://*.cdn-apple.com",
        "https://*.apple.com",
        "wss:",
        "ws:"
      ],
      frameSrc: [
        "'self'",
        "https://accounts.google.com",
        "https://payments.zoho.in",
        "https://*.firebaseapp.com",
        "https://www.google.com",
        "https://*.google.com",
        "https://www.google.com/recaptcha/",
        "https://recaptcha.google.com/",
        "https://applepay.cdn-apple.com",
        "https://*.cdn-apple.com",
        "https://*.apple.com"
      ],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" } // Allows Google OAuth popup to postMessage to parent
}));
app.use(cors(corsOptions));
app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// --- GLOBAL JSON PARSER (limit payload size) ---
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({
  extended: false,
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// --- SECURITY & INPUT SANITIZATION HELPERS ---
function sanitizeTextInput(val, maxLength = 255) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/\0/g, '') // Remove null bytes
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Strip script tags with inner content
    .replace(/<[^>]+>/g, '') // Strip HTML tags
    .trim()
    .slice(0, maxLength);
}

// Deep defense: eliminate prototype pollution (__proto__, constructor, prototype) and null bytes
function deepSanitizeObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return;
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      delete obj[key];
      continue;
    }
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(/\0/g, '');
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      deepSanitizeObject(obj[key], depth + 1);
    }
  }
}

app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') deepSanitizeObject(req.body);
  if (req.query && typeof req.query === 'object') deepSanitizeObject(req.query);
  if (req.params && typeof req.params === 'object') deepSanitizeObject(req.params);
  next();
});

// --- RATE LIMITERS ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // limit each IP to 25 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' }
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10, // limit each IP to 10 OTP requests per 10 mins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests from this IP. Please try again after 10 minutes.' }
});

// --- AUTH MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access Denied. Please log in.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin' && !req.user.is_superadmin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  });
}

function requireSuperAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (!req.user.is_superadmin && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super Admin platform access required.' });
    }
    next();
  });
}

function requireTenantAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user.is_superadmin || req.user.role === 'superadmin') return next();
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const requestedTenant = req.headers['x-tenant-id'] || req.query.tenant_id || req.body?.tenant_id;
    if (requestedTenant && req.user.tenant_id && parseInt(requestedTenant, 10) !== parseInt(req.user.tenant_id, 10)) {
      return res.status(403).json({ error: 'Access denied to this canteen.' });
    }
    next();
  });
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) {
    req.user = null;
    return next();
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    else req.user = null;
    next();
  });
}

// --- AUTH ROUTES & FIREBASE PHONE AUTHENTICATION ---
const otps = new Map(); // identifier (email or phone) -> { otp, expiresAt }

function normalizeIndianPhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return `91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) {
    return digits;
  }
  return null;
}

// Opportunistic cleanup of expired OTPs to prevent memory leaks
function pruneExpiredOtps() {
  const now = Date.now();
  for (const [key, data] of otps.entries()) {
    if (now > data.expiresAt) otps.delete(key);
  }
}
setInterval(pruneExpiredOtps, 5 * 60 * 1000); // Clean every 5 minutes

// Helper: Verify Firebase Phone Auth ID Token
async function verifyFirebaseToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;

  // 1. Google Identity Toolkit REST API verification
  const apiKey = process.env.FIREBASE_API_KEY;
  if (apiKey) {
    try {
      const res = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
        { idToken },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      if (res.data?.users && res.data.users.length > 0) {
        const user = res.data.users[0];
        return {
          uid: user.localId,
          phoneNumber: user.phoneNumber || null,
          email: user.email || null
        };
      }
    } catch (apiErr) {
      console.error('[Firebase Token Lookup] Google Identity Toolkit API error:', apiErr.response?.data || apiErr.message);
    }
  }

  // 2. JWT Decode verification (verifies project ID, aud, iss, exp if configured)
  try {
    const decoded = jwt.decode(idToken);
    if (decoded && (decoded.phone_number || decoded.sub)) {
      if (process.env.FIREBASE_PROJECT_ID) {
        const expectedAud = process.env.FIREBASE_PROJECT_ID;
        const expectedIss = `https://securetoken.google.com/${expectedAud}`;
        if (decoded.aud !== expectedAud || decoded.iss !== expectedIss) {
          console.warn('[Firebase Auth] Token aud/iss mismatch:', { aud: decoded.aud, iss: decoded.iss });
          return null;
        }
      }
      if (decoded.exp && decoded.exp * 1000 < Date.now()) {
        console.warn('[Firebase Auth] Token expired');
        return null;
      }
      return {
        uid: decoded.user_id || decoded.sub,
        phoneNumber: decoded.phone_number || null,
        email: decoded.email || null
      };
    }
  } catch (jwtErr) {
    console.error('[Firebase Token Decode] Error:', jwtErr.message);
  }

  return null;
}

// Expose public Firebase Web configuration for frontend authentication
app.get('/api/auth/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  });
});

// Expose public reCAPTCHA site key for bot defense
app.get('/api/auth/recaptcha-config', (req, res) => {
  res.json({ siteKey: process.env.RECAPTCHA_SITE_KEY || '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI' });
});

// Server-side Google reCAPTCHA verification helper
async function verifyRecaptcha(token, remoteIp) {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY || '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';
  if (!token) {
    return { success: false, error: 'Security verification failed or missing. Please try again.' };
  }
  try {
    const params = new URLSearchParams();
    params.append('secret', secretKey);
    params.append('response', token);
    if (remoteIp) params.append('remoteip', remoteIp);

    const res = await axios.post('https://www.google.com/recaptcha/api/siteverify', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000
    });

    if (res.data && res.data.success) {
      return { success: true };
    } else {
      console.warn('[reCAPTCHA] Failed response from Google:', res.data);
      return { success: false, error: 'reCAPTCHA verification failed. Please try again.' };
    }
  } catch (err) {
    console.error('[reCAPTCHA] Service error:', err.message);
    return { success: false, error: 'Security verification service temporarily unavailable. Please retry.' };
  }
}

// Lightweight pre-check for real-time field validation on register page
app.get('/api/auth/check-availability', (req, res) => {
  const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  const rawPhone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';

  const cleanPhone = rawPhone ? normalizeIndianPhoneNumber(rawPhone) : null;
  const cleanEmail = (rawEmail && EMAIL_REGEX.test(rawEmail)) ? rawEmail : null;

  if (!cleanEmail && !cleanPhone) {
    return res.json({ available: true });
  }

  const query = (cleanEmail && cleanPhone)
    ? 'SELECT id, email, phone FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)'
    : cleanEmail
      ? 'SELECT id, email, phone FROM users WHERE LOWER(email) = LOWER(?)'
      : 'SELECT id, email, phone FROM users WHERE phone = ?';
  const params = (cleanEmail && cleanPhone)
    ? [cleanPhone, cleanEmail]
    : cleanEmail ? [cleanEmail] : [cleanPhone];

  db.get(query, params, (err, row) => {
    if (err) return res.status(500).json({ error: 'Unable to verify details at this moment. Please try again.' });
    if (row) {
      if (cleanPhone && row.phone === cleanPhone) {
        return res.json({
          available: false,
          field: 'phone',
          error: 'This mobile number is already registered. Please login.'
        });
      }
      if (cleanEmail && row.email && row.email.toLowerCase() === cleanEmail) {
        return res.json({
          available: false,
          field: 'email',
          error: 'This email address is already registered. Please login.'
        });
      }
    }
    res.json({ available: true });
  });
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Check phone/email availability or send email OTP fallback
app.post('/api/auth/send-otp', optionalAuth, otpLimiter, async (req, res) => {
  const { phone, email } = req.body;
  const cleanEmail = (typeof email === 'string' ? email.trim().toLowerCase() : '');

  // 1. Phone availability check
  if (phone) {
    const cleanPhone = normalizeIndianPhoneNumber(phone);
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).' });
    }

    if (cleanEmail && (!EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 100)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Check if phone or email already registered
    let query;
    let params;
    if (req.user && req.user.id) {
      // Authenticated user linking phone number to their existing account
      query = 'SELECT id, email, phone FROM users WHERE phone = ? AND id != ?';
      params = [cleanPhone, req.user.id];
    } else {
      // New user registering
      query = cleanEmail 
        ? 'SELECT id, email, phone FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)'
        : 'SELECT id, email, phone FROM users WHERE phone = ?';
      params = cleanEmail ? [cleanPhone, cleanEmail] : [cleanPhone];
    }

    return db.get(query, params, async (checkErr, existingUser) => {
      if (checkErr) {
        console.error('[send-otp] DB error:', checkErr);
        return res.status(500).json({ error: 'Unable to verify details at this moment. Please try again.' });
      }
      if (existingUser) {
        if (existingUser.phone === cleanPhone) {
          return res.status(400).json({
            error: 'This mobile number is already registered. Please login.',
            already_registered: true,
            field: 'phone'
          });
        }
        if (cleanEmail && existingUser.email && existingUser.email.toLowerCase() === cleanEmail) {
          return res.status(400).json({
            error: 'This email address is already registered. Please login.',
            already_registered: true,
            field: 'email'
          });
        }
      }

        // In local development sandbox mode when Firebase is not yet configured, provide dev OTP
        if (!process.env.FIREBASE_API_KEY) {
          if (process.env.NODE_ENV !== 'production') {
            const devOtp = Math.floor(100000 + Math.random() * 900000).toString();
            otps.set(cleanPhone, { otp: devOtp, expiresAt: Date.now() + 5 * 60 * 1000 });
            return res.json({
              success: true,
              channel: 'firebase_dev',
              message: `Dev Sandbox: Mobile number available. Test OTP is: ${devOtp}`
            });
          }
          return res.status(503).json({
            error: 'SMS verification is temporarily unavailable. Please try again later or contact support.'
          });
        }

        return res.json({
          success: true,
          channel: 'firebase',
          message: 'Mobile number verified available. Proceeding with Firebase verification.'
        });
      }
    );
  }

  // 2. Email OTP Fallback
  if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 100) {
    return res.status(400).json({ error: 'A valid email or phone number is required.' });
  }

  // Generate 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  otps.set(cleanEmail, { otp, expiresAt });

  try {
    const templateParams = {
      to_email: cleanEmail,
      otp: otp,
      message: `Your One-Time Password (OTP) for SRI CUMIN SEEDS CATERING SERVICES is: ${otp}. It is valid for 5 minutes.`
    };

    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      templateParams,
      {
        publicKey: process.env.EMAILJS_PUBLIC_KEY,
        privateKey: process.env.EMAILJS_PRIVATE_KEY,
      }
    );
    
    res.json({ success: true, channel: 'email', message: 'Verification code sent to your email.' });
  } catch (err) {
    console.error('Send OTP Email exception:', err);
    return res.status(500).json({ error: 'Failed to send verification code to your email.' });
  }
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  let { name, email, password, phone, otp, firebaseIdToken } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Missing required registration fields' });
  }

  // Sanitize and validate name
  name = sanitizeTextInput(name, 60);
  if (name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: 'Name must be between 2 and 60 characters and cannot contain scripts or HTML.' });
  }

  // Validate email
  if (typeof email !== 'string') return res.status(400).json({ error: 'Invalid email format' });
  email = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(email) || email.length > 100) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  // Validate password
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be between 6 and 100 characters.' });
  }

  let cleanPhone = null;
  let isPhoneVerified = false;

  // Phone verification via Firebase Phone Auth
  if (phone) {
    cleanPhone = normalizeIndianPhoneNumber(phone);
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
    }

    // Check duplicate phone or email
    const duplicateCheck = await new Promise((resolve) => {
      db.get(
        'SELECT id, email, phone FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)',
        [cleanPhone, email],
        (err, row) => resolve({ err, row })
      );
    });

    if (duplicateCheck.err) {
      return res.status(500).json({ error: 'Unable to verify details at this moment. Please try again.' });
    }

    if (duplicateCheck.row) {
      if (duplicateCheck.row.phone === cleanPhone) {
        return res.status(400).json({
          error: 'This mobile number is already registered. Please login.',
          already_registered: true,
          field: 'phone'
        });
      }
      if (duplicateCheck.row.email.toLowerCase() === email) {
        return res.status(400).json({
          error: 'This email address is already registered. Please login.',
          already_registered: true,
          field: 'email'
        });
      }
    }

    // 1. Verify via Firebase ID Token
    if (firebaseIdToken) {
      const verifiedFirebaseUser = await verifyFirebaseToken(firebaseIdToken);
      if (!verifiedFirebaseUser || !verifiedFirebaseUser.phoneNumber) {
        return res.status(400).json({ error: 'Phone verification could not be completed. Please try again.' });
      }

      const verifiedPhoneNormalized = normalizeIndianPhoneNumber(verifiedFirebaseUser.phoneNumber);
      if (verifiedPhoneNormalized !== cleanPhone) {
        return res.status(400).json({ error: 'The verified mobile number does not match the registration phone number.' });
      }

      isPhoneVerified = true;
    } else if (otp) {
      // 2. Fallback verification via local OTP
      const cleanOtp = String(otp).trim();
      const storedOtpData = otps.get(cleanPhone) || otps.get(email);
      if (!storedOtpData || storedOtpData.otp !== cleanOtp) {
        return res.status(400).json({ error: 'Invalid verification code.' });
      }
      if (Date.now() > storedOtpData.expiresAt) {
        otps.delete(cleanPhone);
        return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
      }
      otps.delete(cleanPhone);
      isPhoneVerified = true;
    } else if (!process.env.FIREBASE_API_KEY && process.env.NODE_ENV !== 'production') {
      // 3. Local dev fallback when Firebase is not yet configured
      console.log(`[Auth DEV] Registering ${email} with phone ${cleanPhone} in local dev mode without Firebase.`);
      isPhoneVerified = true;
    } else {
      return res.status(400).json({ error: 'Mobile phone verification is required.' });
    }
  } else {
    // Email OTP fallback
    if (!otp) return res.status(400).json({ error: 'Verification code is required.' });
    const cleanOtp = String(otp).trim();
    const storedOtpData = otps.get(email);
    if (!storedOtpData || storedOtpData.otp !== cleanOtp) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }
    if (Date.now() > storedOtpData.expiresAt) {
      otps.delete(email);
      return res.status(400).json({ error: 'Verification code has expired.' });
    }
    otps.delete(email);
  }

  const hash = bcrypt.hashSync(password, 10);
  db.run(
    "INSERT INTO users (name, email, password, role, phone, phone_verified) VALUES (?, ?, ?, 'student', ?, ?) RETURNING id, name, email, phone, role",
    [name, email, hash, cleanPhone, isPhoneVerified],
    function (err, info) {
      if (err) {
        if (err.message.includes('unique') || err.message.includes('UNIQUE')) {
          if (err.message.includes('phone')) {
            return res.status(400).json({ error: 'This mobile number is already registered. Please login.' });
          }
          return res.status(400).json({ error: 'Email already exists.' });
        }
        return res.status(500).json({ error: err.message });
      }
      const userId = info?.lastID || this?.lastID;
      const token = jwt.sign({ id: userId, email, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: userId, name, email, phone: cleanPhone, role: 'student' } });
    }
  );
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, username, password, recaptchaToken } = req.body;
  const rawIdentifier = (typeof email === 'string' ? email : typeof username === 'string' ? username : '').trim();
  const loginIdentifier = sanitizeTextInput(rawIdentifier, 100);

  if (!loginIdentifier || typeof password !== 'string' || password.length === 0 || password.length > 100) {
    return res.status(400).json({ error: 'Valid Email/Mobile and password are required' });
  }

  // Security: verify reCAPTCHA against bot credential stuffing attacks
  const recaptchaCheck = await verifyRecaptcha(recaptchaToken, req.ip);
  if (!recaptchaCheck.success) {
    return res.status(400).json({ error: recaptchaCheck.error });
  }

  const possiblePhone = normalizeIndianPhoneNumber(loginIdentifier);

  db.get(
    'SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(name) = LOWER(?) OR phone = ? OR phone = ?',
    [loginIdentifier, loginIdentifier, loginIdentifier, possiblePhone || ''],
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) {
        return res.status(404).json({
          error: 'This account is not registered. Please create an account first.',
          not_registered: true
        });
      }

      const valid = bcrypt.compareSync(password, user.password);
      if (!valid) {
        return res.status(401).json({
          error: 'Incorrect password. Please try again or use Forgot Password.'
        });
      }

      const isSuper = Boolean(user.is_superadmin || user.role === 'superadmin');
      const token = jwt.sign({
        id: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id || (user.role === 'admin' ? 1 : null),
        is_superadmin: isSuper
      }, JWT_SECRET, { expiresIn: '7d' });
      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone || null,
          phone_verified: Boolean(user.phone_verified),
          role: user.role,
          tenant_id: user.tenant_id || (user.role === 'admin' ? 1 : null),
          is_superadmin: isSuper
        }
      });
    }
  );
});

app.get('/api/auth/google-client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const name = payload.name;

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
      if (err) return res.status(500).json({ error: err.message });

      if (user) {
        // User exists, log them in
        const jwtToken = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({
          token: jwtToken,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone || null,
            phone_verified: Boolean(user.phone_verified),
            role: user.role
          }
        });
      } else {
        // User doesn't exist, create account
        const randomPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);
        
        db.run(
          'INSERT INTO users (name, email, password, role, phone_verified) VALUES (?, ?, ?, ?, FALSE) RETURNING id',
          [name, email, hashedPassword, 'student'],
          (insertErr, info) => {
            if (insertErr) return res.status(500).json({ error: insertErr.message });
            
            const newUserId = info.lastID;
            const jwtToken = jwt.sign({ id: newUserId, email: email, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({
              token: jwtToken,
              user: {
                id: newUserId,
                name: name,
                email: email,
                phone: null,
                phone_verified: false,
                role: 'student'
              }
            });
          }
        );
      }
    });

  } catch (error) {
    console.error('Google verification error:', error);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// Refresh user profile details including phone verification status
app.get('/api/auth/me', authenticateToken, (req, res) => {
  db.get('SELECT id, name, email, phone, phone_verified, role, tenant_id, is_superadmin FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ error: 'Unable to process request. Please try again.' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const isSuper = Boolean(user.is_superadmin || user.role === 'superadmin');
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        phone_verified: Boolean(user.phone_verified),
        role: user.role,
        tenant_id: user.tenant_id || (user.role === 'admin' ? 1 : null),
        is_superadmin: isSuper
      }
    });
  });
});

// Link & verify phone number on an existing account (e.g., Google OAuth users)
app.post('/api/auth/verify-phone', authenticateToken, async (req, res) => {
  const { phone, firebaseIdToken, otp } = req.body;
  const userId = req.user.id;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  const cleanPhone = normalizeIndianPhoneNumber(phone);
  if (!cleanPhone) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
  }

  // Check if phone number is already registered to another account
  const existingPhone = await new Promise((resolve) => {
    db.get('SELECT id, email FROM users WHERE phone = ? AND id != ?', [cleanPhone, userId], (err, row) => {
      resolve({ err, row });
    });
  });

  if (existingPhone.err) {
    return res.status(500).json({ error: 'Unable to verify details at this moment. Please try again.' });
  }

  if (existingPhone.row) {
    return res.status(400).json({ error: 'This mobile number is already linked to another account. Please use your own number.' });
  }

  let isPhoneVerified = false;

  if (firebaseIdToken) {
    const verifiedFirebaseUser = await verifyFirebaseToken(firebaseIdToken);
    if (!verifiedFirebaseUser || !verifiedFirebaseUser.phoneNumber) {
      return res.status(400).json({ error: 'Phone verification could not be completed. Please try again.' });
    }

    const verifiedPhoneNormalized = normalizeIndianPhoneNumber(verifiedFirebaseUser.phoneNumber);
    if (verifiedPhoneNormalized !== cleanPhone) {
      return res.status(400).json({ error: 'The verified mobile number does not match the entered phone number.' });
    }

    isPhoneVerified = true;
  } else if (otp) {
    const cleanOtp = String(otp).trim();
    const storedOtpData = otps.get(cleanPhone);
    if (!storedOtpData || storedOtpData.otp !== cleanOtp) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }
    if (Date.now() > storedOtpData.expiresAt) {
      otps.delete(cleanPhone);
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }
    otps.delete(cleanPhone);
    isPhoneVerified = true;
  } else if (!process.env.FIREBASE_API_KEY && process.env.NODE_ENV !== 'production') {
    // Dev fallback
    isPhoneVerified = true;
  } else {
    return res.status(400).json({ error: 'SMS verification is required.' });
  }

  if (!isPhoneVerified) {
    return res.status(400).json({ error: 'Phone verification could not be completed.' });
  }

  db.run(
    'UPDATE users SET phone = ?, phone_verified = TRUE WHERE id = ?',
    [cleanPhone, userId],
    (updateErr) => {
      if (updateErr) {
        console.error('[verify-phone] Update error:', updateErr);
        return res.status(500).json({ error: 'Unable to save mobile number. Please try again.' });
      }

      db.get('SELECT id, name, email, phone, phone_verified, role FROM users WHERE id = ?', [userId], (getErr, updatedUser) => {
        if (getErr || !updatedUser) {
          return res.json({ success: true, message: 'Phone verified successfully.' });
        }
        res.json({
          success: true,
          message: 'Mobile number verified and updated successfully!',
          user: {
            id: updatedUser.id,
            name: updatedUser.name,
            email: updatedUser.email,
            phone: updatedUser.phone,
            phone_verified: Boolean(updatedUser.phone_verified),
            role: updatedUser.role
          }
        });
      });
    }
  );
});

app.post('/api/auth/forgot-password', authLimiter, (req, res) => {
  const email = (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '');
  if (!email || !EMAIL_REGEX.test(email) || email.length > 100) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  db.get('SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)', [email], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) {
      // Prevent user enumeration: return success even if account does not exist
      return res.json({ message: 'If an account exists with this email, a password reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString();

    db.run('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
      [resetToken, expiry, user.id], async (updateErr) => {
        if (updateErr) return res.status(500).json({ error: updateErr.message });

        const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${resetToken}`;
        try {
          const templateParams = {
            to_email: user.email,
            reset_link: resetLink,
            message: `Click the following link to reset your password: ${resetLink}. The link is valid for 1 hour.`
          };

          await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_ID,
            templateParams,
            {
              publicKey: process.env.EMAILJS_PUBLIC_KEY,
              privateKey: process.env.EMAILJS_PRIVATE_KEY,
            }
          );

          res.json({ message: 'Password reset link sent to your email.' });
        } catch (err) {
          console.error('Email exception:', err);
          return res.status(500).json({ error: 'Failed to send reset link to your email.' });
        }
      });
  });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token.trim())) {
    return res.status(400).json({ error: 'Invalid reset token format.' });
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 100) {
    return res.status(400).json({ error: 'Password must be between 6 and 100 characters.' });
  }

  const cleanToken = token.trim();
  db.get('SELECT id, reset_token_expiry FROM users WHERE reset_token = ?', [cleanToken], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (new Date(user.reset_token_expiry) < new Date()) {
      return res.status(400).json({ error: 'Reset token has expired' });
    }
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      db.run(
        'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
        [hashedPassword, user.id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, message: 'Password updated successfully' });
        }
      );
    } catch (hashError) {
      res.status(500).json({ error: hashError.message });
    }
  });
});

// ─── SAAS MULTI-TENANT PLATFORM APIS ────────────────────────────────────────

// Public: List all active canteens for directory & discovery
app.get('/api/tenants', (req, res) => {
  db.all(
    "SELECT id, name, slug, tagline, description, logo_url, banner_url, theme_color, is_shop_open, address, contact_phone, plan_tier FROM tenants WHERE status = 'active' ORDER BY id ASC",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Public: Get single canteen details & branding by slug or ID
app.get('/api/tenants/:slug', (req, res) => {
  const slug = (req.params.slug || '').trim().toLowerCase();
  db.get(
    "SELECT id, name, slug, tagline, description, logo_url, banner_url, theme_color, is_shop_open, address, contact_email, contact_phone, upi_id, upi_name, plan_tier, status FROM tenants WHERE (LOWER(slug) = ? OR id::text = ?) AND status = 'active'",
    [slug, slug],
    (err, tenant) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!tenant) return res.status(404).json({ error: 'Canteen not found or inactive' });
      res.json(tenant);
    }
  );
});

// Public: Get menu items strictly for a specific canteen
app.get('/api/tenants/:slug/items', (req, res) => {
  const slug = (req.params.slug || '').trim().toLowerCase();
  db.get("SELECT id FROM tenants WHERE LOWER(slug) = ? OR id::text = ?", [slug, slug], (err, tenant) => {
    if (err || !tenant) return res.status(404).json({ error: 'Canteen not found' });
    db.all('SELECT * FROM items WHERE tenant_id = ? ORDER BY id ASC', [tenant.id], (itemErr, items) => {
      if (itemErr) return res.status(500).json({ error: itemErr.message });
      res.json(items || []);
    });
  });
});

// Public: Generate instant Table/Counter Ordering QR Code for a canteen
app.get('/api/tenants/:slug/qr', async (req, res) => {
  const slug = (req.params.slug || '').trim().toLowerCase();
  db.get("SELECT id, name, slug FROM tenants WHERE LOWER(slug) = ? OR id::text = ?", [slug, slug], async (err, tenant) => {
    if (err || !tenant) return res.status(404).json({ error: 'Canteen not found' });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL || `${protocol}://${host}`;
    const orderUrl = `${baseUrl}/menu.html?canteen=${encodeURIComponent(tenant.slug)}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(orderUrl, {
        width: 400,
        margin: 2,
        color: { dark: '#111827', light: '#ffffff' }
      });
      res.json({
        tenant_name: tenant.name,
        slug: tenant.slug,
        order_url: orderUrl,
        qr_code: qrDataUrl
      });
    } catch (qrErr) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });
});

// Public: Self-service Canteen Registration & Provisioning
app.post('/api/auth/tenant-register', authLimiter, async (req, res) => {
  const { canteenName, slug, email, password, phone, address, planTier } = req.body;

  const cleanName = sanitizeTextInput(canteenName, 100);
  const rawSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPhone = normalizeIndianPhoneNumber(phone);

  if (!cleanName || cleanName.length < 3) {
    return res.status(400).json({ error: 'Canteen name must be at least 3 characters long.' });
  }
  if (!rawSlug || rawSlug.length < 3) {
    return res.status(400).json({ error: 'A valid URL slug is required (at least 3 characters, letters and numbers).' });
  }
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Valid admin email is required.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    // Check if slug or email exists
    const existingSlug = await db.pool.query('SELECT id FROM tenants WHERE slug = $1', [rawSlug]);
    if (existingSlug.rows.length > 0) {
      return res.status(409).json({ error: 'This canteen URL slug is already taken. Please pick another one.' });
    }

    const existingUser = await db.pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email address already exists.' });
    }

    const tier = ['free_trial', 'starter', 'growth', 'enterprise'].includes(planTier) ? planTier : 'free_trial';
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Create Tenant
      const tenantRes = await client.query(`
        INSERT INTO tenants (
          name, slug, tagline, description,
          logo_url, banner_url, theme_color,
          contact_email, contact_phone, address,
          upi_id, upi_name, is_shop_open, plan_tier, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        ) RETURNING id
      `, [
        cleanName,
        rawSlug,
        'Fresh Bites & Campus Meals',
        `Welcome to ${cleanName}! Order ahead and enjoy fresh food with zero wait time.`,
        'logo.png',
        'biryani.jpg',
        '#f97316',
        cleanEmail,
        cleanPhone || '',
        sanitizeTextInput(address || 'Campus Canteen', 200),
        `${rawSlug}@upi`,
        cleanName.toUpperCase(),
        true,
        tier,
        'active'
      ]);

      const newTenantId = tenantRes.rows[0].id;

      // 2. Create Canteen Admin User
      const hash = bcrypt.hashSync(password, 10);
      const userRes = await client.query(`
        INSERT INTO users (name, email, password, role, tenant_id, phone, phone_verified)
        VALUES ($1, $2, $3, 'admin', $4, $5, $6)
        RETURNING id, name, email, role, tenant_id
      `, [
        cleanName + ' Admin',
        cleanEmail,
        hash,
        newTenantId,
        cleanPhone || null,
        Boolean(cleanPhone)
      ]);

      const newUser = userRes.rows[0];

      // 3. Seed starter menu template
      const starterItems = [
        ['Special Meal Combo', 99, 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=500&q=80', 50, newTenantId],
        ['Fresh Brewed Masala Tea', 20, 'tea_pouring.jpg', 100, newTenantId],
        ['Club Sandwich', 70, 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=500&q=80', 40, newTenantId]
      ];
      for (const itm of starterItems) {
        await client.query(
          'INSERT INTO items (name, price, image, stock, tenant_id) VALUES ($1, $2, $3, $4, $5)',
          itm
        );
      }

      await client.query('COMMIT');

      const token = jwt.sign({
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        tenant_id: newTenantId,
        is_superadmin: false
      }, JWT_SECRET, { expiresIn: '7d' });

      res.status(201).json({
        success: true,
        message: 'Canteen provisioned successfully!',
        token,
        tenant: {
          id: newTenantId,
          name: cleanName,
          slug: rawSlug,
          plan_tier: tier
        },
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
          tenant_id: newTenantId,
          is_superadmin: false
        }
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Tenant registration error:', err);
    res.status(500).json({ error: err.message || 'Failed to register canteen' });
  }
});

// ─── SUPER ADMIN PLATFORM ROUTES ───────────────────────────────────────────

// Platform KPI Metrics & Analytics
app.get('/api/super/stats', requireSuperAdmin, async (req, res) => {
  try {
    const totalTenantsRes = await db.pool.query('SELECT COUNT(*)::int AS count FROM tenants');
    const activeTenantsRes = await db.pool.query("SELECT COUNT(*)::int AS count FROM tenants WHERE status = 'active'");
    const totalOrdersRes = await db.pool.query(`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0)::numeric AS gmv 
      FROM (
        SELECT total FROM orders WHERE status NOT IN ('Pending Payment', 'Failed', 'Cancelled')
        UNION ALL
        SELECT total FROM orders_archive WHERE status NOT IN ('Pending Payment', 'Failed', 'Cancelled')
      ) all_paid
    `);
    const todayOrdersRes = await db.pool.query(`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0)::numeric AS revenue
      FROM orders
      WHERE status NOT IN ('Pending Payment', 'Failed', 'Cancelled')
        AND created_at >= CURRENT_DATE
    `);
    const plansRes = await db.pool.query(`
      SELECT plan_tier, COUNT(*)::int AS count 
      FROM tenants 
      GROUP BY plan_tier
    `);

    res.json({
      totalTenants: totalTenantsRes.rows[0].count,
      activeTenants: activeTenantsRes.rows[0].count,
      totalOrders: totalOrdersRes.rows[0].count,
      totalGmv: parseFloat(totalOrdersRes.rows[0].gmv || 0),
      todayOrders: todayOrdersRes.rows[0].count,
      todayRevenue: parseFloat(todayOrdersRes.rows[0].revenue || 0),
      planDistribution: plansRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all canteens with operational stats
app.get('/api/super/tenants', requireSuperAdmin, async (req, res) => {
  try {
    const tenantsRes = await db.pool.query(`
      SELECT 
        t.id, t.name, t.slug, t.tagline, t.logo_url, t.theme_color,
        t.contact_email, t.contact_phone, t.address, t.upi_id,
        t.is_shop_open, t.plan_tier, t.status, t.created_at,
        COUNT(DISTINCT o.id)::int AS total_orders,
        COALESCE(SUM(o.total), 0)::numeric AS total_revenue,
        COUNT(DISTINCT i.id)::int AS menu_count
      FROM tenants t
      LEFT JOIN orders o ON t.id = o.tenant_id AND o.status NOT IN ('Pending Payment', 'Failed', 'Cancelled')
      LEFT JOIN items i ON t.id = i.tenant_id
      GROUP BY t.id
      ORDER BY t.id ASC
    `);
    res.json(tenantsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Super Admin: Create a new tenant directly
app.post('/api/super/tenants', requireSuperAdmin, async (req, res) => {
  const { name, slug, tagline, description, address, contact_email, contact_phone, upi_id, plan_tier } = req.body;
  const cleanName = sanitizeTextInput(name, 100);
  const cleanSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
  if (!cleanName || !cleanSlug) return res.status(400).json({ error: 'Name and unique Slug are required.' });

  try {
    const insertRes = await db.pool.query(`
      INSERT INTO tenants (
        name, slug, tagline, description, address, contact_email, contact_phone, upi_id, plan_tier, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
      RETURNING *
    `, [
      cleanName, cleanSlug,
      sanitizeTextInput(tagline || 'Campus Dining', 120),
      sanitizeTextInput(description || '', 500),
      sanitizeTextInput(address || '', 200),
      contact_email || null,
      contact_phone || null,
      upi_id || null,
      plan_tier || 'growth'
    ]);
    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Super Admin: Update tenant status, plan, open state, or details
app.put('/api/super/tenants/:id', requireSuperAdmin, async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  if (isNaN(tenantId) || tenantId <= 0) return res.status(400).json({ error: 'Invalid tenant ID' });

  const { name, slug, tagline, address, contact_email, contact_phone, upi_id, plan_tier, status, is_shop_open } = req.body;
  try {
    const updateRes = await db.pool.query(`
      UPDATE tenants SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        tagline = COALESCE($3, tagline),
        address = COALESCE($4, address),
        contact_email = COALESCE($5, contact_email),
        contact_phone = COALESCE($6, contact_phone),
        upi_id = COALESCE($7, upi_id),
        plan_tier = COALESCE($8, plan_tier),
        status = COALESCE($9, status),
        is_shop_open = COALESCE($10, is_shop_open)
      WHERE id = $11
      RETURNING *
    `, [
      name ? sanitizeTextInput(name, 100) : null,
      slug ? slug.trim().toLowerCase() : null,
      tagline ? sanitizeTextInput(tagline, 120) : null,
      address ? sanitizeTextInput(address, 200) : null,
      contact_email || null,
      contact_phone || null,
      upi_id || null,
      plan_tier || null,
      status || null,
      typeof is_shop_open === 'boolean' ? is_shop_open : null,
      tenantId
    ]);

    if (updateRes.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Super Admin: Delete / Suspend tenant
app.delete('/api/super/tenants/:id', requireSuperAdmin, async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  if (isNaN(tenantId) || tenantId <= 0) return res.status(400).json({ error: 'Invalid tenant ID' });

  try {
    await db.pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);
    res.json({ success: true, message: 'Tenant suspended successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Super Admin: List subscription plans
app.get('/api/super/plans', requireSuperAdmin, async (req, res) => {
  try {
    const plansRes = await db.pool.query('SELECT * FROM subscription_plans ORDER BY price_monthly ASC');
    res.json(plansRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CANTEEN ADMIN SETTINGS & BRANDING APIS ────────────────────────────────

// Canteen Admin: Get current canteen profile & settings
app.get('/api/canteen/profile', requireAdmin, async (req, res) => {
  const tenantId = req.user.tenant_id || 1;
  db.get('SELECT * FROM tenants WHERE id = ?', [tenantId], (err, tenant) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!tenant) return res.status(404).json({ error: 'Canteen not found' });
    res.json(tenant);
  });
});

// Canteen Admin: Update profile, logo, banner, theme, and UPI
app.put('/api/canteen/profile', requireAdmin, async (req, res) => {
  const tenantId = req.user.tenant_id || 1;
  const { name, tagline, description, address, contact_email, contact_phone, upi_id, upi_name, theme_color, logo_url, banner_url } = req.body;

  try {
    const updateRes = await db.pool.query(`
      UPDATE tenants SET
        name = COALESCE($1, name),
        tagline = COALESCE($2, tagline),
        description = COALESCE($3, description),
        address = COALESCE($4, address),
        contact_email = COALESCE($5, contact_email),
        contact_phone = COALESCE($6, contact_phone),
        upi_id = COALESCE($7, upi_id),
        upi_name = COALESCE($8, upi_name),
        theme_color = COALESCE($9, theme_color),
        logo_url = COALESCE($10, logo_url),
        banner_url = COALESCE($11, banner_url)
      WHERE id = $12
      RETURNING *
    `, [
      name ? sanitizeTextInput(name, 100) : null,
      tagline ? sanitizeTextInput(tagline, 120) : null,
      description ? sanitizeTextInput(description, 500) : null,
      address ? sanitizeTextInput(address, 200) : null,
      contact_email || null,
      contact_phone || null,
      upi_id || null,
      upi_name || null,
      theme_color || null,
      logo_url || null,
      banner_url || null,
      tenantId
    ]);
    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Canteen Admin: Get QR code for this canteen
app.get('/api/canteen/qr', requireAdmin, async (req, res) => {
  const tenantId = req.user.tenant_id || 1;
  db.get('SELECT id, name, slug FROM tenants WHERE id = ?', [tenantId], async (err, tenant) => {
    if (err || !tenant) return res.status(404).json({ error: 'Canteen not found' });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL || `${protocol}://${host}`;
    const orderUrl = `${baseUrl}/menu.html?canteen=${encodeURIComponent(tenant.slug)}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(orderUrl, {
        width: 500,
        margin: 2,
        color: { dark: '#111827', light: '#ffffff' }
      });
      res.json({
        tenant_name: tenant.name,
        slug: tenant.slug,
        order_url: orderUrl,
        qr_code: qrDataUrl
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });
});

// --- MENU ITEM ROUTES ---
app.get('/api/items', optionalAuth, (req, res) => {
  const tenantParam = req.query.canteen || req.query.tenant || req.query.tenant_id || req.headers['x-tenant-id'] || req.user?.tenant_id;
  if (tenantParam) {
    db.get("SELECT id FROM tenants WHERE LOWER(slug) = ? OR id::text = ?", [String(tenantParam).toLowerCase(), String(tenantParam)], (err, tenant) => {
      const tenantId = tenant ? tenant.id : (parseInt(tenantParam, 10) || 1);
      db.all('SELECT * FROM items WHERE tenant_id = ? ORDER BY id ASC', [tenantId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
      });
    });
  } else {
    const defaultTenantId = req.user?.tenant_id || 1;
    db.all('SELECT * FROM items WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY id ASC', [defaultTenantId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }
});

app.post('/api/items', requireAdmin, (req, res) => {
  let { name, price, image, available, stock, tenant_id } = req.body;
  name = sanitizeTextInput(name, 100);
  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Valid item name (2-100 characters) is required' });
  }

  const numericPrice = parseFloat(price);
  if (isNaN(numericPrice) || numericPrice < 0 || numericPrice > 100000) {
    return res.status(400).json({ error: 'Price must be a valid non-negative number up to 100,000' });
  }

  const numericStock = parseInt(stock, 10);
  if (isNaN(numericStock) || numericStock < 0 || numericStock > 100000) {
    return res.status(400).json({ error: 'Stock must be a valid non-negative integer' });
  }

  const safeImage = sanitizeUrl(image) || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=500&q=80';
  const targetTenantId = (req.user.is_superadmin || req.user.role === 'superadmin')
    ? (tenant_id || req.user.tenant_id || 1)
    : (req.user.tenant_id || 1);

  db.get(
    'INSERT INTO items (name, price, image, available, stock, tenant_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, price, image, available, stock, tenant_id',
    [name, numericPrice, safeImage, available === undefined ? true : !!available, numericStock, targetTenantId],
    (err, newItem) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      io.emit('menu_updated');
      if (targetTenantId) {
        io.to(`canteen_${targetTenantId}`).emit('menu_updated');
        io.to(`tenant_${targetTenantId}_admin`).emit('menu_updated');
      }
      res.status(201).json(newItem);
    }
  );
});

app.put('/api/items/:id', requireAdmin, (req, res) => {
  const itemId = parseInt(req.params.id, 10);
  if (isNaN(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Invalid item ID' });
  }

  let { name, price, image, available, stock } = req.body;
  name = sanitizeTextInput(name, 100);
  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Valid item name (2-100 characters) is required' });
  }

  const numericPrice = parseFloat(price);
  if (isNaN(numericPrice) || numericPrice < 0 || numericPrice > 100000) {
    return res.status(400).json({ error: 'Price must be a valid non-negative number up to 100,000' });
  }

  const numericStock = parseInt(stock, 10);
  if (isNaN(numericStock) || numericStock < 0 || numericStock > 100000) {
    return res.status(400).json({ error: 'Stock must be a valid non-negative integer' });
  }

  const safeImage = sanitizeUrl(image) || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=500&q=80';
  const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
  const updateSql = isSuper
    ? 'UPDATE items SET name=?, price=?, image=?, available=?, stock=? WHERE id=?'
    : 'UPDATE items SET name=?, price=?, image=?, available=?, stock=? WHERE id=? AND (tenant_id=? OR tenant_id IS NULL)';
  const updateParams = isSuper
    ? [name, numericPrice, safeImage, available === undefined ? true : !!available, numericStock, itemId]
    : [name, numericPrice, safeImage, available === undefined ? true : !!available, numericStock, itemId, req.user.tenant_id || 1];

  db.run(updateSql, updateParams, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    io.emit('menu_updated');
    if (req.user.tenant_id) {
      io.to(`canteen_${req.user.tenant_id}`).emit('menu_updated');
      io.to(`tenant_${req.user.tenant_id}_admin`).emit('menu_updated');
    }
    res.json({ message: 'Item updated successfully' });
  });
});

app.delete('/api/items/:id', requireAdmin, (req, res) => {
  const itemId = parseInt(req.params.id, 10);
  if (isNaN(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Invalid item ID' });
  }

  const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
  const delSql = isSuper
    ? 'DELETE FROM items WHERE id=?'
    : 'DELETE FROM items WHERE id=? AND (tenant_id=? OR tenant_id IS NULL)';
  const delParams = isSuper ? [itemId] : [itemId, req.user.tenant_id || 1];

  db.run(delSql, delParams, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    io.emit('menu_updated');
    if (req.user.tenant_id) {
      io.to(`canteen_${req.user.tenant_id}`).emit('menu_updated');
      io.to(`tenant_${req.user.tenant_id}_admin`).emit('menu_updated');
    }
    res.json({ message: 'Item deleted successfully' });
  });
});

// --- ZOHO CONFIG ROUTE ---
app.get('/api/zoho-config', authenticateToken, (req, res) => {
  res.json({
    api_key: process.env.ZOHO_PUBLISHABLE_KEY || process.env.ZOHO_API_KEY || '',
    account_id: process.env.ZOHO_ACCOUNT_ID || ''
  });
});

// --- ORDER ROUTES ---

// Shop Status Routes (Supports tenant query / admin tenant)
app.get('/api/shop-status', (req, res) => {
  const tenantParam = req.query.canteen || req.query.tenant || req.query.tenant_id || req.headers['x-tenant-id'] || req.user?.tenant_id;
  if (tenantParam) {
    db.get("SELECT is_shop_open FROM tenants WHERE LOWER(slug) = ? OR id::text = ?", [String(tenantParam).toLowerCase(), String(tenantParam)], (err, row) => {
      if (err || !row) return res.json({ isOpen: isShopOpen });
      res.json({ isOpen: Boolean(row.is_shop_open) });
    });
  } else {
    res.json({ isOpen: isShopOpen });
  }
});

app.post('/api/shop-status', requireAdmin, (req, res) => {
  const { isOpen, tenant_id } = req.body;
  if (typeof isOpen !== 'boolean') return res.status(400).json({ error: 'isOpen must be a boolean' });

  const targetTenantId = (req.user.is_superadmin || req.user.role === 'superadmin')
    ? (tenant_id || req.user.tenant_id || 1)
    : (req.user.tenant_id || 1);

  isShopOpen = isOpen;
  db.run("UPDATE tenants SET is_shop_open = ? WHERE id = ?", [isOpen, targetTenantId], (err) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    io.emit('shop_status_changed', isOpen);
    io.to(`canteen_${targetTenantId}`).emit('shop_status_changed', isOpen);
    res.json({ success: true, isOpen });
  });
});

app.post('/api/orders/create', authenticateToken, async (req, res) => {
  if (!isShopOpen) {
    return res.status(400).json({ error: 'The shop is currently closed. Please try again later.' });
  }
  const { items, recaptchaToken } = req.body;
  const userId = req.user.id;

  // Security: verify reCAPTCHA against automated bot and fake order attacks
  const recaptchaCheck = await verifyRecaptcha(recaptchaToken, req.ip);
  if (!recaptchaCheck.success) {
    return res.status(400).json({ error: recaptchaCheck.error });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }

  // Aggregate duplicate item IDs and strictly validate numeric constraints
  const aggregatedMap = new Map();
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') {
      return res.status(400).json({ error: 'Malformed item in cart' });
    }
    const id = parseInt(rawItem.id, 10);
    const qty = parseInt(rawItem.quantity, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid item ID in order' });
    }
    if (isNaN(qty) || qty <= 0 || qty > 50) {
      return res.status(400).json({ error: 'Item quantities must be positive integers between 1 and 50' });
    }
    aggregatedMap.set(id, (aggregatedMap.get(id) || 0) + qty);
  }

  if (aggregatedMap.size === 0 || aggregatedMap.size > 50) {
    return res.status(400).json({ error: 'Order must contain between 1 and 50 distinct items' });
  }

  // Acquire a dedicated client for transaction
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // 0. Verify customer mobile phone verification
    if (req.user.role !== 'admin') {
      const userCheckRes = await client.query(
        'SELECT id, phone, phone_verified FROM users WHERE id = $1',
        [userId]
      );
      const currentUser = userCheckRes.rows[0];
      if (!currentUser || !currentUser.phone || !currentUser.phone_verified) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'Mobile phone verification is required before placing an order. Please verify your phone number.',
          requires_phone_verification: true
        });
      }
    }

    // 1. Fetch item prices and details
    const itemIds = Array.from(aggregatedMap.keys());
    const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');
    const itemRes = await client.query(
      `SELECT id, name, price, image, stock, available, tenant_id FROM items WHERE id IN (${placeholders})`,
      itemIds
    );
    const rows = itemRes.rows;

    if (!rows || rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Selected items were not found.' });
    }

    // Determine target tenant and check specific canteen open status
    const targetTenantId = req.body.tenant_id ? (parseInt(req.body.tenant_id, 10) || 1) : (rows[0]?.tenant_id || 1);
    const tenantCheckRes = await client.query('SELECT id, name, is_shop_open FROM tenants WHERE id = $1', [targetTenantId]);
    const canteen = tenantCheckRes.rows[0];
    if (canteen && !canteen.is_shop_open) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${canteen.name} is currently closed. Please try again later.` });
    }

    let serverTotal = 0;
    const sanitizedItems = [];

    // Calculate serverTotal and validate quantities against stock
    for (const [id, requestedQty] of aggregatedMap.entries()) {
      const dbItem = rows.find(r => r.id === id);
      if (!dbItem) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item #${id} not found.` });
      }

      if (!dbItem.available) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${dbItem.name} is currently unavailable.` });
      }

      if (requestedQty > 50) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Maximum 50 units allowed per item for ${dbItem.name}.` });
      }

      if (dbItem.stock < requestedQty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Not enough stock available for ${dbItem.name}. Only ${dbItem.stock} in stock.` });
      }

      const itemPrice = Math.round(Number(dbItem.price) * 100) / 100;
      serverTotal += itemPrice * requestedQty;
      sanitizedItems.push({
        id: dbItem.id,
        name: sanitizeTextInput(dbItem.name, 100),
        price: itemPrice,
        image: dbItem.image,
        quantity: requestedQty
      });
    }

    serverTotal = Math.round(serverTotal * 100) / 100;
    if (serverTotal <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order total must be greater than ₹0.' });
    }

    const orderId = 'ORD' + Date.now() + crypto.randomBytes(4).toString('hex').toUpperCase();
    const txnRef = orderId;
    const itemsStr = JSON.stringify(sanitizedItems);

    // 2. Obtain Payment Session from Zoho Payments
    let paymentSessionId = null;

    if (process.env.ZOHO_ACCOUNT_ID && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN) {
      try {
        paymentSessionId = await createZohoPaymentSession(serverTotal, orderId);
      } catch (zohoErr) {
        await client.query('ROLLBACK');
        const userMsg = zohoErr.message || 'Failed to initiate payment session with Zoho Payments. Please try again.';
        return res.status(zohoErr.statusCode || 502).json({ error: userMsg });
      }
    } else {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'Payment gateway is not currently configured on the server.' });
    }

    // 3. Insert order row into DB with Pending Payment status and tenant_id
    await client.query(
      "INSERT INTO orders (id, tenant_id, items, total, status, txn_ref, user_id, zoho_payment_session_id) VALUES ($1, $2, $3, $4, 'Pending Payment', $5, $6, $7)",
      [orderId, targetTenantId, itemsStr, serverTotal, txnRef, userId, paymentSessionId]
    );

    // Commit transaction
    await client.query('COMMIT');

    // 4. Clear in-memory activeCart for user
    if (activeCarts[userId]) {
      delete activeCarts[userId];
    }

    return res.json({
      success: true,
      orderId,
      paymentSessionId,
      amount: serverTotal
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Order creation transaction failed:', err);
    return res.status(500).json({ error: 'Order creation failed: ' + err.message });
  } finally {
    client.release();
  }
});

// --- ZOHO PAYMENTS HELPERS & VERIFICATION ENGINE ---
const VALID_ZOHO_PAYMENT_STATUSES = [
  'success', 'completed', 'succeeded', 'paid', 'approved',
  'payment_completed', 'captured', 'processed', 'authorized', 'settled'
];

function isZohoAmountMatch(paidAmount, orderTotal) {
  if (paidAmount === undefined || paidAmount === null || orderTotal === undefined || orderTotal === null) {
    return false;
  }
  const parsedPaid = parseFloat(paidAmount);
  const expected = parseFloat(orderTotal);
  if (isNaN(parsedPaid) || isNaN(expected) || parsedPaid <= 0 || expected <= 0) {
    return false;
  }
  const matchesRupees = Math.abs(parsedPaid - expected) < 0.05;
  const matchesPaise = Math.abs(parsedPaid / 100 - expected) < 0.05;
  return matchesRupees || matchesPaise;
}

// Universal Zoho status & payment info extractor
function extractZohoPaymentInfo(data) {
  if (!data) return { isPaid: false };

  // 1. Check direct event names / types
  const eventType = String(data.event_type || data.event_name || data.event || '').toLowerCase();
  const eventSuggestsSuccess =
    eventType.includes('succeeded') ||
    eventType.includes('completed') ||
    eventType.includes('captured') ||
    eventType.includes('paid') ||
    eventType.includes('success');

  // 2. Locate session and payment objects
  const session = data.payments_session || data.data?.payments_session || (data.payments_session_id ? data : null);
  const singlePayment = data.payment || data.data?.payment;
  const paymentsList =
    (Array.isArray(data.payments) && data.payments) ||
    (Array.isArray(data.data?.payments) && data.data.payments) ||
    (session && Array.isArray(session.payments) && session.payments) ||
    (Array.isArray(data.payment_details) && data.payment_details) ||
    [];

  let paymentSessionId =
    data.payments_session_id ||
    data.payment_session_id ||
    data.data?.payments_session_id ||
    session?.payments_session_id ||
    singlePayment?.payments_session_id ||
    paymentsList[0]?.payments_session_id ||
    null;

  let txnId =
    data.payment_id ||
    data.txn_id ||
    data.transaction_id ||
    data.id ||
    singlePayment?.payment_id ||
    singlePayment?.txn_id ||
    singlePayment?.transaction_id ||
    singlePayment?.id ||
    session?.payment_id ||
    session?.txn_id ||
    session?.transaction_id ||
    session?.id ||
    paymentsList[0]?.payment_id ||
    paymentsList[0]?.transaction_id ||
    paymentsList[0]?.id ||
    null;

  let amount =
    data.amount ??
    data.amount_paid ??
    data.amount_received ??
    singlePayment?.amount ??
    singlePayment?.amount_paid ??
    session?.amount ??
    session?.amount_paid ??
    paymentsList[0]?.amount;

  let isPaid = false;
  let rawStatus = data.status || session?.status || singlePayment?.status || paymentsList[0]?.status;

  // Check payments list (plural array returned by Zoho payments session)
  if (paymentsList.length > 0) {
    const successItem = paymentsList.find(p => {
      const st = String(p.status || '').toLowerCase();
      return VALID_ZOHO_PAYMENT_STATUSES.includes(st);
    });
    if (successItem) {
      isPaid = true;
      txnId = successItem.payment_id || successItem.transaction_id || successItem.id || txnId;
      amount = successItem.amount ?? successItem.amount_paid ?? amount;
      rawStatus = successItem.status;
      if (successItem.payments_session_id) {
        paymentSessionId = successItem.payments_session_id;
      }
    }
  }

  // Check single payment object
  if (!isPaid && singlePayment) {
    const st = String(singlePayment.status || '').toLowerCase();
    if (VALID_ZOHO_PAYMENT_STATUSES.includes(st)) {
      isPaid = true;
      txnId = singlePayment.payment_id || singlePayment.transaction_id || singlePayment.id || txnId;
      amount = singlePayment.amount ?? singlePayment.amount_paid ?? amount;
      rawStatus = singlePayment.status;
      if (singlePayment.payments_session_id) {
        paymentSessionId = singlePayment.payments_session_id;
      }
    }
  }

  // Check session status: Zoho session status 'closed' or 'expired' NEVER means paid.
  // Only an explicit payment object, or session status 'completed'/'paid' with a distinct real payment txnId confirms payment.
  if (!isPaid && session && session.status) {
    const st = String(session.status).toLowerCase();
    if (['completed', 'paid', 'succeeded', 'success'].includes(st)) {
      const candidateTxn = session.payment_id || session.txn_id || session.transaction_id || singlePayment?.payment_id || paymentsList[0]?.payment_id;
      if (candidateTxn && String(candidateTxn).trim() !== String(paymentSessionId).trim()) {
        isPaid = true;
        rawStatus = session.status;
        txnId = candidateTxn;
        amount = session.amount ?? session.amount_paid ?? amount;
      }
    }
  }

  // Check raw status field (reject 'closed' explicitly)
  if (!isPaid && rawStatus) {
    const normalized = String(rawStatus).toLowerCase();
    if (normalized !== 'closed' && VALID_ZOHO_PAYMENT_STATUSES.includes(normalized)) {
      isPaid = true;
    }
  }

  if (!isPaid && eventSuggestsSuccess) {
    isPaid = true;
    rawStatus = 'success';
  }

  return {
    isPaid,
    paymentSessionId,
    txnId,
    amount,
    rawStatus
  };
}

function parseZohoWebhookSignature(headerStr) {
  if (!headerStr || typeof headerStr !== 'string') return { timestamp: null, signature: null };
  const trimmed = headerStr.trim();
  if (trimmed.includes('=')) {
    const tokens = trimmed.split(',').map(t => t.trim());
    let timestamp = null;
    let signature = null;
    for (const tok of tokens) {
      const eqIdx = tok.indexOf('=');
      if (eqIdx !== -1) {
        const k = tok.slice(0, eqIdx).trim().toLowerCase();
        const v = tok.slice(eqIdx + 1).trim();
        if (k === 't') timestamp = v;
        if (k === 'v1' || k === 'v' || k === 'signature') signature = v;
      }
    }
    return { timestamp, signature };
  }
  return { timestamp: null, signature: trimmed };
}

// Zoho Payments Webhook Callback (Attack-proof with dual HMAC & authoritative Zoho API cross-check)
app.post('/api/orders/zoho-webhook', async (req, res) => {
  const payload = req.body;
  console.log('[Zoho Webhook] Received:', JSON.stringify(payload));

  const signingKey = process.env.ZOHO_WEBHOOK_SIGNING_KEY || process.env.ZOHO_SIGNING_KEY;
  const signatureHeader = req.headers['x-zoho-webhook-signature'] ||
    req.headers['x-zoho-signature'] ||
    req.headers['zoho-signature'] ||
    req.headers['x-signature'] ||
    req.headers['signature'];
  let isHmacValid = false;

  if (signingKey && signatureHeader && req.rawBody) {
    try {
      const parsedSig = parseZohoWebhookSignature(signatureHeader);
      if (parsedSig.signature) {
        const testSignatures = [];
        
        // Format A: t=timestamp.rawBody (standard Stripe/Zoho format)
        if (parsedSig.timestamp) {
          const dataWithTimestamp = `${parsedSig.timestamp}.${req.rawBody.toString('utf8')}`;
          testSignatures.push(
            crypto.createHmac('sha256', signingKey).update(dataWithTimestamp).digest('hex')
          );
        }
        
        // Format B: direct rawBody
        testSignatures.push(
          crypto.createHmac('sha256', signingKey).update(req.rawBody.toString('utf8')).digest('hex')
        );

        const sigBuf = Buffer.from(parsedSig.signature.toLowerCase());
        for (const expectedHex of testSignatures) {
          const expBuf = Buffer.from(expectedHex.toLowerCase());
          if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
            isHmacValid = true;
            break;
          }
        }
      }
    } catch (sigErr) {
      console.error('[Zoho Webhook] Signature parse error:', sigErr.message);
    }
  }

  const info = extractZohoPaymentInfo(payload);
  const paymentSessionId = info.paymentSessionId || payload.payments_session_id || payload.data?.payments_session_id;
  const txnId = info.txnId || payload.payment_id || payload.data?.payment_id;

  if (!paymentSessionId && !txnId) {
    console.error('[Zoho Webhook] Missing payment session ID and txn ID in payload:', payload);
    return res.status(400).json({ error: 'Missing session or payment ID' });
  }

  const query = paymentSessionId
    ? 'SELECT * FROM orders WHERE zoho_payment_session_id = ?'
    : 'SELECT * FROM orders WHERE txn_id = ? OR txn_ref = ?';
  const param = paymentSessionId || txnId;

  db.get(query, [param], async (err, order) => {
    if (err || !order) {
      console.error('[Zoho Webhook] Order not found for session/txn:', param);
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'Pending Payment') {
      console.log('[Zoho Webhook] Order already processed:', order.id);
      return res.json({ success: true, alreadyProcessed: true });
    }

    // DUAL VERIFICATION:
    // If HMAC signature is not valid or not configured, perform an authoritative server-to-server check with Zoho API
    if (!isHmacValid) {
      console.log(`[Zoho Webhook] HMAC unverified for order ${order.id}. Performing authoritative direct Zoho API check...`);
      const apiResult = await verifyZohoOrderPayment(order, {
        paymentSessionId,
        paymentId: txnId,
        widgetResponse: payload
      });
      if (apiResult.isPaid) {
        console.log(`[Zoho Webhook] Authoritative Zoho API check confirmed order ${order.id}`);
        return res.json({ success: true, orderId: order.id, status: 'Pending' });
      } else {
        console.error(`[Zoho Webhook] Security rejection: HMAC unverified AND Zoho API reported unpaid for order ${order.id}.`);
        return res.status(400).json({ error: 'Payment not confirmed by Zoho Payments' });
      }
    }

    // Strict payment session match for webhook
    const orderSessionId = order.zoho_payment_session_id ? String(order.zoho_payment_session_id).trim() : null;
    const webhookSessionId = paymentSessionId ? String(paymentSessionId).trim() : (info.paymentSessionId ? String(info.paymentSessionId).trim() : null);
    if (orderSessionId && (!webhookSessionId || webhookSessionId !== orderSessionId)) {
      console.error('[Zoho Webhook] Session mismatch for order', order.id, 'Expected:', orderSessionId, 'Got:', webhookSessionId);
      return res.status(400).json({ error: 'Payment session mismatch' });
    }

    // HMAC signature is cryptographically valid: verify amount match
    if (!isZohoAmountMatch(info.amount, order.total)) {
      console.error('[Zoho Webhook] Payment amount mismatch! Expected:', order.total, 'Received:', info.amount);
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    if (info.isPaid) {
      const recordedTxnId = (txnId && String(txnId).trim()) ||
        (info.txnId && String(info.txnId).trim()) ||
        null;

      if (!recordedTxnId) {
        console.error('[Zoho Webhook] Missing real transaction ID in webhook payload for order', order.id);
        return res.status(400).json({ error: 'Missing real Zoho transaction identifier' });
      }

      confirmOrderInDb(order.id, recordedTxnId, (confirmErr) => {
        if (confirmErr) {
          console.error('[Zoho Webhook] DB confirm error:', confirmErr.message);
          return res.status(500).json({ error: 'DB Error' });
        }
        console.log(`[Zoho Webhook] Confirmed order ${order.id} with txn: ${recordedTxnId}`);
        return res.json({ success: true, orderId: order.id, status: 'Pending' });
      });
    } else {
      console.log('[Zoho Webhook] Received webhook with unconfirmed status:', info.rawStatus);
      return res.json({ received: true, status: info.rawStatus });
    }
  });
});

// Gateway Return Callback Handler
const handlePaymentCallback = async (req, res) => {
  const params = { ...req.query, ...req.body };
  const orderId = params.orderId || params.order_id || params.id;
  const sessionId = params.payments_session_id || params.payment_session_id;

  if (orderId) {
    db.get('SELECT * FROM orders WHERE id = ?', [orderId], async (err, order) => {
      if (!err && order) {
        let isPaid = order.status !== 'Pending Payment';
        if (!isPaid) {
          const result = await verifyZohoOrderPayment(order, params);
          isPaid = Boolean(result && result.isPaid);
        }
        if (isPaid) {
          return res.redirect(`/orders.html?payment=success&orderId=${encodeURIComponent(orderId)}`);
        }
        return res.redirect(`/orders.html?payment=pending&orderId=${encodeURIComponent(orderId)}`);
      }
      return res.redirect('/orders.html');
    });
  } else if (sessionId) {
    db.get('SELECT * FROM orders WHERE zoho_payment_session_id = ?', [sessionId], async (err, order) => {
      if (!err && order) {
        let isPaid = order.status !== 'Pending Payment';
        if (!isPaid) {
          const result = await verifyZohoOrderPayment(order, params);
          isPaid = Boolean(result && result.isPaid);
        }
        const targetId = order.id ? encodeURIComponent(order.id) : '';
        if (isPaid) {
          return res.redirect(`/orders.html?payment=success&orderId=${targetId}`);
        }
        return res.redirect(`/orders.html?payment=pending&orderId=${targetId}`);
      }
      return res.redirect('/orders.html');
    });
  } else {
    return res.redirect('/orders.html');
  }
};

app.get('/api/orders/payment-callback', handlePaymentCallback);
app.post('/api/orders/payment-callback', handlePaymentCallback);

// Helper: confirm a paid order, decrease item stock, and record transaction
function confirmOrderInDb(orderId, txnId, callback) {
  const cleanTxnId = (txnId && (typeof txnId === 'string' || typeof txnId === 'number'))
    ? String(txnId).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    : '';

  if (!cleanTxnId) {
    const err = new Error('Cannot confirm order: missing or invalid transaction ID');
    if (callback) callback(err);
    return;
  }
  const resolvedTxnId = cleanTxnId;

  // Transaction ID Replay Protection: Ensure transaction ID was not already used on another order
  db.get('SELECT id FROM orders WHERE txn_id = ? AND id != ? LIMIT 1', [resolvedTxnId, orderId], (dupErr, duplicateOrder) => {
    if (dupErr) {
      if (callback) callback(dupErr);
      return;
    }
    if (duplicateOrder) {
      const dupMessage = `Transaction ID ${resolvedTxnId} has already been bound to order #${duplicateOrder.id}. Duplicate payment confirmation rejected.`;
      console.error(`[Security Alert] Reused transaction ID detected! Attempted on order ${orderId}, already used on order ${duplicateOrder.id}`);
      if (callback) callback(new Error(dupMessage));
      return;
    }

    // Atomic state transition: ONLY one concurrent execution can transition from 'Pending Payment' to 'Pending'
    db.run(
      "UPDATE orders SET status = 'Pending', txn_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'Pending Payment'",
      [resolvedTxnId, orderId],
      function (updateErr, info) {
        if (updateErr) {
          if (callback) callback(updateErr);
          return;
        }

        // If no row was updated (changes === 0), order was already confirmed or does not exist
        if (!info || info.changes === 0) {
          db.get('SELECT * FROM orders WHERE id = ?', [orderId], (getErr, existingOrder) => {
            if (callback) callback(getErr, existingOrder);
          });
          return;
        }

        // We won the atomic transition: fetch full order to decrement stock and broadcast
        db.get(
          'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE orders.id = ?',
          [orderId],
          (err, order) => {
            if (err || !order) {
              if (callback) callback(err || new Error('Order not found after confirmation'));
              return;
            }

            // Stock decreases after payment completion
            try {
              const orderItems = JSON.parse(order.items);
              orderItems.forEach(item => {
                const qty = parseInt(item.quantity, 10) || 0;
                const itemId = parseInt(item.id, 10);
                if (qty > 0 && itemId > 0) {
                  db.run('UPDATE items SET stock = GREATEST(0, stock - ?) WHERE id = ?', [qty, itemId]);
                }
              });
            } catch (parseErr) {
              console.error('Error parsing items for stock decrement:', parseErr);
            }

            // Record in transactions table
            db.run(
              'INSERT INTO transactions (txn_id, order_id, status, amount) VALUES (?, ?, ?, ?) ON CONFLICT (txn_id) DO NOTHING',
              [resolvedTxnId, orderId, 'SUCCESS', order.total],
              () => {}
            );

            order.status = 'Pending';
            order.txn_id = resolvedTxnId;

            // Clean activeCart if user exists
            if (order.user_id && activeCarts[order.user_id]) {
              delete activeCarts[order.user_id];
            }

            // Broadcast privately: order updates go to the owning student; staff updates go to admin room
            if (order.user_id) {
              io.to(`user_${order.user_id}`).emit('payment_confirmed', { orderId, txnId: resolvedTxnId, userId: order.user_id });
              io.to(`user_${order.user_id}`).emit('order_status_update', { id: orderId, status: 'Pending', userId: order.user_id });
            }

            io.to('admin').emit('new_order', { ...order, status: 'Pending', txn_id: resolvedTxnId });
            io.to('admin').emit('payment_confirmed', { orderId, txnId: resolvedTxnId, userId: order.user_id });
            if (order.tenant_id) {
              io.to(`tenant_${order.tenant_id}_admin`).emit('new_order', { ...order, status: 'Pending', txn_id: resolvedTxnId });
              io.to(`tenant_${order.tenant_id}_admin`).emit('payment_confirmed', { orderId, txnId: resolvedTxnId, userId: order.user_id });
              io.to(`canteen_${order.tenant_id}`).emit('menu_updated');
            }

            // Public broadcast: signal inventory/menu refresh without customer information
            io.emit('menu_updated');

            console.log(`[Order Confirmed] Order ${orderId} atomically confirmed — txnId: ${resolvedTxnId}`);
            if (callback) callback(null, order);
          }
        );
      }
    );
  });
}

// --- PAYMENT API RETRIEVAL HELPERS & GATEWAY THROTTLING ---
// Cache recent Zoho API check results for 3.5s to prevent Zoho 429 rate limit spam during polling
const gatewayCheckCache = new Map();

function getCachedGatewaySession(sessionId) {
  const cached = gatewayCheckCache.get(sessionId);
  if (cached && (Date.now() - cached.timestamp < 3500)) {
    return cached.data;
  }
  return null;
}

function setCachedGatewaySession(sessionId, data) {
  if (!sessionId || !data) return;
  gatewayCheckCache.set(sessionId, { timestamp: Date.now(), data });
  if (gatewayCheckCache.size > 200) {
    const now = Date.now();
    for (const [key, val] of gatewayCheckCache.entries()) {
      if (now - val.timestamp > 10000) gatewayCheckCache.delete(key);
    }
  }
}

async function checkZohoPaymentById(paymentId, retryOn401 = true) {
  if (!process.env.ZOHO_ACCOUNT_ID || !process.env.ZOHO_CLIENT_ID || !paymentId) return null;
  const cleanId = encodeURIComponent(String(paymentId).trim());

  try {
    const accessToken = await getZohoAccessToken();
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const res = await axios.get(
      `https://payments.zoho.in/api/v1/payments/${cleanId}?account_id=${accountId}`,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    if (res.data) {
      return res.data;
    }
    return null;
  } catch (err) {
    const isNotAuthorized = err.response?.data?.message === 'Not An Authorized User' || err.response?.data?.code === 'error';
    if (err.response?.status === 401 && !isNotAuthorized && retryOn401) {
      console.warn('[Zoho API] Received 401 on payment query (token expired), forcing token refresh...');
      invalidateZohoToken(true);
      return checkZohoPaymentById(paymentId, false);
    }
    if (isNotAuthorized) {
      console.info('[Zoho API] Payment query returned Not An Authorized User; verifying via widget HMAC signature.');
    } else {
      console.error('[Zoho API] Error fetching payment by ID:', err.response?.data || err.message);
    }
    return null;
  }
}

async function checkZohoPaymentStatus(paymentSessionId, retryOn401 = true) {
  if (!process.env.ZOHO_ACCOUNT_ID || !process.env.ZOHO_CLIENT_ID || !paymentSessionId) return null;
  const cleanId = encodeURIComponent(String(paymentSessionId).trim());

  // Check memory cache first to protect gateway rate limit
  const cached = getCachedGatewaySession(cleanId);
  if (cached) return cached;

  try {
    const accessToken = await getZohoAccessToken();
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const res = await axios.get(
      `https://payments.zoho.in/api/v1/paymentsessions/${cleanId}?account_id=${accountId}`,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    if (res.data) {
      const info = extractZohoPaymentInfo(res.data);
      if (info.isPaid) {
        setCachedGatewaySession(cleanId, res.data);
      }
      return res.data;
    }
    return null;
  } catch (err) {
    const isNotAuthorized = err.response?.data?.message === 'Not An Authorized User' || err.response?.data?.code === 'error';
    if (err.response?.status === 401 && !isNotAuthorized && retryOn401) {
      console.warn('[Zoho API] Received 401 Unauthorized (token expired), forcing token refresh and retrying once...');
      invalidateZohoToken(true);
      return checkZohoPaymentStatus(paymentSessionId, false);
    }
    if (isNotAuthorized) {
      console.info('[Zoho API] Payment session query returned Not An Authorized User; verifying via widget HMAC signature.');
    } else if (err.response?.status === 429) {
      console.warn('[Zoho API] Rate limited (429). Backing off external calls.');
    } else {
      console.error('[Zoho API] Error fetching payment session:', err.response?.data || err.message);
    }
    return null;
  }
}

// Authoritative Server-Side Zoho payment verification: live Session API and direct Payment API
async function verifyZohoOrderPayment(order, optionalClientData = {}) {
  if (!order) return { isPaid: false, error: 'Order not found' };
  if (order.status !== 'Pending Payment') {
    return { isPaid: true, status: order.status, order, txnId: order.txn_id };
  }

  const sessionId = order.zoho_payment_session_id ? String(order.zoho_payment_session_id).trim() : null;
  if (!sessionId) {
    return {
      isPaid: false,
      status: order.status,
      order,
      error: 'Order is missing Zoho payment session identifier'
    };
  }

  // Fail-closed: Must have either Zoho signing key or Zoho API credentials configured
  if (!process.env.ZOHO_SIGNING_KEY && (!process.env.ZOHO_ACCOUNT_ID || !process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_REFRESH_TOKEN)) {
    return {
      isPaid: false,
      status: order.status,
      order,
      error: 'Zoho payment verification is not configured'
    };
  }

  // Treat all browser/client data strictly as untrusted input
  const clientResponse = optionalClientData.widgetResponse || optionalClientData;
  const rawClientPaymentId = optionalClientData.paymentId ||
    clientResponse?.payment_id ||
    clientResponse?.payment?.payment_id ||
    clientResponse?.id ||
    clientResponse?.txn_id;
  const clientPaymentId = (rawClientPaymentId && typeof rawClientPaymentId === 'string' && rawClientPaymentId.trim().length > 0)
    ? rawClientPaymentId.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    : null;

  const rawClientSignature = optionalClientData.signature ||
    clientResponse?.signature ||
    clientResponse?.payment?.signature ||
    (typeof clientResponse === 'object' && clientResponse?.data?.signature);
  const clientSignature = (rawClientSignature && typeof rawClientSignature === 'string' && rawClientSignature.trim().length > 0)
    ? rawClientSignature.trim()
    : null;

  let confirmedPayment = null;

  // LAYER 1: Authoritative Cryptographic HMAC Signature Verification from Zoho Checkout Widget
  // When a payment completes, Zoho generates an HMAC-SHA256 signature using the merchant's secret ZOHO_SIGNING_KEY.
  // The client cannot forge this signature without knowing ZOHO_SIGNING_KEY.
  const signingKey = process.env.ZOHO_SIGNING_KEY;
  if (signingKey && typeof signingKey === 'string' && signingKey.trim().length >= 8 &&
      clientSignature && clientPaymentId && sessionId) {
    try {
      // Replay & Injection Defense:
      // 1. clientPaymentId must be at least 6 characters and cannot equal sessionId
      // 2. sessionId must strictly match the database order.zoho_payment_session_id
      const isFormatValid = clientPaymentId.length >= 6 && clientPaymentId !== sessionId;
      const clientSessionId = optionalClientData.paymentSessionId ||
        clientResponse?.payments_session_id ||
        clientResponse?.payment_session_id;
      const isSessionBound = !clientSessionId || String(clientSessionId).trim() === sessionId;

      if (isFormatValid && isSessionBound) {
        const cleanSig = clientSignature.replace(/^(v1|v)=/, '').trim();
        const candidates = [
          `${clientPaymentId}|${sessionId}`,
          `${sessionId}|${clientPaymentId}`,
          `${clientPaymentId} | ${sessionId}`,
          `${sessionId} | ${clientPaymentId}`
        ];

        let validSig = false;
        for (const cand of candidates) {
          const expectedHex = crypto.createHmac('sha256', signingKey).update(cand).digest('hex');
          const expectedBase64 = crypto.createHmac('sha256', signingKey).update(cand).digest('base64');

          const sigTargetBuf = Buffer.from(cleanSig.toLowerCase());
          const expHexBuf = Buffer.from(expectedHex.toLowerCase());
          if (sigTargetBuf.length === expHexBuf.length && crypto.timingSafeEqual(sigTargetBuf, expHexBuf)) {
            validSig = true;
            break;
          }

          const sigRawBuf = Buffer.from(cleanSig);
          const expB64Buf = Buffer.from(expectedBase64);
          if (sigRawBuf.length === expB64Buf.length && crypto.timingSafeEqual(sigRawBuf, expB64Buf)) {
            validSig = true;
            break;
          }
        }

        if (validSig) {
          console.log(`[Verify Zoho] Authoritative widget HMAC signature verified for order ${order.id} — txn: ${clientPaymentId}`);
          confirmedPayment = {
            txnId: clientPaymentId,
            source: 'widget_hmac_signature'
          };
        } else {
          console.warn(`[Verify Zoho] Invalid widget signature received for order ${order.id}`);
        }
      }
    } catch (hmacErr) {
      console.error('[Verify Zoho] Widget HMAC verification error:', hmacErr.message);
    }
  }

  // LAYER 2: Query Live Zoho Payments Session API directly using the database-stored session ID
  if (!confirmedPayment) {
    try {
      const sessionData = await checkZohoPaymentStatus(sessionId);
      if (sessionData) {
        const info = extractZohoPaymentInfo(sessionData);
        const infoSessionId = info.paymentSessionId ? String(info.paymentSessionId).trim() : String(sessionId).trim();
        // Strict session match: must exactly match order.zoho_payment_session_id
        const sessionMatches = (infoSessionId === sessionId);
        const amountMatches = isZohoAmountMatch(info.amount, order.total);
        const realTxnId = (info.txnId && typeof info.txnId === 'string' && String(info.txnId).trim())
          ? String(info.txnId).trim()
          : null;

        if (info.isPaid && sessionMatches && amountMatches && realTxnId) {
          confirmedPayment = {
            txnId: realTxnId,
            source: 'session_api'
          };
        }
      }
    } catch (sessErr) {
      console.error('[Verify Zoho] Session API query error:', sessErr.message);
    }
  }

  // LAYER 3: Direct Authoritative Check by Payment ID via Zoho Payments API (GET /payments/{payment_id})
  if (!confirmedPayment && clientPaymentId) {
    try {
      const paymentData = await checkZohoPaymentById(clientPaymentId);
      if (paymentData) {
        const info = extractZohoPaymentInfo(paymentData);
        const infoSessionId = (info.paymentSessionId && String(info.paymentSessionId).trim()) ||
          (paymentData.payments_session_id && String(paymentData.payments_session_id).trim()) ||
          (paymentData.payment_session_id && String(paymentData.payment_session_id).trim());

        // Strict session match: must be present and must strictly match order.zoho_payment_session_id
        const sessionMatches = Boolean(infoSessionId && sessionId && infoSessionId === sessionId);
        const amountMatches = isZohoAmountMatch(info.amount, order.total);
        const realTxnId = (info.txnId && typeof info.txnId === 'string' && String(info.txnId).trim()) ||
          (paymentData.id && typeof paymentData.id === 'string' && String(paymentData.id).trim()) ||
          (paymentData.payment_id && typeof paymentData.payment_id === 'string' && String(paymentData.payment_id).trim()) ||
          null;

        if (info.isPaid && sessionMatches && amountMatches && realTxnId) {
          confirmedPayment = {
            txnId: realTxnId,
            source: 'payment_id_api'
          };
        }
      }
    } catch (payErr) {
      console.warn('[Verify Zoho] Payment lookup by ID error:', payErr.message);
    }
  }

  // ONLY confirm if authoritative cryptographic HMAC or direct Zoho API verification succeeded with a real transaction identifier
  if (confirmedPayment && confirmedPayment.txnId) {
    console.log(`[Verify Zoho] Authoritatively confirmed order ${order.id} via ${confirmedPayment.source} — txn: ${confirmedPayment.txnId}`);
    return new Promise((resolve) => {
      confirmOrderInDb(order.id, confirmedPayment.txnId, (err, updatedOrder) => {
        if (err) return resolve({ isPaid: false, error: err.message, status: order.status, order });
        resolve({ isPaid: true, status: 'Pending', order: updatedOrder || order, txnId: confirmedPayment.txnId });
      });
    });
  }

  // Fail-closed: Untrusted client claims (status, isPaid, unverified widgetResponse) can NEVER confirm an order
  return { isPaid: false, status: order.status, order, error: 'Payment not confirmed by Zoho Payments' };
}

// Verification Endpoint (Multi-Layer Verification with Zoho Payments API)
app.post('/api/orders/verify-zoho-payment', authenticateToken, async (req, res) => {
  const { paymentSessionId, orderId, paymentId, widgetResponse, signature } = req.body;
  const targetOrderId = orderId;
  if (!targetOrderId && !paymentSessionId) {
    return res.status(400).json({ error: 'Missing order or session ID' });
  }

  const query = targetOrderId ? 'SELECT * FROM orders WHERE id = ?' : 'SELECT * FROM orders WHERE zoho_payment_session_id = ?';
  const param = targetOrderId || paymentSessionId;

  db.get(query, [param], async (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    
    // Prevent IDOR: Must be order owner or admin (string-safe comparison)
    if (String(order.user_id) !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. You do not own this order.' });
    }

    if (order.status !== 'Pending Payment') {
      return res.json({
        success: true,
        isPaid: true,
        alreadyProcessed: true,
        status: order.status,
        orderId: order.id,
        txnId: order.txn_id
      });
    }

    try {
      const result = await verifyZohoOrderPayment(order, {
        paymentSessionId,
        paymentId,
        widgetResponse,
        signature
      });

      if (result.isPaid) {
        return res.json({
          success: true,
          isPaid: true,
          orderId: order.id,
          status: 'Pending',
          txnId: result.txnId
        });
      } else {
        return res.status(200).json({
          success: false,
          isPaid: false,
          pendingSync: true,
          orderId: order.id,
          status: order.status,
          message: result.error || 'Payment verification is syncing with gateway. Polling will confirm shortly.'
        });
      }
    } catch (verifyErr) {
      console.error('Zoho payment verification error:', verifyErr.message);
      return res.status(500).json({ error: 'Verification failed due to server error' });
    }
  });
});

// Admin: manually confirm a payment after verifying in their UPI/Paytm app
app.post('/api/orders/:id/confirm-payment', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { txnId } = req.body;  // optional - admin can type the UTR number
  const adminTxnId = (txnId && String(txnId).trim())
    ? String(txnId).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    : `ADMIN_MANUAL_${Date.now()}`;

  confirmOrderInDb(id, adminTxnId, (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, orderId: id, txnId: order.txn_id });
  });
});

async function syncOrderIfPending(order) {
  if (!order || order.status !== 'Pending Payment') return order;

  try {
    const result = await verifyZohoOrderPayment(order);
    if (result.isPaid && result.order) {
      return result.order;
    }
  } catch (e) {
    console.debug('Zoho sync check skipped:', e.message);
  }

  return order;
}

// Poll order status (student polling while waiting on QR modal - IDOR protected)
app.get('/api/orders/status/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM orders WHERE id = ?', [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Order not found' });
    
    // Check ownership or admin privilege (string-safe comparison)
    if (String(row.user_id) !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. You do not own this order.' });
    }

    const syncedRow = await syncOrderIfPending(row);
    res.json({ status: syncedRow.status });
  });
});

// Get orders for logged-in student (only returns paid/completed orders; pending payment/failed excluded)
app.get('/api/orders/me', authenticateToken, (req, res) => {
  db.all(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      // Only sync orders placed recently (<20 min) to avoid flooding Zoho API with expired carts
      const syncedRows = await Promise.all(rows.map(row => {
        const isRecent = row.created_at && (Date.now() - new Date(row.created_at).getTime() < 20 * 60 * 1000);
        return (row.status === 'Pending Payment' && isRecent) ? syncOrderIfPending(row) : row;
      }));
      res.json(syncedRows.filter(r => r.status !== 'Pending Payment' && r.status !== 'Failed'));
    }
  );
});

// Get all orders (Admin dashboard - displays paid, ready, and delivered orders not yet cleared from dashboard; pending payment/failed excluded)
app.get('/api/orders', requireAdmin, (req, res) => {
  const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
  const requestedTenant = req.query.tenant_id || req.headers['x-tenant-id'];
  let sql = "SELECT orders.*, users.name AS user_name, tenants.name AS canteen_name FROM orders JOIN users ON orders.user_id = users.id LEFT JOIN tenants ON orders.tenant_id = tenants.id WHERE orders.status NOT IN ('Pending Payment', 'Failed') AND (orders.is_cleared IS FALSE OR orders.is_cleared IS NULL)";
  const params = [];

  if (!isSuper) {
    sql += " AND (orders.tenant_id = ? OR orders.tenant_id IS NULL)";
    params.push(req.user.tenant_id || 1);
  } else if (requestedTenant) {
    sql += " AND orders.tenant_id = ?";
    params.push(requestedTenant);
  }
  sql += " ORDER BY orders.created_at DESC";

  db.all(sql, params, async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const syncedRows = await Promise.all((rows || []).map(row => syncOrderIfPending(row)));
    res.json(syncedRows.filter(r => r.status !== 'Pending Payment' && r.status !== 'Failed'));
  });
});

// Update order status (Admin - validates against allowed status enum)
const ALLOWED_ORDER_STATUSES = ['Pending', 'Ready for Pickup', 'Delivered', 'Cancelled'];

app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }

  if (!status || !ALLOWED_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status "${status}". Allowed: ${ALLOWED_ORDER_STATUSES.join(', ')}`
    });
  }

  db.get('SELECT user_id, items, status, tenant_id FROM orders WHERE id=?', [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Enforce tenant authorization
    const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
    if (!isSuper && order.tenant_id && req.user.tenant_id && parseInt(order.tenant_id, 10) !== parseInt(req.user.tenant_id, 10)) {
      return res.status(403).json({ error: 'Access denied: this order belongs to another canteen.' });
    }

    if (order.status === 'Pending Payment' || order.status === 'Failed') {
      return res.status(400).json({
        error: `Cannot change status of order in "${order.status}" state. Payment must be confirmed first.`
      });
    }

    db.run('UPDATE orders SET status=? WHERE id=?', [status, id], function (updateErr, info) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      if (order.user_id) {
        io.to(`user_${order.user_id}`).emit('order_status_update', { id, status, userId: order.user_id });
        if (status === 'Ready for Pickup') {
          io.to(`user_${order.user_id}`).emit('food_ready', {
            orderId: id,
            userId: order.user_id,
            message: `Your food for Order #${id} is ready for collection at the counter!`
          });
        }
      }
      io.to('admin').emit('order_status_update', { id, status, userId: order.user_id });
      if (order.tenant_id) {
        io.to(`tenant_${order.tenant_id}_admin`).emit('order_status_update', { id, status, userId: order.user_id });
      }

      res.json({ updated: info?.changes ?? 0 });
    });
  });
});

// --- HIGH-PERFORMANCE QR CODE ENDPOINT (Authenticated & IDOR protected) ---
const qrCodeCache = new Map();

app.get('/api/orders/:id/qr', authenticateToken, (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).send('Invalid order ID');
  }

  db.get('SELECT user_id, status, zoho_payment_session_id FROM orders WHERE id = ?', [id], async (dbErr, order) => {
    if (dbErr) return res.status(500).send('Unable to retrieve QR code. Please try again.');
    if (!order) return res.status(404).send('Order not found');

    // Strict ownership verification: must be authenticated and must be order owner or admin
    const isOwner = req.user && String(order.user_id) === String(req.user.id);
    const isAdmin = req.user && req.user.role === 'admin';

    if (!req.user || (!isOwner && !isAdmin)) {
      return res.status(403).json({ error: 'Access denied. You do not own this order.' });
    }

    // If order is still Pending Payment, attempt sync
    if (order.status === 'Pending Payment') {
      try {
        order = await syncOrderIfPending(order);
      } catch (_) {}
    }

    // CRITICAL SECURITY FIX: Unpaid or failed orders must NEVER receive a pickup QR code!
    if (order.status === 'Pending Payment' || order.status === 'Failed' || order.status === 'Cancelled') {
      return res.status(402).json({
        error: 'Payment required. Pickup QR code is only available after payment confirmation.',
        status: order.status
      });
    }

    // If already cached in memory, return immediately in < 0.05ms
    if (qrCodeCache.has(id)) {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.send(qrCodeCache.get(id));
    }

    // Generate SVG QR code
    QRCode.toString(id, {
      type: 'svg',
      margin: 1,
      width: 250,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    }, (err, svgString) => {
      if (err) {
        console.error('Error generating QR code:', err);
        return res.status(500).send('Failed to generate QR code');
      }

      // Cache up to 10,000 recent orders in memory
      if (qrCodeCache.size > 10000) {
        const oldestKey = qrCodeCache.keys().next().value;
        qrCodeCache.delete(oldestKey);
      }
      qrCodeCache.set(id, svgString);

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(svgString);
    });
  });
});

// Clear all delivered orders from active dashboard (Admin)
// Keeps order rows intact in DB so daily sales stats/revenue remain accurate until midnight cleanup
app.delete('/api/orders/delivered', requireAdmin, (req, res) => {
  const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
  const targetTenantId = (!isSuper) ? (req.user.tenant_id || 1) : (req.query.tenant_id || null);

  const sql = targetTenantId
    ? "UPDATE orders SET is_cleared = TRUE WHERE status='Delivered' AND (tenant_id = ? OR tenant_id IS NULL)"
    : "UPDATE orders SET is_cleared = TRUE WHERE status='Delivered'";
  const params = targetTenantId ? [targetTenantId] : [];

  db.run(sql, params, function (err, info) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('order_status_update', { action: 'cleared_delivered' });
    if (targetTenantId) {
      io.to(`tenant_${targetTenantId}_admin`).emit('order_status_update', { action: 'cleared_delivered' });
    }
    res.json({ cleared: info?.changes ?? 0 });
  });
});

// Get specific order by ID (Admin - for QR scanner)
app.get('/api/orders/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }

  db.get(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE orders.id=?',
    [id],
    async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Order not found' });
      const syncedRow = await syncOrderIfPending(row);
      res.json(syncedRow);
    }
  );
});

// --- PENDING PAYMENTS RECONCILIATION DASHBOARD ---
app.get('/api/admin/pending-payments', requireAdmin, (req, res) => {
  const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
  const targetTenantId = (!isSuper) ? (req.user.tenant_id || 1) : (req.query.tenant_id || null);

  const sql = targetTenantId
    ? "SELECT orders.*, users.name AS user_name, users.phone AS user_phone FROM orders JOIN users ON orders.user_id = users.id WHERE orders.status = 'Pending Payment' AND (orders.tenant_id = ? OR orders.tenant_id IS NULL) ORDER BY orders.created_at DESC LIMIT 50"
    : "SELECT orders.*, users.name AS user_name, users.phone AS user_phone FROM orders JOIN users ON orders.user_id = users.id WHERE orders.status = 'Pending Payment' ORDER BY orders.created_at DESC LIMIT 50";
  const params = targetTenantId ? [targetTenantId] : [];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Re-check single pending payment immediately
app.post('/api/admin/pending-payments/:id/recheck', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }

  db.get('SELECT * FROM orders WHERE id = ?', [id], async (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== 'Pending Payment') {
      return res.json({ message: `Order already resolved to status "${order.status}".`, order });
    }

    try {
      const synced = await syncOrderIfPending(order);
      const isNowPaid = synced.status === 'Pending' || synced.status === 'Ready for Pickup' || synced.status === 'Delivered';
      res.json({
        success: true,
        status: synced.status,
        orderId: order.id,
        txnId: synced.txn_id || order.txn_id || null,
        isConfirmed: isNowPaid,
        order: synced
      });
    } catch (verifyErr) {
      console.error(`[Admin Recheck] Error checking order ${id}:`, verifyErr.message);
      return res.status(500).json({ error: 'Recheck failed due to server error' });
    }
  });
});

// Helper to extract IST date and month keys
function getIstDateDetails(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istTime = new Date(d.getTime() + istOffsetMs);
  const year = istTime.getUTCFullYear();
  const monthNum = String(istTime.getUTCMonth() + 1).padStart(2, '0');
  const dayNum = String(istTime.getUTCDate()).padStart(2, '0');
  const dateKey = `${year}-${monthNum}-${dayNum}`;
  const monthKey = `${year}-${monthNum}`;

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fullMonthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const formattedDate = `${dayNum} ${monthNames[istTime.getUTCMonth()]} ${year}`;
  const formattedMonth = `${fullMonthNames[istTime.getUTCMonth()]} ${year}`;

  return { dateKey, monthKey, formattedDate, formattedMonth };
}

// Sales statistics (Admin) - Supports period filtering, daily tracking, and monthly tracking
app.get('/api/items/stats', requireAdmin, (req, res) => {
  const { period, date, month } = req.query;

  // Query all active and archived orders so historical daily & monthly data is complete
  const sql = `
    SELECT DISTINCT ON (id) id, items, total, status, created_at, paid_at 
    FROM (
      SELECT id, items, total, status, created_at, paid_at FROM orders
      UNION ALL
      SELECT id, items, total, status, created_at, paid_at FROM orders_archive
    ) combined_orders
    ORDER BY id, created_at DESC
  `;

  db.all(sql, [], (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });

    const istNow = getIstDateDetails(new Date());
    const todayKey = istNow.dateKey;
    const currentMonthKey = istNow.monthKey;

    // Daily & Monthly aggregations across all historical records
    const dailyMap = {};
    const monthlyMap = {};

    // Period-filtered collections for KPIs and item breakdown
    const itemStats = {};
    let totalRevenue = 0;
    let totalOrders = 0;
    let deliveredOrders = 0;
    let pendingOrders = 0;
    let totalItemsOrdered = 0;
    let totalItemsDelivered = 0;

    (orders || []).forEach(order => {
      // Skip orders that haven't been paid for successfully or are cancelled
      if (order.status === 'Pending Payment' || order.status === 'Failed' || order.status === 'Cancelled') {
        return;
      }

      const istInfo = getIstDateDetails(order.created_at || order.paid_at || new Date());
      const dateKey = istInfo ? istInfo.dateKey : 'Unknown';
      const monthKey = istInfo ? istInfo.monthKey : 'Unknown';
      const isDelivered = (order.status === 'Delivered');

      // 1. Accumulate Daily Stats
      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {
          date: dateKey,
          formattedDate: istInfo ? istInfo.formattedDate : dateKey,
          totalRevenue: 0,
          totalOrders: 0,
          deliveredOrders: 0,
          pendingOrders: 0,
          totalItemsOrdered: 0,
          totalItemsDelivered: 0,
          fulfillmentRate: 0
        };
      }
      dailyMap[dateKey].totalOrders++;
      if (isDelivered) dailyMap[dateKey].deliveredOrders++;
      else dailyMap[dateKey].pendingOrders++;

      // 2. Accumulate Monthly Stats
      if (!monthlyMap[monthKey]) {
        monthlyMap[monthKey] = {
          month: monthKey,
          formattedMonth: istInfo ? istInfo.formattedMonth : monthKey,
          totalRevenue: 0,
          totalOrders: 0,
          deliveredOrders: 0,
          pendingOrders: 0,
          totalItemsOrdered: 0,
          totalItemsDelivered: 0,
          fulfillmentRate: 0
        };
      }
      monthlyMap[monthKey].totalOrders++;
      if (isDelivered) monthlyMap[monthKey].deliveredOrders++;
      else monthlyMap[monthKey].pendingOrders++;

      // Parse items
      let orderDeliveredRev = 0;
      let orderDeliveredQty = 0;
      let orderOrderedQty = 0;

      let parsedItems = [];
      try {
        parsedItems = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
      } catch (parseErr) {
        parsedItems = [];
      }

      if (Array.isArray(parsedItems)) {
        parsedItems.forEach(item => {
          const qty = Number(item.quantity) || 0;
          const price = Number(item.price) || 0;
          orderOrderedQty += qty;
          if (isDelivered) {
            orderDeliveredQty += qty;
            orderDeliveredRev += (qty * price);
          }
        });
      }

      dailyMap[dateKey].totalRevenue += orderDeliveredRev;
      dailyMap[dateKey].totalItemsOrdered += orderOrderedQty;
      dailyMap[dateKey].totalItemsDelivered += orderDeliveredQty;

      monthlyMap[monthKey].totalRevenue += orderDeliveredRev;
      monthlyMap[monthKey].totalItemsOrdered += orderOrderedQty;
      monthlyMap[monthKey].totalItemsDelivered += orderDeliveredQty;

      // 3. Check if order matches the currently requested period/date filter
      let matchesFilter = true;
      if (date) {
        matchesFilter = (dateKey === date);
      } else if (month) {
        matchesFilter = (monthKey === month);
      } else if (period === 'today') {
        matchesFilter = (dateKey === todayKey);
      } else if (period === 'month' || period === 'this_month') {
        matchesFilter = (monthKey === currentMonthKey);
      }

      if (matchesFilter) {
        totalOrders++;
        if (isDelivered) deliveredOrders++;
        else pendingOrders++;

        if (Array.isArray(parsedItems)) {
          parsedItems.forEach(item => {
            const key = item.id || item.name;
            if (!itemStats[key]) {
              itemStats[key] = {
                id: item.id || key,
                name: item.name,
                price: Number(item.price) || 0,
                orderedQuantity: 0,
                deliveredQuantity: 0,
                totalRevenue: 0
              };
            }
            const qty = Number(item.quantity) || 0;
            const price = Number(item.price) || 0;
            itemStats[key].orderedQuantity += qty;
            totalItemsOrdered += qty;

            if (isDelivered) {
              itemStats[key].deliveredQuantity += qty;
              const rev = qty * price;
              itemStats[key].totalRevenue += rev;
              totalRevenue += rev;
              totalItemsDelivered += qty;
            }
          });
        }
      }
    });

    // Compute fulfillment rates for daily and monthly lists
    const dailyList = Object.values(dailyMap).map(d => {
      d.totalRevenue = Math.round(d.totalRevenue * 100) / 100;
      d.fulfillmentRate = d.totalItemsOrdered > 0 ? Math.round((d.totalItemsDelivered / d.totalItemsOrdered) * 100) : (d.deliveredOrders > 0 ? 100 : 0);
      return d;
    }).sort((a, b) => b.date.localeCompare(a.date));

    const monthlyList = Object.values(monthlyMap).map(m => {
      m.totalRevenue = Math.round(m.totalRevenue * 100) / 100;
      m.fulfillmentRate = m.totalItemsOrdered > 0 ? Math.round((m.totalItemsDelivered / m.totalItemsOrdered) * 100) : (m.deliveredOrders > 0 ? 100 : 0);
      return m;
    }).sort((a, b) => b.month.localeCompare(a.month));

    const fulfillmentRate = totalItemsOrdered > 0 ? Math.round((totalItemsDelivered / totalItemsOrdered) * 100) : (deliveredOrders > 0 ? 100 : 0);

    res.json({
      period: period || (date ? 'custom_date' : (month ? 'custom_month' : 'all')),
      selectedFilter: date || month || period || 'all',
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalOrders,
        deliveredOrders,
        pendingOrders,
        totalItemsOrdered,
        totalItemsDelivered,
        fulfillmentRate
      },
      items: itemStats,
      daily: dailyList,
      monthly: monthlyList
    });
  });
});

// ─── BULK & CUSTOMIZED CATERING ORDERS ──────────────────────────────────────

const ALLOWED_BULK_STATUSES = ['Pending Review', 'Quoted', 'Confirmed', 'Preparing', 'Delivered', 'Cancelled'];

// Create a bulk order (Guests or Authenticated Users)
app.post('/api/bulk-orders/create', optionalAuth, (req, res) => {
  let {
    event_name,
    event_date,
    event_time,
    headcount,
    items,
    custom_requirements,
    contact_name,
    contact_phone,
    delivery_location,
    estimated_total
  } = req.body;

  event_name = sanitizeTextInput(event_name, 100);
  event_time = sanitizeTextInput(event_time, 50);
  contact_name = sanitizeTextInput(contact_name, 60);
  contact_phone = sanitizeTextInput(contact_phone, 20);
  delivery_location = sanitizeTextInput(delivery_location, 200);
  custom_requirements = sanitizeTextInput(custom_requirements, 1000);

  if (!event_name || !event_date || !event_time || !headcount || !contact_name || !contact_phone || !delivery_location) {
    return res.status(400).json({ error: 'Please fill in all required event details and contact information.' });
  }

  // Validate event date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event_date)) || isNaN(Date.parse(event_date))) {
    return res.status(400).json({ error: 'Valid event date (YYYY-MM-DD) is required.' });
  }

  const parsedHeadcount = parseInt(headcount, 10);
  if (isNaN(parsedHeadcount) || parsedHeadcount <= 0 || parsedHeadcount > 10000) {
    return res.status(400).json({ error: 'Headcount must be a positive number between 1 and 10,000.' });
  }

  const cleanDigits = contact_phone.replace(/\D/g, '');
  if (cleanDigits.length < 10 || cleanDigits.length > 15) {
    return res.status(400).json({ error: 'Please provide a valid 10-digit contact phone number.' });
  }

  // Sanitize items if array
  let safeItems = [];
  if (Array.isArray(items)) {
    safeItems = items.slice(0, 50).map(it => ({
      name: sanitizeTextInput(it?.name, 100),
      quantity: Math.max(1, parseInt(it?.quantity, 10) || 1),
      price: Math.max(0, parseFloat(it?.price) || 0)
    }));
  }

  const targetTenantId = req.body.tenant_id ? (parseInt(req.body.tenant_id, 10) || 1) : 1;
  const id = `BULK_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const itemsJson = JSON.stringify(safeItems);
  const parsedEstimatedTotal = Math.max(0, parseFloat(estimated_total) || 0);
  const userId = req.user ? req.user.id : null;
  const userName = req.user ? req.user.name : contact_name;

  db.run(
    `INSERT INTO bulk_orders (
      id, tenant_id, user_id, event_name, event_date, event_time, headcount,
      items, custom_requirements, contact_name, contact_phone,
      delivery_location, estimated_total, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Review')`,
    [
      id,
      targetTenantId,
      userId,
      event_name,
      event_date,
      event_time,
      parsedHeadcount,
      itemsJson,
      custom_requirements,
      contact_name,
      contact_phone,
      delivery_location,
      parsedEstimatedTotal
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      // Notify Admin via Socket.IO
      const payload = {
        id,
        tenant_id: targetTenantId,
        event_name,
        headcount: parsedHeadcount,
        event_date,
        event_time,
        contact_name,
        contact_phone,
        delivery_location,
        estimated_total: parsedEstimatedTotal,
        items: safeItems,
        user_name: userName
      };
      io.emit('new_bulk_order', payload);
      if (targetTenantId) {
        io.to(`tenant_${targetTenantId}_admin`).emit('new_bulk_order', payload);
      }

      res.status(201).json({
        success: true,
        id,
        message: 'Bulk catering request submitted successfully! The canteen admin will review and quote.'
      });
    }
  );
});

// View my bulk orders (Authenticated Users)
app.get('/api/bulk-orders/me', authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM bulk_orders WHERE user_id = ? ORDER BY created_at DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// View guest bulk orders by IDs (Sanitized to prevent contact/address enumeration)
app.get('/api/bulk-orders/guest', (req, res) => {
  const idsParam = req.query.ids || '';
  const idList = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (idList.length === 0) return res.json([]);
  if (idList.length > 25) return res.status(400).json({ error: 'Too many IDs' });

  // Validate ID syntax
  const safeIdList = idList.filter(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s));
  if (safeIdList.length === 0) return res.json([]);

  const placeholders = safeIdList.map(() => '?').join(',');
  db.all(
    `SELECT id, event_name, event_date, event_time, headcount, items, custom_requirements, estimated_total, final_price, status, admin_notes, created_at
     FROM bulk_orders WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
    safeIdList,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// View all bulk orders (Admin)
app.get('/api/bulk-orders', requireAdmin, (req, res) => {
  const isSuper = Boolean(req.user.is_superadmin || req.user.role === 'superadmin');
  const targetTenantId = (!isSuper) ? (req.user.tenant_id || 1) : (req.query.tenant_id || null);

  const sql = targetTenantId
    ? `SELECT bulk_orders.*, users.name AS user_name, users.email AS user_email, tenants.name AS canteen_name
       FROM bulk_orders
       LEFT JOIN users ON bulk_orders.user_id = users.id
       LEFT JOIN tenants ON bulk_orders.tenant_id = tenants.id
       WHERE bulk_orders.tenant_id = ? OR bulk_orders.tenant_id IS NULL
       ORDER BY bulk_orders.created_at DESC`
    : `SELECT bulk_orders.*, users.name AS user_name, users.email AS user_email, tenants.name AS canteen_name
       FROM bulk_orders
       LEFT JOIN users ON bulk_orders.user_id = users.id
       LEFT JOIN tenants ON bulk_orders.tenant_id = tenants.id
       ORDER BY bulk_orders.created_at DESC`;
  const params = targetTenantId ? [targetTenantId] : [];

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Get specific bulk order (Admin, Owner, or verified Guest)
app.get('/api/bulk-orders/:id', optionalAuth, (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid bulk order ID' });
  }

  db.get(
    `SELECT bulk_orders.*, users.name AS user_name, users.email AS user_email
     FROM bulk_orders
     LEFT JOIN users ON bulk_orders.user_id = users.id
     WHERE bulk_orders.id = ?`,
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Bulk order not found.' });

      // Admin has full access
      if (req.user && req.user.role === 'admin') {
        return res.json(row);
      }

      // Logged in owner has full access
      if (req.user && row.user_id && row.user_id === req.user.id) {
        return res.json(row);
      }

      // If created by an authenticated user and someone else accesses without admin:
      if (row.user_id && (!req.user || row.user_id !== req.user.id)) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      // For guest access, if phone verification query is provided and matches:
      const queryPhone = (req.query.phone || '').replace(/\D/g, '');
      const orderPhone = (row.contact_phone || '').replace(/\D/g, '');
      if (queryPhone && orderPhone && (orderPhone.endsWith(queryPhone) || queryPhone.endsWith(orderPhone))) {
        return res.json(row);
      }

      // Otherwise return sanitized order data hiding personal contact numbers and sensitive addresses
      const sanitized = {
        id: row.id,
        event_name: row.event_name,
        event_date: row.event_date,
        event_time: row.event_time,
        headcount: row.headcount,
        items: row.items,
        custom_requirements: row.custom_requirements,
        estimated_total: row.estimated_total,
        final_price: row.final_price,
        status: row.status,
        admin_notes: row.admin_notes,
        created_at: row.created_at
      };
      res.json(sanitized);
    }
  );
});

// Update bulk order status, final quote price, & notes (Admin)
app.put('/api/bulk-orders/:id/status', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status, final_price, admin_notes } = req.body;

  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid bulk order ID' });
  }

  if (!status || !ALLOWED_BULK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Allowed: ${ALLOWED_BULK_STATUSES.join(', ')}` });
  }

  db.get('SELECT * FROM bulk_orders WHERE id = ?', [id], (findErr, current) => {
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!current) return res.status(404).json({ error: 'Bulk order not found.' });

    let newFinalPrice = current.final_price;
    if (final_price !== undefined && final_price !== null && final_price !== '') {
      const parsedPrice = parseFloat(final_price);
      if (isNaN(parsedPrice) || parsedPrice < 0 || parsedPrice > 10000000) {
        return res.status(400).json({ error: 'Final price must be a valid non-negative number up to 10,000,000' });
      }
      newFinalPrice = Math.round(parsedPrice * 100) / 100;
    }

    const newAdminNotes = admin_notes !== undefined ? sanitizeTextInput(admin_notes, 1000) : current.admin_notes;

    db.run(
      `UPDATE bulk_orders
       SET status = ?, final_price = ?, admin_notes = ?
       WHERE id = ?`,
      [status, newFinalPrice, newAdminNotes, id],
      function (updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });

        // Broadcast status update to student
        io.emit('bulk_order_status_update', {
          id,
          userId: current.user_id,
          status,
          final_price: newFinalPrice,
          admin_notes: newAdminNotes,
          event_name: current.event_name
        });

        res.json({
          success: true,
          message: `Bulk order updated to "${status}".`,
          order: {
            id,
            status,
            final_price: newFinalPrice,
            admin_notes: newAdminNotes
          }
        });
      }
    );
  });
});

// --- DAILY ORDERS CLEANUP ---
// Prune previous days' completed/failed orders relative to India Standard Time (IST / Asia/Kolkata)
function getIstMidnightCutoff() {
  const now = new Date();
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
  return new Date(istMidnight.getTime() - istOffsetMs).toISOString();
}

function cleanupDailyOrders() {
  const cutoff = getIstMidnightCutoff();
  // First archive completed/failed orders to orders_archive to preserve historical tracking
  const archiveSql = `
    INSERT INTO orders_archive (
      id, items, total, status, paytm_order_id, paytm_payment_id, user_id, 
      created_at, txn_ref, txn_id, paid_at, zoho_payment_session_id, is_cleared
    )
    SELECT 
      id, items, total, status, paytm_order_id, paytm_payment_id, user_id, 
      created_at, txn_ref, txn_id, paid_at, zoho_payment_session_id, is_cleared
    FROM orders 
    WHERE created_at < ? AND status IN ('Delivered', 'Failed')
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      paid_at = EXCLUDED.paid_at,
      txn_id = EXCLUDED.txn_id,
      is_cleared = EXCLUDED.is_cleared
  `;
  const deleteSql = "DELETE FROM orders WHERE created_at < ? AND status IN ('Delivered', 'Failed')";

  db.run(archiveSql, [cutoff], function (archiveErr) {
    if (archiveErr) {
      console.error('[Cleanup] Archive failed prior to pruning:', archiveErr.message);
    }
    db.run(deleteSql, [cutoff], function (err, info) {
      if (err) {
        console.error('Cleanup failed:', err.message);
      } else {
        const changes = info?.changes ?? 0;
        if (changes > 0) console.log(`Cleaned up and archived ${changes} completed/failed old order(s) prior to IST midnight (${cutoff}).`);
      }
    });
  });
}

function scheduleDailyCleanup() {
  cleanupDailyOrders();
  const getNextIstMidnightMs = () => {
    const now = new Date();
    const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const istNextMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1));
    const nextMidnightUtc = new Date(istNextMidnight.getTime() - istOffsetMs);
    return Math.max(1000, nextMidnightUtc.getTime() - now.getTime());
  };

  setTimeout(() => {
    cleanupDailyOrders();
    setInterval(cleanupDailyOrders, 24 * 60 * 60 * 1000);
  }, getNextIstMidnightMs());
}

scheduleDailyCleanup();

// --- BACKGROUND RECONCILIATION FOR STUCK PENDING PAYMENTS ---
let isReconcilingPendingZoho = false;

async function reconcilePendingZohoPayments() {
  if (isReconcilingPendingZoho) return;
  isReconcilingPendingZoho = true;

  try {
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const query = `
      SELECT * FROM orders 
      WHERE status = 'Pending Payment' 
        AND zoho_payment_session_id IS NOT NULL 
        AND created_at >= ? 
      ORDER BY created_at DESC 
      LIMIT 25
    `;

    db.all(query, [cutoff24h], async (err, orders) => {
      try {
        if (err) {
          console.error('[Reconciliation] Error querying pending orders:', err.message);
          return;
        }

        if (!orders || orders.length === 0) {
          return;
        }

        console.log(`[Reconciliation] Checking ${orders.length} stuck pending payment order(s)...`);

        for (const order of orders) {
          try {
            const result = await verifyZohoOrderPayment(order);
            if (result && result.isPaid) {
              console.log(`[Reconciliation] Successfully reconciled order ${order.id} (txn: ${result.txnId})`);
            }
          } catch (orderErr) {
            console.error(`[Reconciliation] Error verifying order ${order.id}:`, orderErr.message);
          }
          // Small delay (~500ms) between checks to prevent hammering Zoho API
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (passErr) {
        console.error('[Reconciliation] Error during reconciliation pass:', passErr.message);
      } finally {
        isReconcilingPendingZoho = false;
      }
    });
  } catch (err) {
    console.error('[Reconciliation] Unexpected error in reconcilePendingZohoPayments:', err.message);
    isReconcilingPendingZoho = false;
  }
}

// Initial reconciliation run ~30 seconds after server boot
setTimeout(reconcilePendingZohoPayments, 30 * 1000);

// Recurring reconciliation run every 2 minutes
setInterval(reconcilePendingZohoPayments, 2 * 60 * 1000);

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const host = process.env.APP_URL 
    || process.env.RENDER_EXTERNAL_URL 
    || (process.env.NODE_ENV === 'production' || process.env.RENDER ? 'https://kitcbecanteen.online' : `http://localhost:${PORT}`);
  console.log(`SRI CUMIN SEEDS CATERING SERVICES running on ${host} (port ${PORT})`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});
