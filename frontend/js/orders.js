const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.replace('login.html');
}

// Prevent Back button from restoring authenticated page from bfcache after logout
window.addEventListener('pageshow', (event) => {
  const currentToken = localStorage.getItem('token');
  const userObj = JSON.parse(localStorage.getItem('user') || 'null');
  if (!currentToken || !userObj) {
    window.location.replace('login.html');
  }
});

const socket = io({
  auth: { token }
});
let orders   = [];

// --- URL Params for Payment Callback ---
const urlParams = new URLSearchParams(window.location.search);
const isPaymentSuccess = urlParams.get('payment') === 'success';
const paymentSuccessOrderId = urlParams.get('orderId');

if (isPaymentSuccess) {
  window.history.replaceState({}, document.title, window.location.pathname);
}
if (urlParams.get('error')) {
  alert('Payment Error: ' + urlParams.get('error').replace(/_/g, ' '));
  window.history.replaceState({}, document.title, window.location.pathname);
}

// --- DOM Elements ---
const userOrdersBoard = document.getElementById('user-orders-board');
const qrModal         = document.getElementById('qr-modal');
const closeModalBtn   = document.getElementById('close-modal');
const qrcodeContainer = document.getElementById('qrcode');
const orderIdDisplay  = document.getElementById('order-id-display');

window.showPickupQR = async function(orderId) {
  if (!qrcodeContainer || !orderId) return;

  const safeId = String(orderId).trim();
  if (orderIdDisplay) {
    orderIdDisplay.innerText = safeId;
  }
  if (qrModal) {
    qrModal.classList.add('active');
  }

  qrcodeContainer.innerHTML = '<div style="padding: 2rem; text-align: center;"><i class="fa-solid fa-spinner fa-spin fa-2x" style="color: var(--primary-color);"></i><p style="margin-top:0.75rem;font-size:0.85rem;color:var(--text-muted);">Verifying & Loading QR Code...</p></div>';

  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(safeId)}/qr?token=${encodeURIComponent(token)}`);
    if (res.status === 402 || !res.ok) {
      const errData = await res.json().catch(() => ({}));
      qrcodeContainer.innerHTML = `
        <div style="padding: 1.5rem; text-align: center; background: #fef2f2; border: 1.5px solid #f87171; border-radius: 8px;">
          <i class="fa-solid fa-circle-exclamation" style="font-size: 2rem; color: #dc2626; margin-bottom: 0.5rem;"></i>
          <div style="font-size: 1.1rem; font-weight: bold; margin-bottom: 0.4rem; color: #991b1b;">Pickup QR Unavailable</div>
          <p style="font-size: 0.85rem; color: #7f1d1d; margin: 0;">${escapeHtml(errData.error || 'Payment required to view pickup QR code.')}</p>
        </div>
      `;
      return;
    }

    const svgText = await res.text();
    qrcodeContainer.innerHTML = svgText;
  } catch (err) {
    console.error('Failed to retrieve order QR code:', err);
    qrcodeContainer.innerHTML = '<p style="color:red;text-align:center;padding:1rem;">Failed to load QR code. Please check your connection and refresh.</p>';
  }
};

let currentSyncingOrderId = paymentSuccessOrderId || null;
try {
  if (!currentSyncingOrderId) {
    currentSyncingOrderId = sessionStorage.getItem('canteen_last_paid_order_id') || null;
  }
} catch (_) {}

let pollInterval = null;
let pollAttempts = 0;

async function attemptVerificationWithServer(orderId) {
  if (!orderId) return false;
  const safeId = String(orderId).trim();
  let payload = { orderId: safeId };

  try {
    const raw = sessionStorage.getItem(`canteen_verify_${safeId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        payload = { ...parsed, orderId: safeId };
      }
    }
  } catch (_) {}

  try {
    const res = await fetch(`${API_URL}/orders/verify-zoho-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      if ((data.success && data.status !== 'Pending Payment') || data.isPaid === true) {
        try {
          sessionStorage.removeItem(`canteen_verify_${safeId}`);
          sessionStorage.removeItem('canteen_last_paid_order_id');
        } catch (_) {}

        currentSyncingOrderId = null;
        const existingSync = document.getElementById(`syncing-card-${escapeHtml(safeId)}`);
        if (existingSync) existingSync.remove();

        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }

        await fetchMyOrders();
        showPickupQR(safeId);
        playNotificationSound('food_ready');
        showToast({
          title: '🎉 Payment Confirmed!',
          message: `Order #${safeId} confirmed! Show your QR code at the counter for pickup.`,
          type: 'shop-open',
          icon: 'fa-circle-check',
          duration: 8000
        });
        return true;
      }
    }
  } catch (err) {
    console.debug('Direct verification attempt skipped:', err);
  }
  return false;
}

function pollNewOrderStatus(orderId) {
  if (!orderId || pollInterval) return;
  pollAttempts = 0;

  // Run immediate direct verification check first
  attemptVerificationWithServer(orderId).then((confirmed) => {
    if (confirmed) return;

    pollInterval = setInterval(async () => {
      pollAttempts++;
      if (pollAttempts > 16) {
        clearInterval(pollInterval);
        pollInterval = null;
        updateSyncingCardTimeout(orderId);
        return;
      }

      // Check status from server
      try {
        const res = await fetch(`${API_URL}/orders/status/${encodeURIComponent(orderId)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.status && data.status !== 'Pending Payment') {
            clearInterval(pollInterval);
            pollInterval = null;
            currentSyncingOrderId = null;
            try {
              sessionStorage.removeItem(`canteen_verify_${orderId}`);
              sessionStorage.removeItem('canteen_last_paid_order_id');
            } catch (_) {}

            const existingSync = document.getElementById(`syncing-card-${escapeHtml(orderId)}`);
            if (existingSync) existingSync.remove();

            await fetchMyOrders();
            showPickupQR(orderId);
            playNotificationSound('food_ready');
            showToast({
              title: '🎉 Payment Confirmed!',
              message: `Order #${orderId} confirmed! Show your QR code at the counter for pickup.`,
              type: 'shop-open',
              icon: 'fa-circle-check',
              duration: 8000
            });
            return;
          }
        }
      } catch (_) {}

      // Periodic direct verify retry
      if (pollAttempts % 2 === 0) {
        const confirmed = await attemptVerificationWithServer(orderId);
        if (confirmed) return;
      }
    }, 2500);
  });
}

function updateSyncingCardTimeout(orderId) {
  const safeId = escapeHtml(orderId);
  const card = document.getElementById(`syncing-card-${safeId}`);
  if (!card) return;
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;width:100%;align-items:center;flex-wrap:wrap;gap:0.5rem;">
      <div>
        <h4 style="margin-bottom:0.2rem;font-family:monospace;">${safeId}</h4>
        <div style="color:#e67e22;font-weight:600;font-size:0.9rem;">
          <i class="fa-solid fa-clock"></i> Verification is taking a moment...
        </div>
      </div>
      <div>
        <span class="badge pending">Pending Confirmation</span>
      </div>
    </div>
    <div style="width:100%;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
      <p style="margin:0;font-size:0.85rem;color:var(--text-muted);">If money was debited from your account, click below to update your payment status.</p>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button id="manual-check-btn-${safeId}" class="btn btn-primary" style="padding:0.4rem 0.9rem;font-weight:bold;background:#27ae60;" onclick="manualCheckPayment('${safeId}')">
          <i class="fa-solid fa-rotate"></i> Check Status Now
        </button>
      </div>
    </div>
  `;
}

window.manualCheckPayment = async function(orderId) {
  const safeId = String(orderId).trim();
  const btn = document.getElementById(`manual-check-btn-${safeId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking Payment Status...';
  }

  // 1. Try direct verification with cached widget proof
  const confirmed = await attemptVerificationWithServer(safeId);
  if (confirmed) return;

  // 2. Query status endpoint
  try {
    const res = await fetch(`${API_URL}/orders/status/${encodeURIComponent(safeId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status && data.status !== 'Pending Payment') {
        currentSyncingOrderId = null;
        try {
          sessionStorage.removeItem(`canteen_verify_${safeId}`);
          sessionStorage.removeItem('canteen_last_paid_order_id');
        } catch (_) {}

        const card = document.getElementById(`syncing-card-${safeId}`);
        if (card) card.remove();
        await fetchMyOrders();
        showPickupQR(safeId);
        playNotificationSound('food_ready');
        showToast({
          title: '🎉 Payment Confirmed!',
          message: `Order #${safeId} is confirmed!`,
          type: 'shop-open',
          icon: 'fa-circle-check',
          duration: 8000
        });
        return;
      }
    }
  } catch (err) {
    console.error('Manual status check error:', err);
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Check Status Now';
  }
  showToast({
    title: '⏳ Updating Status',
    message: 'Payment received. Confirming your order with the kitchen.',
    type: 'shop-open',
    icon: 'fa-clock',
    duration: 5000
  });
  pollNewOrderStatus(safeId);
};

function injectSyncingOrderCard(orderId) {
  const safeId = escapeHtml(orderId);
  const existingPlaceholder = document.getElementById(`syncing-card-${safeId}`);
  if (existingPlaceholder) return;

  // If empty state exists, remove it so they don't show together
  const emptyState = userOrdersBoard.querySelector('.empty-orders-placeholder');
  if (emptyState) emptyState.remove();

  const div = document.createElement('div');
  div.id = `syncing-card-${safeId}`;
  div.className = 'order-card glass-panel pending';
  div.style.cssText = 'flex-direction:column;align-items:flex-start;gap:1rem;border-left:4px solid #f39c12;background:#fffdf9;margin-bottom:1rem;';
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;width:100%;align-items:center;flex-wrap:wrap;gap:0.5rem;">
      <div>
        <h4 style="margin-bottom:0.2rem;font-family:monospace;">${safeId}</h4>
        <div style="color:#d35400;font-weight:600;font-size:0.9rem;">
          <i class="fa-solid fa-spinner fa-spin"></i> Confirming Your Payment...
        </div>
      </div>
      <div>
        <span class="badge pending">Processing</span>
      </div>
    </div>
    <div style="width:100%;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
      <p style="margin:0;font-size:0.85rem;color:var(--text-muted);">Payment received! Confirming your order with Sri Cumin Seeds kitchen.</p>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button id="manual-check-btn-${safeId}" class="btn btn-primary" style="padding:0.4rem 0.9rem;font-weight:bold;background:#27ae60;" onclick="manualCheckPayment('${safeId}')">
          <i class="fa-solid fa-rotate"></i> Check Status Now
        </button>
      </div>
    </div>
  `;
  userOrdersBoard.insertBefore(div, userOrdersBoard.firstChild);
}

// --- Fetch & Render My Orders ---
async function fetchMyOrders(isSilent = false) {
  try {
    const res = await fetch(`${API_URL}/orders/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch orders');
    orders = await res.json();
    renderMyOrders();

    const targetOrderId = paymentSuccessOrderId || currentSyncingOrderId;

    // If customer just completed payment, handle confirmation
    if (targetOrderId) {
      const matchingOrder = orders.find(o => o.id === targetOrderId);
      
      if (!matchingOrder || matchingOrder.status === 'Pending Payment') {
        // Newly placed order is still synchronizing with payment gateway
        injectSyncingOrderCard(targetOrderId);
        pollNewOrderStatus(targetOrderId);
      } else {
        currentSyncingOrderId = null;
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        const existingSync = document.getElementById(`syncing-card-${escapeHtml(targetOrderId)}`);
        if (existingSync) existingSync.remove();

        try {
          sessionStorage.removeItem(`canteen_verify_${targetOrderId}`);
          sessionStorage.removeItem('canteen_last_paid_order_id');
        } catch (_) {}

        if (!isSilent) {
          setTimeout(() => {
            showPickupQR(targetOrderId);
            playNotificationSound('food_ready');
            showToast({
              title: '🎉 Payment Successful!',
              message: `Order #${targetOrderId} is placed! Show your QR code at the counter for pickup.`,
              type: 'shop-open',
              icon: 'fa-circle-check',
              duration: 8000
            });
          }, 300);
        }
      }
    } else if (isPaymentSuccess && orders.length > 0 && orders[0].status !== 'Pending Payment') {
      if (!isSilent) {
        setTimeout(() => {
          showPickupQR(orders[0].id);
          playNotificationSound('food_ready');
          showToast({
            title: '🎉 Payment Successful!',
            message: `Order #${orders[0].id} is placed! Show your QR code at the counter for pickup.`,
            type: 'shop-open',
            icon: 'fa-circle-check',
            duration: 8000
          });
        }, 300);
      }
    }
  } catch (err) {
    console.error(err);
    userOrdersBoard.innerHTML = '<p style="color:red">Failed to load orders. Please refresh.</p>';
  }
}

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

function playNotificationSound(type = 'chime') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    if (type === 'food_ready') {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'triangle';
      osc2.type = 'sine';

      osc1.frequency.setValueAtTime(587.33, now);
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15);

      osc2.frequency.setValueAtTime(880, now + 0.2);
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.45);

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.2);
      osc2.start(now + 0.2);
      osc2.stop(now + 0.85);
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.25);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.6);
    }
  } catch (e) {
    console.debug('Audio not supported:', e);
  }
}

function showToast({ title, message, type = 'food-ready', icon = 'fa-bell-concierge', duration = 8000 }) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `canteen-toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon"><i class="fa-solid ${icon}"></i></div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-body">${message}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.onclick = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(60px)';
    setTimeout(() => toast.remove(), 300);
  };

  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

function renderMyOrders() {
  userOrdersBoard.innerHTML = '';

  const activeOrders = orders.filter(
    o => o.status !== 'Pending Payment' && o.status !== 'Failed'
  );

  if (activeOrders.length === 0) {
    if (currentSyncingOrderId) {
      userOrdersBoard.innerHTML = '';
      return;
    }
    userOrdersBoard.innerHTML = `
      <div class="empty-orders-placeholder" style="text-align:center;padding:3rem;color:var(--text-muted);">
        <img src="logo.png" alt="Logo" style="height:80px; margin-bottom:1.5rem; filter: grayscale(0.2); opacity: 0.8; display:block; margin-left:auto; margin-right:auto;">
        You have no orders yet.
      </div>`;
    return;
  }

  activeOrders.forEach(order => {
    const items    = JSON.parse(order.items);
    const statusLc = (order.status || '').toLowerCase().replace(/\s+/g, '-');
    const safeOrderId = escapeHtml(order.id);
    const isFoodReady = order.status === 'Ready for Pickup';

    const div = document.createElement('div');
    div.className = `order-card glass-panel ${statusLc}`;
    div.style.cssText = 'flex-direction:column;align-items:flex-start;gap:1rem;';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;justify-content:space-between;width:100%;flex-wrap:wrap;gap:0.5rem;';

    // Payment Transaction ID (if available)
    const txnLine = order.txn_id
      ? `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.2rem 0.5rem;background:var(--bg-color);border-radius:var(--border-radius);display:inline-block;">
           <i class="fa-solid fa-receipt"></i> Payment Txn ID: ${escapeHtml(order.txn_id)}
         </div>`
      : '';

    headerRow.innerHTML = `
      <div class="order-details">
        <h4 style="margin-bottom:0.2rem;font-family:monospace;">${safeOrderId}</h4>
        <div style="font-weight:600;font-size:0.9rem;color:var(--primary-color);margin-bottom:0.8rem;">${escapeHtml(order.user_name)}</div>
        <div class="order-items" style="display:flex;flex-direction:column;gap:0.3rem;">
          ${items.map(i => `<div><strong>${escapeHtml(i.quantity)}×</strong> ${escapeHtml(i.name)}</div>`).join('')}
        </div>
        <div style="font-weight:700;margin-top:1rem;font-size:1.1rem;">₹${escapeHtml(order.total)}</div>
        ${txnLine}
      </div>
      <div>
        <span class="badge ${statusLc}">${escapeHtml(order.status)}</span>
      </div>
    `;

    div.appendChild(headerRow);

    // Call-to-action & Hints
    if (isFoodReady) {
      // High-visibility prompt when food is ready to collect
      const readyBanner = document.createElement('div');
      readyBanner.style.cssText = 'background: #fff8e1; border: 2px solid #f39c12; padding: 0.8rem 1.2rem; border-radius: 8px; width: 100%; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.8rem;';
      readyBanner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.6rem; color: #d35400; font-weight: 700;">
          <i class="fa-solid fa-bell-concierge fa-bounce" style="font-size: 1.3rem;"></i>
          <span>Food Ready for Pickup! Please collect at counter.</span>
        </div>
        <button class="btn btn-primary" style="background: #e67e22; border-color: #e67e22; padding: 0.5rem 1.2rem; font-weight: bold;" onclick="showPickupQR('${order.id}')">
          <i class="fa-solid fa-qrcode"></i> Show Pickup QR
        </button>
      `;
      div.appendChild(readyBanner);
    } else if (order.status === 'PAID' || order.status === 'Pending') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'margin-top:0.5rem; background: var(--primary-color); border: none; padding: 0.5rem 1rem; border-radius: 4px; color: #fff; cursor: pointer; font-weight: bold;';
      btn.innerHTML = '<i class="fa-solid fa-qrcode"></i> View QR Code to Collect Food';
      btn.onclick = () => showPickupQR(order.id);
      div.appendChild(btn);
    }

    userOrdersBoard.appendChild(div);
  });
}

// --- Close Modal ---
if (closeModalBtn) {
  closeModalBtn.onclick = () => qrModal.classList.remove('active');
}
window.addEventListener('click', (e) => {
  if (e.target === qrModal) {
    qrModal.classList.remove('active');
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qrModal && qrModal.classList.contains('active')) {
    qrModal.classList.remove('active');
  }
});

// --- Nav Logout ---
const nav = document.querySelector('nav');
if (nav) {
  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = `Logout (${user ? user.name : ''})`;
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

// --- Socket Updates ---
socket.on('order_status_update', (data) => {
  fetchMyOrders();
});

socket.on('food_ready', (data) => {
  if (user && data.userId === user.id) {
    playNotificationSound('food_ready');
    showToast({
      title: '🍽️ Food Ready for Pickup!',
      message: data.message || `Order #${data.orderId} is ready for collection at the counter.`,
      type: 'food-ready',
      icon: 'fa-bell-concierge',
      duration: 10000
    });
    fetchMyOrders();
  }
});

socket.on('shop_status_changed', (isOpen) => {
  if (isOpen) {
    playNotificationSound('shop_open');
    showToast({
      title: '🎉 Canteen is Now Open!',
      message: 'The kitchen is taking orders. Head over to Menu to order fresh food!',
      type: 'shop-open',
      icon: 'fa-store',
      duration: 7000
    });
  }
});

socket.on('payment_confirmed', (data) => {
  fetchMyOrders();
  if (data && data.orderId) {
    const syncCard = document.getElementById(`syncing-card-${escapeHtml(data.orderId)}`);
    if (syncCard) syncCard.remove();
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (user && data.userId && String(data.userId) === String(user.id)) {
      showPickupQR(data.orderId);
      playNotificationSound('food_ready');
      showToast({
        title: '🎉 Payment Confirmed!',
        message: `Order #${data.orderId} is confirmed! Show your QR code at the counter for pickup.`,
        type: 'shop-open',
        icon: 'fa-circle-check',
        duration: 8000
      });
    }
  }
});

// --- Init ---
fetchMyOrders();
