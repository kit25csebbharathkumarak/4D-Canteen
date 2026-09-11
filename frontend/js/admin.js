const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user || user.role !== 'admin') {
  window.location.replace('login.html');
}

// Prevent Back button from restoring authenticated admin page from bfcache after logout
window.addEventListener('pageshow', (event) => {
  const currentToken = localStorage.getItem('token');
  const userObj = JSON.parse(localStorage.getItem('user') || 'null');
  if (!currentToken || !userObj || userObj.role !== 'admin') {
    window.location.replace('login.html');
  }
});
const socket = io({
  auth: { token }
});
// --- DOM ---
const ordersBoard              = document.getElementById('orders-board');
const recentlyScannedContainer = document.getElementById('recently-scanned-container');
const scannedOrderDetails      = document.getElementById('scanned-order-details');
const orderSearchInput         = document.getElementById('order-search');

let orders          = [];
let lastScannedId   = null;
let searchQuery     = '';

// --- QR Scanner ---
const html5QrcodeScanner = new Html5QrcodeScanner(
  'reader',
  { fps: 10, qrbox: { width: 250, height: 250 } },
  false
);
html5QrcodeScanner.render(onScanSuccess, () => {});

let isScanInFlight = false;
const scanCooldownMap = new Map();

function onScanSuccess(decodedText) {
  if (!decodedText) return;
  const cleanId = String(decodedText).trim();
  if (!cleanId) return;

  const now = Date.now();
  const lastScanTime = scanCooldownMap.get(cleanId);
  // Prevent re-triggering the same order within 4 seconds
  if (lastScanTime && (now - lastScanTime < 4000)) {
    return;
  }

  // If a scan request is currently in-flight, ignore
  if (isScanInFlight) return;

  scanCooldownMap.set(cleanId, now);

  // Clean old entries to prevent memory growth
  if (scanCooldownMap.size > 100) {
    for (const [id, time] of scanCooldownMap.entries()) {
      if (now - time > 30000) scanCooldownMap.delete(id);
    }
  }

  fetchOrderAndFulfill(cleanId);
}

// --- HTML Sanitization Helper to prevent Stored XSS ---
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

window.closeScannedModal = function() {
  if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
  if (window.scanDismissInterval) clearInterval(window.scanDismissInterval);
  if (recentlyScannedContainer) {
    recentlyScannedContainer.style.display = 'none';
  }
};

function startScanCountdown(seconds = 5) {
  if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
  if (window.scanDismissInterval) clearInterval(window.scanDismissInterval);

  let remaining = seconds;
  const chip = document.getElementById('scan-countdown');
  if (chip) chip.textContent = `${remaining}s`;

  window.scanDismissInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      if (chip) chip.textContent = `${remaining}s`;
    } else {
      if (chip) chip.textContent = '0s';
      clearInterval(window.scanDismissInterval);
    }
  }, 1000);

  window.scanDismissTimeout = setTimeout(() => {
    window.closeScannedModal();
  }, seconds * 1000);
}

function playSecurityAlarmSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.setValueAtTime(880, now + 0.15);
    osc.frequency.setValueAtTime(440, now + 0.3);
    osc.frequency.setValueAtTime(880, now + 0.45);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.65);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.65);
  } catch (_) {}
}

async function fetchOrderAndFulfill(orderId) {
  isScanInFlight = true;
  try {
    const res = await fetch(`${API_URL}/orders/${encodeURIComponent(orderId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) { 
      scannedOrderDetails.innerHTML = `
        <div style="color: #991b1b; font-weight: 700; font-size: 1rem; padding: 1rem; background: #fee2e2; border: 1.5px solid #fca5a5; border-radius: 16px; display: flex; align-items: center; gap: 0.75rem;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.3rem; color: #dc2626;"></i>
          <div>Order not found: <strong style="font-family: monospace;">${escapeHtml(orderId)}</strong></div>
        </div>
      `;
      recentlyScannedContainer.style.display = 'flex';
      startScanCountdown(4);
      return; 
    }

    const order = await res.json();

    // If order is already delivered, do NOT show the popup modal
    if (order.status === 'Delivered') {
      return;
    }

    // CRITICAL SECURITY ENFORCEMENT: Block unpaid or failed orders with loud alert and red warning banner!
    if (order.status === 'Pending Payment' || order.status === 'Failed' || order.status === 'Cancelled' || order.is_paid === false) {
      playSecurityAlarmSound();
      scannedOrderDetails.innerHTML = `
        <div style="color: #ffffff; background: linear-gradient(135deg, #b91c1c, #dc2626); padding: 1.5rem; border-radius: 16px; box-shadow: 0 10px 25px rgba(220, 38, 38, 0.4); text-align: center;">
          <div style="font-size: 3rem; margin-bottom: 0.5rem;"><i class="fa-solid fa-ban"></i></div>
          <h2 style="margin: 0 0 0.5rem 0; font-size: 1.5rem; font-weight: 800; letter-spacing: 0.5px;">DO NOT HAND OVER FOOD!</h2>
          <div style="background: rgba(0,0,0,0.25); padding: 0.75rem 1rem; border-radius: 10px; margin: 0.8rem 0; font-size: 1.1rem; font-weight: 700;">
            PAYMENT NOT RECEIVED (Status: ${escapeHtml(order.status)})
          </div>
          <p style="margin: 0.5rem 0 0; font-size: 0.95rem; opacity: 0.95;">
            Order <strong>#${escapeHtml(order.id)}</strong> has not been confirmed by the payment gateway.
          </p>
        </div>
      `;
      recentlyScannedContainer.style.display = 'flex';
      startScanCountdown(8);
      return;
    }

    // Order is confirmed paid: update status to Delivered first, then show handover details
    const updated = await updateOrderStatus(orderId, 'Delivered');
    if (!updated) {
      return;
    }

    lastScannedId = order.id;
    renderScannedOrderDetails(order);
  } catch (err) {
    console.error(err);
  } finally {
    isScanInFlight = false;
  }
}

function renderScannedOrderDetails(order) {
  let items = [];
  try {
    items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
  } catch (_) {
    items = [];
  }

  const itemsHtml = items.map(i => `
    <div class="scan-item-card">
      <div class="scan-item-qty-badge">${escapeHtml(i.quantity)}×</div>
      <div class="scan-item-info">
        <div class="scan-item-title">${escapeHtml(i.name)}</div>
      </div>
    </div>
  `).join('');

  const txnLine = order.txn_id
    ? `<div class="scan-txn-badge">
         <i class="fa-solid fa-receipt"></i> Txn ID: ${escapeHtml(order.txn_id)}
       </div>`
    : '';

  scannedOrderDetails.innerHTML = `
    <!-- Customer & Order ID Strip -->
    <div class="scan-meta-strip">
      <div class="scan-meta-item">
        <span class="scan-meta-label">Customer</span>
        <span class="scan-meta-val"><i class="fa-solid fa-user" style="color: var(--primary-color);"></i> ${escapeHtml(order.user_name || 'Customer')}</span>
      </div>
      <div class="scan-meta-item" style="text-align: right;">
        <span class="scan-meta-label">Order ID</span>
        <span class="scan-meta-val scan-order-id-code">${escapeHtml(order.id)}</span>
      </div>
    </div>

    <!-- Items To Prepare / Hand Over (Large Quantity and Item Name) -->
    <div class="scan-food-section">
      <div class="scan-food-header">
        <i class="fa-solid fa-bell-concierge" style="color: var(--primary-color);"></i> Items to Hand Over
      </div>
      <div class="scan-food-list">
        ${itemsHtml || '<div style="color: var(--text-muted); font-size: 0.9rem;">No items listed</div>'}
      </div>
    </div>

    <!-- Amount & Status Row -->
    <div class="scan-summary-strip">
      <div class="scan-amount-box">
        <span class="scan-amount-label">Total Amount</span>
        <span class="scan-amount-val">₹${escapeHtml(order.total)}</span>
      </div>
      <div class="scan-status-box">
        <span class="scan-status-label">Status</span>
        <span class="badge delivered"><i class="fa-solid fa-check"></i> Delivered</span>
      </div>
    </div>

    ${txnLine}

    <div class="scan-delivery-confirmed">
      <i class="fa-solid fa-circle-check"></i> Handed over & Marked as <strong>Delivered</strong>
    </div>
  `;

  recentlyScannedContainer.style.display = 'flex';
  startScanCountdown(5);
  renderOrders();
}

// --- Order Status Update ---
async function updateOrderStatus(id, status) {
  try {
    const res = await fetch(`${API_URL}/orders/${encodeURIComponent(id)}/status`, {
      method:  'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg = errData.error || `Failed to update order status to ${status}`;
      alert(`Error: ${msg}`);
      return false;
    }
    fetchOrders();
    return true;
  } catch (err) {
    console.error(err);
    alert(`Network Error: Failed to update order status to ${status}`);
    return false;
  }
}
window.updateOrderStatus = updateOrderStatus;

// Admin confirms payment manually (e.g. verified in payment gateway or counter)
async function confirmPayment(orderId) {
  const txnId = prompt('Enter Payment Reference / Txn / UTR Number (optional, leave blank to auto-generate):');
  if (txnId === null) return; // User cancelled

  try {
    const res = await fetch(`${API_URL}/orders/${encodeURIComponent(orderId)}/confirm-payment`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ txnId: txnId.trim() })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to confirm payment');
      return;
    }

    fetchOrders();
  } catch (err) {
    console.error('Error confirming payment:', err);
    alert('Network error while confirming payment');
  }
}
window.confirmPayment = confirmPayment;

// --- Fetch & Render Orders ---
async function fetchOrders() {
  try {
    const res = await fetch(`${API_URL}/orders`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.clear();
      window.location.href = 'login.html';
      return;
    }
    orders = await res.json();
    renderOrders();
  } catch (err) {
    console.error(err);
  }
}

function renderOrders() {
  ordersBoard.innerHTML = '';

  const filtered = orders.filter(o =>
    o.status !== 'Pending Payment' &&
    o.status !== 'Failed' &&
    o.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filtered.length === 0) {
    ordersBoard.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--text-muted);">No orders found matching "${escapeHtml(searchQuery)}"</div>`;
    return;
  }

  filtered.forEach(order => {
    const items    = JSON.parse(order.items);
    const statusLc = (order.status || '').toLowerCase().replace(/\s+/g, '-');
    const isHighlight = lastScannedId === order.id;

    const txnLine = order.txn_id
      ? `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.2rem 0.4rem;background:var(--bg-color);border-radius:var(--border-radius);display:inline-block;">
           <i class="fa-solid fa-receipt"></i> Txn ID: ${escapeHtml(order.txn_id)}
         </div>`
      : '';

    // Action buttons per status
    let actionBtns = '';
    const safeOrderId = escapeHtml(order.id);
    if (order.status === 'Pending') {
      actionBtns = `
        <div style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;">
          <button class="btn btn-primary"
            style="font-size:0.8rem;padding:0.35rem 0.7rem;background:#e67e22;border-color:#e67e22;"
            onclick="updateOrderStatus('${safeOrderId}', 'Ready for Pickup')">
            <i class="fa-solid fa-bell"></i> Food Ready (Alert)
          </button>
          <button class="btn btn-secondary"
            style="font-size:0.8rem;padding:0.3rem 0.6rem;"
            onclick="updateOrderStatus('${safeOrderId}', 'Delivered')">
            <i class="fa-solid fa-check"></i> Mark Delivered
          </button>
        </div>`;
    } else if (order.status === 'Ready for Pickup') {
      actionBtns = `
        <div style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;">
          <button class="btn btn-secondary"
            style="font-size:0.78rem;padding:0.3rem 0.6rem;background:#27ae60;border-color:#27ae60;color:#fff;"
            onclick="updateOrderStatus('${safeOrderId}', 'Delivered')">
            <i class="fa-solid fa-circle-check"></i> Mark Delivered
          </button>
          <button class="btn btn-secondary"
            style="font-size:0.75rem;padding:0.25rem 0.5rem;opacity:0.85;"
            onclick="updateOrderStatus('${safeOrderId}', 'Ready for Pickup')">
            <i class="fa-solid fa-bell"></i> Re-alert Customer
          </button>
        </div>`;
    }

    const div = document.createElement('div');
    div.id        = `order-card-${safeOrderId}`;
    div.className = `order-card glass-panel ${statusLc} ${isHighlight ? 'highlight' : ''}`;
    div.innerHTML = `
      <div class="order-details">
        <h4 style="margin-bottom:0.2rem;">${safeOrderId}</h4>
        <div style="font-weight:600;font-size:0.9rem;color:var(--primary-color);margin-bottom:0.5rem;">${escapeHtml(order.user_name)}</div>
        <div class="order-items" style="display:flex;flex-direction:column;gap:0.2rem;">
          ${items.map(i => `<div>• ${escapeHtml(i.quantity)}× ${escapeHtml(i.name)}</div>`).join('')}
        </div>
        <div style="font-weight:700;margin-top:0.8rem;font-size:1.1rem;">₹${escapeHtml(order.total)}</div>
        ${txnLine}
      </div>
      <div style="text-align:right;">
        <span class="badge ${statusLc}">${escapeHtml(order.status)}</span>
        ${actionBtns}
      </div>
    `;
    ordersBoard.appendChild(div);
  });
}

// --- Socket Events ---
socket.on('new_order', () => fetchOrders());
socket.on('order_status_update', () => fetchOrders());
socket.on('payment_confirmed', () => fetchOrders());

socket.on('menu_updated', () => { /* menu change doesn't affect admin orders view */ });

// --- Clear Delivered Orders ---
async function clearDeliveredOrders() {
  if (!confirm('Clear delivered orders from dashboard? (Today\'s sales statistics and revenue will be preserved)')) return;
  try {
    const res = await fetch(`${API_URL}/orders/delivered`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) { alert('Failed to clear delivered orders.'); return; }
    alert('Delivered orders cleared from dashboard.');
    fetchOrders();
  } catch (err) {
    console.error(err);
    alert('Error clearing delivered orders.');
  }
}

// --- Logout ---
const nav = document.getElementById('admin-nav');
if (nav) {
  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = 'Logout';
  logoutBtn.style.cssText = 'color:var(--primary-color);font-weight:700;';
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('canteen_cart')) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) {}
    window.location.replace('login.html');
  };
  nav.appendChild(logoutBtn);
}

// --- Init ---
fetchOrders();

document.getElementById('clear-delivered-btn').addEventListener('click', clearDeliveredOrders);

orderSearchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderOrders();
});

// --- Shop Status Toggle ---
const shopStatusToggle = document.getElementById('shop-status-toggle');
const shopStatusBadge = document.getElementById('shop-status-badge');

function updateShopStatusBadge(isOpen) {
  if (!shopStatusBadge) return;
  if (isOpen) {
    shopStatusBadge.textContent = 'OPEN';
    shopStatusBadge.style.background = '#d1fae5';
    shopStatusBadge.style.color = '#065f46';
    shopStatusBadge.style.borderColor = '#a7f3d0';
  } else {
    shopStatusBadge.textContent = 'CLOSED';
    shopStatusBadge.style.background = '#fee2e2';
    shopStatusBadge.style.color = '#991b1b';
    shopStatusBadge.style.borderColor = '#fecaca';
  }
}

if (shopStatusToggle) {
  // Fetch initial status
  fetch(`${API_URL}/shop-status`)
    .then(res => res.json())
    .then(data => {
      const isOpen = Boolean(data.isOpen);
      shopStatusToggle.checked = isOpen;
      updateShopStatusBadge(isOpen);
    })
    .catch(err => console.error('Error fetching shop status:', err));

  // Handle toggle change
  shopStatusToggle.addEventListener('change', async (e) => {
    const isOpen = e.target.checked;
    updateShopStatusBadge(isOpen);
    try {
      const res = await fetch(`${API_URL}/shop-status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ isOpen })
      });
      if (!res.ok) {
        shopStatusToggle.checked = !isOpen; // revert
        updateShopStatusBadge(!isOpen);
        alert('Failed to update shop status');
      }
    } catch (err) {
      console.error(err);
      shopStatusToggle.checked = !isOpen; // revert
      updateShopStatusBadge(!isOpen);
    }
  });

  socket.on('shop_status_changed', (isOpen) => {
    shopStatusToggle.checked = Boolean(isOpen);
    updateShopStatusBadge(Boolean(isOpen));
  });
}

// --- CANTEEN SAAS PROFILE & BRANDING MANAGEMENT ---
let currentCanteenProfile = null;
window._currentCanteenQrData = null;

async function loadCanteenProfile() {
  try {
    const res = await fetch(`${API_URL}/canteen/profile`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    currentCanteenProfile = await res.json();

    const nameEl = document.getElementById('current-canteen-name');
    const slugEl = document.getElementById('current-canteen-slug');
    const storefrontBtn = document.getElementById('btn-storefront-link');

    if (nameEl) nameEl.textContent = currentCanteenProfile.name || 'My Canteen';
    if (slugEl && currentCanteenProfile.slug) slugEl.textContent = `@${currentCanteenProfile.slug}`;
    if (storefrontBtn && currentCanteenProfile.slug) {
      storefrontBtn.href = `menu.html?canteen=${encodeURIComponent(currentCanteenProfile.slug)}`;
    }
  } catch (err) {
    console.warn('Failed to load canteen profile:', err);
  }
}
loadCanteenProfile();

// Table QR Modal
window.openCanteenQrModal = async function() {
  const modal = document.getElementById('canteen-qr-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  const qrImg = document.getElementById('canteen-qr-img');
  const urlInput = document.getElementById('canteen-qr-url-input');
  const titleEl = document.getElementById('canteen-qr-title');

  if (titleEl && currentCanteenProfile) {
    titleEl.textContent = `${currentCanteenProfile.name} - Scan to Order`;
  }

  try {
    const res = await fetch(`${API_URL}/canteen/qr`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      window._currentCanteenQrData = data;
      if (qrImg) qrImg.src = data.qr_code;
      if (urlInput) urlInput.value = data.order_url;
      if (titleEl) titleEl.textContent = `${data.tenant_name} - Scan to Order`;
    }
  } catch (err) {
    console.error('Failed to load canteen QR:', err);
  }
};

window.closeCanteenQrModal = function() {
  const modal = document.getElementById('canteen-qr-modal');
  if (modal) modal.style.display = 'none';
};

window.downloadCanteenQr = function() {
  if (!window._currentCanteenQrData || !window._currentCanteenQrData.qr_code) {
    alert('QR code is still loading. Please wait.');
    return;
  }
  const link = document.createElement('a');
  link.href = window._currentCanteenQrData.qr_code;
  link.download = `${window._currentCanteenQrData.slug || 'canteen'}-table-qr.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

window.printCanteenStandee = function() {
  window.print();
};

window.copyStorefrontUrl = function() {
  const urlInput = document.getElementById('canteen-qr-url-input');
  if (urlInput) {
    urlInput.select();
    navigator.clipboard.writeText(urlInput.value).then(() => {
      alert('Storefront link copied to clipboard!');
    }).catch(() => {
      document.execCommand('copy');
      alert('Storefront link copied!');
    });
  }
};

// Canteen Settings Modal
window.openCanteenSettingsModal = async function() {
  const modal = document.getElementById('canteen-settings-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  if (!currentCanteenProfile) {
    await loadCanteenProfile();
  }

  if (currentCanteenProfile) {
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };

    setVal('setting-canteen-name', currentCanteenProfile.name);
    setVal('setting-canteen-tagline', currentCanteenProfile.tagline);
    setVal('setting-canteen-desc', currentCanteenProfile.description);
    setVal('setting-canteen-phone', currentCanteenProfile.contact_phone);
    setVal('setting-canteen-email', currentCanteenProfile.contact_email);
    setVal('setting-canteen-address', currentCanteenProfile.address);
    setVal('setting-canteen-upi-id', currentCanteenProfile.upi_id);
    setVal('setting-canteen-upi-name', currentCanteenProfile.upi_name);
    setVal('setting-canteen-logo', currentCanteenProfile.logo_url);
    setVal('setting-canteen-banner', currentCanteenProfile.banner_url);
    if (currentCanteenProfile.theme_color) {
      setVal('setting-canteen-theme', currentCanteenProfile.theme_color);
      const hexEl = document.getElementById('theme-color-hex');
      if (hexEl) hexEl.textContent = currentCanteenProfile.theme_color;
    }

    const planDisplay = document.getElementById('canteen-plan-display');
    if (planDisplay) planDisplay.textContent = (currentCanteenProfile.plan_tier || 'growth').toUpperCase() + ' PLAN';

    const statusTag = document.getElementById('canteen-status-tag');
    if (statusTag) statusTag.textContent = (currentCanteenProfile.status || 'active').toUpperCase();
  }
};

window.closeCanteenSettingsModal = function() {
  const modal = document.getElementById('canteen-settings-modal');
  if (modal) modal.style.display = 'none';
};

window.saveCanteenSettings = async function(e) {
  if (e) e.preventDefault();
  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  const payload = {
    name: document.getElementById('setting-canteen-name')?.value.trim(),
    tagline: document.getElementById('setting-canteen-tagline')?.value.trim(),
    description: document.getElementById('setting-canteen-desc')?.value.trim(),
    contact_phone: document.getElementById('setting-canteen-phone')?.value.trim(),
    contact_email: document.getElementById('setting-canteen-email')?.value.trim(),
    address: document.getElementById('setting-canteen-address')?.value.trim(),
    upi_id: document.getElementById('setting-canteen-upi-id')?.value.trim(),
    upi_name: document.getElementById('setting-canteen-upi-name')?.value.trim(),
    logo_url: document.getElementById('setting-canteen-logo')?.value.trim(),
    banner_url: document.getElementById('setting-canteen-banner')?.value.trim(),
    theme_color: document.getElementById('setting-canteen-theme')?.value.trim()
  };

  try {
    const res = await fetch(`${API_URL}/canteen/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    const updated = await res.json();
    if (res.ok) {
      currentCanteenProfile = updated;
      alert('Canteen branding and settings updated successfully!');
      closeCanteenSettingsModal();
      loadCanteenProfile();
    } else {
      alert(updated.error || 'Failed to update settings');
    }
  } catch (err) {
    alert('Error saving settings: ' + err.message);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
  }
};

// Wire color picker
const themeColorInput = document.getElementById('setting-canteen-theme');
if (themeColorInput) {
  themeColorInput.addEventListener('input', (e) => {
    const hex = document.getElementById('theme-color-hex');
    if (hex) hex.textContent = e.target.value;
  });
}

// Wire Header & Aside buttons
document.getElementById('btn-header-qr')?.addEventListener('click', openCanteenQrModal);
document.getElementById('btn-aside-qr')?.addEventListener('click', openCanteenQrModal);
document.getElementById('btn-header-settings')?.addEventListener('click', openCanteenSettingsModal);
document.getElementById('btn-aside-settings')?.addEventListener('click', openCanteenSettingsModal);
