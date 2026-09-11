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

// State
let allBulkOrders   = [];
let currentFilter   = 'all';

// DOM Elements
const adminBulkBoard      = document.getElementById('admin-bulk-board');
const pendingBadge        = document.getElementById('pending-badge');
const actionModal         = document.getElementById('admin-action-modal');
const closeActionModal    = document.getElementById('close-action-modal');
const actionModalTitle    = document.getElementById('action-modal-title');
const actionModalOrderId  = document.getElementById('action-modal-order-id');
const actionModalSummary  = document.getElementById('action-modal-summary');
const adminUpdateForm     = document.getElementById('admin-update-form');
const editOrderId         = document.getElementById('edit-order-id');
const editStatus          = document.getElementById('edit-status');
const editFinalPrice      = document.getElementById('edit-final-price');
const editAdminNotes      = document.getElementById('edit-admin-notes');
const saveStatusBtn       = document.getElementById('save-status-btn');

// --- Audio Chime for New Bulk Order ---
function playBulkOrderSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'triangle';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(440, now); // A4
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.2); // A5

    osc2.frequency.setValueAtTime(554.37, now + 0.1); // C#5
    osc2.frequency.exponentialRampToValueAtTime(1108.73, now + 0.4); // C#6

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.3);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.8);
  } catch (e) {
    console.debug('Audio playback not supported:', e);
  }
}

// --- FETCH ALL BULK ORDERS ---
async function fetchBulkOrders() {
  try {
    const res = await fetch(`${API_URL}/bulk-orders`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to load bulk orders');
    allBulkOrders = await res.json();
    updatePendingBadge();
    renderBulkBoard();
  } catch (err) {
    adminBulkBoard.innerHTML = `<div style="text-align:center;color:red;grid-column:1/-1;">Error loading bulk orders: ${err.message}</div>`;
  }
}

function updatePendingBadge() {
  const pendingCount = allBulkOrders.filter(o => o.status === 'Pending Review').length;
  if (pendingCount > 0) {
    pendingBadge.style.display = 'inline-block';
    pendingBadge.innerText = pendingCount;
  } else {
    pendingBadge.style.display = 'none';
  }
}

// --- FILTER HANDLING ---
window.setFilter = function(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll('.filter-chip').forEach(b => {
    b.className = 'filter-chip btn btn-secondary';
    b.style.background = 'transparent';
    b.style.color = 'var(--text-main)';
  });
  btn.className = 'filter-chip active btn btn-primary';
  btn.style.background = 'var(--primary-color)';
  btn.style.color = '#fff';
  renderBulkBoard();
};

function renderBulkBoard() {
  adminBulkBoard.innerHTML = '';

  let filtered = allBulkOrders;
  if (currentFilter !== 'all') {
    filtered = allBulkOrders.filter(o => o.status === currentFilter);
  }

  if (filtered.length === 0) {
    adminBulkBoard.innerHTML = `
      <div style="text-align:center;padding:4rem;color:var(--text-muted);grid-column:1/-1;" class="glass-panel">
        <i class="fa-solid fa-boxes-packing" style="font-size: 3rem; margin-bottom: 1rem; color: #ccc;"></i>
        <h4 style="margin-bottom:0.5rem;">No Bulk Orders</h4>
        <p>No orders matching filter "${currentFilter}".</p>
      </div>`;
    return;
  }

  filtered.forEach(order => {
    const statusClass = getStatusClass(order.status);
    const dateFormatted = new Date(order.event_date).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });

    const items = JSON.parse(order.items || '[]');
    const totalItemsCount = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
    const cleanPhone = (order.contact_phone || '').replace(/\D/g, '');

    const priceHtml = order.final_price
      ? `<div style="font-size:1.4rem; font-weight:800; color:var(--primary-color);">₹${order.final_price} <span style="font-size:0.75rem; color:#27ae60; font-weight:700;">(Quoted)</span></div>`
      : `<div style="font-size:1.3rem; font-weight:700; color:var(--text-main);">₹${order.estimated_total} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(Est.)</span></div>`;

    const card = document.createElement('div');
    card.className = `order-card glass-panel ${statusClass}`;
    card.style.cssText = 'flex-direction: column; align-items: flex-start; gap: 1rem; border-radius: var(--border-radius); padding: 1.5rem; justify-content: space-between;';

    card.innerHTML = `
      <div style="width: 100%;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.5rem;">
          <span style="font-family: monospace; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(order.id)}</span>
          <span class="badge ${statusClass}" style="font-size: 0.85rem;">${escapeHtml(order.status)}</span>
        </div>

        <h3 style="font-size: 1.25rem; margin-bottom: 0.4rem; color: var(--text-main);">${escapeHtml(order.event_name)}</h3>
        
        <div style="display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.88rem; color: var(--text-muted); margin-bottom: 1rem;">
          <div><i class="fa-solid fa-calendar-day" style="width:18px; color:var(--primary-color);"></i> <strong>${dateFormatted}</strong> at <strong>${escapeHtml(order.event_time)}</strong></div>
          <div><i class="fa-solid fa-users" style="width:18px; color:var(--primary-color);"></i> <strong>${escapeHtml(order.headcount)} Guests</strong></div>
          <div><i class="fa-solid fa-location-dot" style="width:18px; color:var(--primary-color);"></i> ${escapeHtml(order.delivery_location)}</div>
          <div><i class="fa-solid fa-user-tie" style="width:18px; color:var(--primary-color);"></i> ${escapeHtml(order.contact_name)} (${escapeHtml(order.user_name || 'Student')})</div>
        </div>

        <!-- Menu Preview -->
        <div style="background: var(--bg-color); border: 1px solid rgba(0,0,0,0.06); border-radius: 8px; padding: 0.8rem; font-size: 0.88rem; margin-bottom: 0.8rem;">
          <div style="font-weight: 700; margin-bottom: 0.4rem; display: flex; justify-content: space-between;">
            <span><i class="fa-solid fa-utensils"></i> Menu Items (${totalItemsCount} units):</span>
          </div>
          <div style="max-height: 100px; overflow-y: auto;">
            ${items.map(i => `<div style="padding: 2px 0;"><strong>${escapeHtml(i.quantity)}×</strong> ${escapeHtml(i.name)}</div>`).join('')}
          </div>
        </div>

        <!-- Custom Requirements Callout -->
        ${order.custom_requirements ? `
          <div style="background: #fff8e1; border-left: 3px solid #f39c12; padding: 0.6rem 0.8rem; border-radius: 4px; font-size: 0.85rem; margin-bottom: 0.8rem;">
            <strong style="color: #d35400;"><i class="fa-solid fa-comment-dots"></i> Custom Note:</strong> ${escapeHtml(order.custom_requirements)}
          </div>
        ` : ''}

        <!-- Admin Note Preview -->
        ${order.admin_notes ? `
          <div style="background: #eef2ff; border-left: 3px solid #4f46e5; padding: 0.6rem 0.8rem; border-radius: 4px; font-size: 0.85rem; margin-bottom: 0.8rem;">
            <strong style="color: #4338ca;"><i class="fa-solid fa-note-sticky"></i> Kitchen Note:</strong> ${escapeHtml(order.admin_notes)}
          </div>
        ` : ''}
      </div>

      <!-- Action Footer -->
      <div style="width: 100%; border-top: 1px dashed #eee; padding-top: 0.8rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.6rem;">
        <div>${priceHtml}</div>
        <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
          <!-- WhatsApp Call Link -->
          ${cleanPhone ? `
            <a href="https://wa.me/91${cleanPhone}?text=Hi%20${encodeURIComponent(order.contact_name)},%20regarding%20your%20canteen%20bulk%20order%20for%20${encodeURIComponent(order.event_name)}..." 
               target="_blank" class="btn btn-secondary" style="padding: 0.4rem 0.7rem; font-size: 0.85rem; background: #25D366; color: #fff; border-color: #25D366;">
              <i class="fa-brands fa-whatsapp"></i>
            </a>
            <a href="tel:${cleanPhone}" class="btn btn-secondary" style="padding: 0.4rem 0.7rem; font-size: 0.85rem;">
              <i class="fa-solid fa-phone"></i>
            </a>
          ` : ''}

          <button class="btn btn-primary" style="padding: 0.4rem 0.9rem; font-size: 0.85rem; font-weight: 700;" onclick="openActionModal('${order.id}')">
            <i class="fa-solid fa-pen-to-square"></i> Manage Order
          </button>
        </div>
      </div>
    `;

    adminBulkBoard.appendChild(card);
  });
}

function getStatusClass(status) {
  switch (status) {
    case 'Approved':
    case 'Ready':
      return 'paid';
    case 'In Kitchen':
      return 'pending';
    case 'Delivered':
      return 'delivered';
    case 'Cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

// --- OPEN ACTION MODAL ---
window.openActionModal = function(orderId) {
  const order = allBulkOrders.find(o => o.id === orderId);
  if (!order) return;

  actionModalTitle.innerText = order.event_name;
  actionModalOrderId.innerText = `Order ID: ${order.id} | Coordinator: ${order.contact_name} (${order.contact_phone})`;

  editOrderId.value     = order.id;
  editStatus.value      = order.status;
  editFinalPrice.value  = order.final_price || order.estimated_total;
  editAdminNotes.value  = order.admin_notes || '';

  const items = JSON.parse(order.items || '[]');
  actionModalSummary.innerHTML = `
    <div><strong>📅 Event Date & Time:</strong> ${new Date(order.event_date).toLocaleDateString()} (${escapeHtml(order.event_time)})</div>
    <div><strong>👥 Headcount:</strong> ${escapeHtml(order.headcount)} guests | <strong>📍 Location:</strong> ${escapeHtml(order.delivery_location)}</div>
    <div><strong>🍲 Items:</strong> ${items.map(i => `${i.quantity}× ${i.name}`).join(', ')}</div>
    ${order.custom_requirements ? `<div style="margin-top:0.4rem;color:#d35400;"><strong>📝 Custom Requirements:</strong> ${escapeHtml(order.custom_requirements)}</div>` : ''}
  `;

  actionModal.classList.add('active');
};

if (closeActionModal) {
  closeActionModal.onclick = () => actionModal.classList.remove('active');
}
window.addEventListener('click', (e) => {
  if (e.target === actionModal) actionModal.classList.remove('active');
});

// --- SUBMIT ADMIN STATUS & QUOTE UPDATE ---
adminUpdateForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const id          = editOrderId.value;
  const status      = editStatus.value;
  const final_price = editFinalPrice.value;
  const admin_notes = editAdminNotes.value;

  saveStatusBtn.disabled = true;
  saveStatusBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

  try {
    const res = await fetch(`${API_URL}/bulk-orders/${id}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status, final_price, admin_notes })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update bulk order');

    // Update Local State
    const index = allBulkOrders.findIndex(o => o.id === id);
    if (index !== -1) {
      allBulkOrders[index].status = status;
      allBulkOrders[index].final_price = parseFloat(final_price) || allBulkOrders[index].estimated_total;
      allBulkOrders[index].admin_notes = admin_notes;
    }

    actionModal.classList.remove('active');
    updatePendingBadge();
    renderBulkBoard();
    alert(`✅ Bulk Order updated to "${status}" and customer notified.`);
  } catch (err) {
    alert('Update failed: ' + err.message);
  } finally {
    saveStatusBtn.disabled = false;
    saveStatusBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save & Notify Customer';
  }
});

// Utility: Escape HTML
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Real-time Socket Event ---
socket.on('new_bulk_order', (data) => {
  playBulkOrderSound();
  alert(`🔔 New Bulk Catering Request Received!\nEvent: "${data.event_name}" (${data.headcount} guests) from ${data.contact_name}.`);
  fetchBulkOrders();
});

// Admin Navigation Logout Helper
const nav = document.getElementById('admin-nav');
if (nav) {
  const logoutBtn = document.createElement('a');
  logoutBtn.href = '#';
  logoutBtn.innerText = 'Logout';
  logoutBtn.style.color = 'var(--primary-color)';
  logoutBtn.style.fontWeight = '700';
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

// --- INIT ---
fetchBulkOrders();

async function loadCanteenProfile() {
  try {
    const res = await fetch(`${API_URL}/canteen/profile`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    const profile = await res.json();
    const nameEl = document.getElementById('current-canteen-name');
    const slugEl = document.getElementById('current-canteen-slug');
    const storefrontBtn = document.getElementById('btn-storefront-link');
    if (nameEl) nameEl.textContent = profile.name || 'My Canteen';
    if (slugEl && profile.slug) slugEl.textContent = `@${profile.slug}`;
    if (storefrontBtn && profile.slug) storefrontBtn.href = `menu.html?canteen=${encodeURIComponent(profile.slug)}`;
  } catch (err) {
    console.warn('Could not load canteen profile:', err);
  }
}
loadCanteenProfile();
