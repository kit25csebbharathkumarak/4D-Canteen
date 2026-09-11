const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

const socket = io({
  auth: token ? { token } : {}
});

// State
let allMenuItems   = [];
let selectedItems  = {}; // { [itemId]: { id, name, price, quantity, image } }
let myBulkOrders   = [];

// DOM Elements
const tabBtnRequest       = document.getElementById('tab-btn-request');
const tabBtnHistory       = document.getElementById('tab-btn-history');
const sectionRequestForm  = document.getElementById('section-request-form');
const sectionHistory      = document.getElementById('section-history');
const bulkItemsContainer  = document.getElementById('bulk-items-container');
const bulkItemSearch      = document.getElementById('bulk-item-search');
const selectedItemsCount  = document.getElementById('selected-items-count');
const estimatedTotalDisp  = document.getElementById('estimated-total-display');
const bulkOrderForm       = document.getElementById('bulk-order-form');
const myBulkCount         = document.getElementById('my-bulk-count');
const bulkHistoryContainer= document.getElementById('bulk-history-container');
const bulkDetailsModal    = document.getElementById('bulk-details-modal');
const closeBulkModal      = document.getElementById('close-bulk-modal');
const modalEventTitle     = document.getElementById('modal-event-title');
const modalOrderId        = document.getElementById('modal-order-id');
const modalContentBody    = document.getElementById('modal-content-body');
const submitBulkBtn       = document.getElementById('submit-bulk-btn');

// Update Header & Bottom Navigation based on auth state
const headerNav = document.getElementById('header-nav');
const bottomNav = document.getElementById('bottom-nav');
if (user && token) {
  if (headerNav) {
    headerNav.innerHTML = `
      <a href="menu.html">Menu</a>
      <a href="orders.html">My Orders</a>
      <a href="#" onclick="try{localStorage.removeItem('token');localStorage.removeItem('user');Object.keys(localStorage).forEach(k=>{if(k.startsWith('canteen_cart'))localStorage.removeItem(k);});}catch(_){}window.location.replace('login.html');return false;">Logout (${escapeHtml(user.name)})</a>
    `;
  }
  if (bottomNav) {
    bottomNav.innerHTML = `
      <a href="menu.html"><i class="fa-solid fa-utensils"></i><span>Menu</span></a>
      <a href="bulk-order.html" class="active"><i class="fa-solid fa-boxes-stacked"></i><span>Bulk</span></a>
      <a href="orders.html"><i class="fa-solid fa-receipt"></i><span>Orders</span></a>
      <a href="#" onclick="try{localStorage.removeItem('token');localStorage.removeItem('user');Object.keys(localStorage).forEach(k=>{if(k.startsWith('canteen_cart'))localStorage.removeItem(k);});}catch(_){}window.location.replace('login.html');return false;"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></a>
    `;
  }
} else {
  if (headerNav) {
    headerNav.innerHTML = `
      <a href="menu.html">Menu</a>
      <a href="login.html" class="btn btn-secondary" style="padding: 0.3rem 0.8rem; font-size: 0.85rem; border-radius: 16px;">Login / Register</a>
    `;
  }
}

// Pre-fill Coordinator Name if user is logged in
const contactNameInput = document.getElementById('contact-name');
if (contactNameInput && user && user.name) {
  contactNameInput.value = user.name;
}

// Set Minimum Event Date to Today
const eventDateInput = document.getElementById('event-date');
if (eventDateInput) {
  const today = new Date().toISOString().split('T')[0];
  eventDateInput.min = today;
  eventDateInput.value = today;
}

// --- TAB SWITCHING ---
function switchTab(tab) {
  if (tab === 'request') {
    sectionRequestForm.style.display = 'block';
    sectionHistory.style.display     = 'none';

    tabBtnRequest.className = 'btn btn-primary';
    tabBtnRequest.style.background = 'var(--primary-color)';
    tabBtnRequest.style.color = '#fff';

    tabBtnHistory.className = 'btn btn-secondary';
    tabBtnHistory.style.background = 'transparent';
    tabBtnHistory.style.color = 'var(--text-main)';
    tabBtnHistory.style.boxShadow = 'none';
  } else {
    sectionRequestForm.style.display = 'none';
    sectionHistory.style.display     = 'block';

    tabBtnHistory.className = 'btn btn-primary';
    tabBtnHistory.style.background = 'var(--primary-color)';
    tabBtnHistory.style.color = '#fff';

    tabBtnRequest.className = 'btn btn-secondary';
    tabBtnRequest.style.background = 'transparent';
    tabBtnRequest.style.color = 'var(--text-main)';
    tabBtnRequest.style.boxShadow = 'none';

    fetchMyBulkOrders();
  }
}

if (tabBtnRequest) tabBtnRequest.onclick = () => switchTab('request');
if (tabBtnHistory) tabBtnHistory.onclick = () => switchTab('history');

// --- FETCH MENU ITEMS FOR BULK SELECTOR ---
async function fetchMenuItems() {
  try {
    const res = await fetch(`${API_URL}/items`);
    if (!res.ok) throw new Error('Failed to load menu');
    allMenuItems = await res.json();
    renderBulkItems(allMenuItems);
  } catch (err) {
    if (bulkItemsContainer) {
      bulkItemsContainer.innerHTML = `<div style="text-align:center;color:red;grid-column:1/-1;">Error loading dishes: ${err.message}</div>`;
    }
  }
}

function renderBulkItems(items) {
  if (!bulkItemsContainer) return;
  bulkItemsContainer.innerHTML = '';

  if (items.length === 0) {
    bulkItemsContainer.innerHTML = `<div style="text-align:center;color:var(--text-muted);grid-column:1/-1;">No dishes found matching search.</div>`;
    return;
  }

  items.forEach(item => {
    const isSelected = !!selectedItems[item.id];
    const qty = isSelected ? selectedItems[item.id].quantity : 0;

    const card = document.createElement('div');
    card.className = 'bulk-item-card glass-panel';
    card.style.cssText = `padding: 1rem; border: 2px solid ${isSelected ? 'var(--primary-color)' : 'rgba(0,0,0,0.1)'}; border-radius: var(--border-radius); transition: var(--transition); background: ${isSelected ? '#fffdfa' : '#fff'};`;

    card.innerHTML = `
      <div style="display: flex; gap: 0.8rem; align-items: center;">
        <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" 
          onerror="this.src='logo.png'" 
          style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px; border: 1px solid #ddd;">
        <div style="flex-grow: 1;">
          <h4 style="font-size: 1rem; margin-bottom: 0.2rem;">${escapeHtml(item.name)}</h4>
          <div style="font-weight: 700; color: var(--primary-color); font-size: 0.95rem;">₹${escapeHtml(item.price)} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;">/ unit</span></div>
        </div>
      </div>

      <!-- Quantity Controls -->
      <div style="margin-top: 0.8rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; border-top: 1px solid #f0f0f0; padding-top: 0.6rem;">
        <div style="display: flex; align-items: center; gap: 0.3rem;">
          <button type="button" class="btn btn-secondary" style="padding: 0.2rem 0.6rem; font-weight: bold; border-radius: 6px;" onclick="adjustItemQty(${item.id}, -1)">-</button>
          <input type="number" min="0" value="${qty}" id="item-qty-input-${item.id}" 
            style="width: 55px; text-align: center; padding: 0.3rem; border: 1px solid #ccc; border-radius: 6px; font-weight: 700;"
            onchange="setItemQty(${item.id}, this.value)">
          <button type="button" class="btn btn-secondary" style="padding: 0.2rem 0.6rem; font-weight: bold; border-radius: 6px;" onclick="adjustItemQty(${item.id}, 1)">+</button>
        </div>

        <!-- Quick Presets -->
        <div style="display: flex; gap: 0.25rem;">
          <button type="button" class="btn btn-secondary" style="padding: 0.2rem 0.4rem; font-size: 0.75rem; border-radius: 4px;" onclick="adjustItemQty(${item.id}, 10)">+10</button>
          <button type="button" class="btn btn-secondary" style="padding: 0.2rem 0.4rem; font-size: 0.75rem; border-radius: 4px;" onclick="adjustItemQty(${item.id}, 25)">+25</button>
          <button type="button" class="btn btn-secondary" style="padding: 0.2rem 0.4rem; font-size: 0.75rem; border-radius: 4px;" onclick="adjustItemQty(${item.id}, 50)">+50</button>
        </div>
      </div>
    `;

    bulkItemsContainer.appendChild(card);
  });
}

// Adjust Item Quantity
window.adjustItemQty = function(itemId, delta) {
  const current = selectedItems[itemId]?.quantity || 0;
  const next = Math.max(0, current + delta);
  setItemQty(itemId, next);
};

window.setItemQty = function(itemId, qty) {
  const parsed = Math.max(0, parseInt(qty, 10) || 0);
  const item = allMenuItems.find(i => i.id === itemId);
  if (!item) return;

  if (parsed === 0) {
    delete selectedItems[itemId];
  } else {
    selectedItems[itemId] = {
      id: item.id,
      name: item.name,
      price: parseFloat(item.price),
      quantity: parsed,
      image: item.image
    };
  }

  updateSummary();
  filterDishes();
};

function updateSummary() {
  const keys = Object.keys(selectedItems);
  let totalQty = 0;
  let estimatedTotal = 0;

  keys.forEach(k => {
    const item = selectedItems[k];
    totalQty += item.quantity;
    estimatedTotal += (item.quantity * item.price);
  });

  if (selectedItemsCount) selectedItemsCount.innerText = `${totalQty} units across ${keys.length} item(s)`;
  if (estimatedTotalDisp) estimatedTotalDisp.innerText = `₹${estimatedTotal.toFixed(2)}`;
}

// Filter dishes on search
if (bulkItemSearch) {
  bulkItemSearch.addEventListener('input', () => {
    filterDishes();
  });
}

function filterDishes() {
  const q = (bulkItemSearch ? bulkItemSearch.value : '').toLowerCase().trim();
  const filtered = allMenuItems.filter(i => i.name.toLowerCase().includes(q));
  renderBulkItems(filtered);
}

// --- SUBMIT BULK ORDER FORM ---
if (bulkOrderForm) {
  bulkOrderForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const selectedList = Object.values(selectedItems);
    if (selectedList.length === 0) {
      alert('Please select at least one menu item or specify your bulk quantities.');
      return;
    }

    const eventName          = document.getElementById('event-name').value.trim();
    const eventDate          = document.getElementById('event-date').value;
    const eventTime          = document.getElementById('event-time').value.trim();
    const headcount          = parseInt(document.getElementById('headcount').value, 10);
    const deliveryLocation   = document.getElementById('delivery-location').value.trim();
    const customRequirements = document.getElementById('custom-requirements').value.trim();
    const contactName        = document.getElementById('contact-name').value.trim();
    const contactPhone       = document.getElementById('contact-phone').value.trim();

    let estimatedTotal = 0;
    selectedList.forEach(item => {
      estimatedTotal += item.quantity * item.price;
    });

    submitBulkBtn.disabled = true;
    submitBulkBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting Request...';

    const reqHeaders = { 'Content-Type': 'application/json' };
    if (token) {
      reqHeaders['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`${API_URL}/bulk-orders/create`, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({
          event_name: eventName,
          event_date: eventDate,
          event_time: eventTime,
          headcount,
          items: selectedList,
          custom_requirements: customRequirements,
          contact_name: contactName,
          contact_phone: contactPhone,
          delivery_location: deliveryLocation,
          estimated_total: estimatedTotal
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit bulk order request.');

      // Save order ID for guest tracking
      if (!token) {
        const guestOrders = JSON.parse(localStorage.getItem('guest_bulk_orders') || '[]');
        if (!guestOrders.includes(data.id)) {
          guestOrders.unshift(data.id);
          localStorage.setItem('guest_bulk_orders', JSON.stringify(guestOrders));
        }
      }

      alert('🎉 Bulk catering order submitted successfully! The canteen admin will review and quote.');
      
      // Reset Form
      bulkOrderForm.reset();
      selectedItems = {};
      updateSummary();
      renderBulkItems(allMenuItems);

      // Switch to History Tab
      switchTab('history');
    } catch (err) {
      alert('Submission failed: ' + err.message);
    } finally {
      submitBulkBtn.disabled = false;
      submitBulkBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Bulk Order Request';
    }
  });
}

// --- FETCH & RENDER USER / GUEST BULK ORDER HISTORY ---
async function fetchMyBulkOrders() {
  try {
    let res;
    if (token) {
      res = await fetch(`${API_URL}/bulk-orders/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } else {
      const guestOrders = JSON.parse(localStorage.getItem('guest_bulk_orders') || '[]');
      if (guestOrders.length === 0) {
        myBulkOrders = [];
        if (myBulkCount) myBulkCount.innerText = 0;
        renderBulkHistory([]);
        return;
      }
      res = await fetch(`${API_URL}/bulk-orders/guest?ids=${encodeURIComponent(guestOrders.join(','))}`);
    }

    if (!res.ok) throw new Error('Failed to load your bulk orders');
    myBulkOrders = await res.json();
    if (myBulkCount) myBulkCount.innerText = myBulkOrders.length;
    renderBulkHistory(myBulkOrders);
  } catch (err) {
    if (bulkHistoryContainer) {
      bulkHistoryContainer.innerHTML = `<div style="text-align:center;color:red;">Error loading bulk orders: ${err.message}</div>`;
    }
  }
}

function renderBulkHistory(orders) {
  if (!bulkHistoryContainer) return;
  bulkHistoryContainer.innerHTML = '';

  if (orders.length === 0) {
    bulkHistoryContainer.innerHTML = `
      <div style="text-align:center;padding:3rem;color:var(--text-muted);" class="glass-panel">
        <i class="fa-solid fa-boxes-packing" style="font-size: 3rem; margin-bottom: 1rem; color: #ccc;"></i>
        <h4 style="margin-bottom: 0.5rem;">No Bulk Orders Found</h4>
        <p>You have not placed any bulk catering requests yet. Click "New Request" to plan an order for your event.</p>
      </div>`;
    return;
  }

  orders.forEach(order => {
    const statusClass = getStatusClass(order.status);
    const dateFormatted = new Date(order.event_date).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });

    const items = JSON.parse(order.items || '[]');
    const totalItemsCount = items.reduce((sum, i) => sum + (i.quantity || 0), 0);

    const priceDisplay = order.final_price
      ? `<div style="font-size:1.3rem; font-weight:800; color:var(--primary-color);">₹${order.final_price} <span style="font-size:0.75rem; color:#27ae60; font-weight:600;">(Approved Quote)</span></div>`
      : `<div style="font-size:1.2rem; font-weight:700; color:var(--text-main);">₹${order.estimated_total} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(Est.)</span></div>`;

    const card = document.createElement('div');
    card.className = `order-card glass-panel ${statusClass}`;
    card.style.cssText = 'flex-direction: column; align-items: flex-start; gap: 1rem; border-radius: var(--border-radius); padding: 1.5rem;';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; width: 100%; flex-wrap: wrap; gap: 0.8rem; align-items: flex-start;">
        <div>
          <span style="font-family: monospace; font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(order.id)}</span>
          <h3 style="margin: 0.2rem 0 0.5rem 0; font-size: 1.3rem;">${escapeHtml(order.event_name)}</h3>
          <div style="display: flex; gap: 1.2rem; flex-wrap: wrap; font-size: 0.9rem; color: var(--text-muted);">
            <span><i class="fa-solid fa-calendar-day"></i> ${dateFormatted}</span>
            <span><i class="fa-solid fa-clock"></i> ${escapeHtml(order.event_time)}</span>
            <span><i class="fa-solid fa-users"></i> ${escapeHtml(order.headcount)} Guests</span>
          </div>
        </div>
        <div style="text-align: right;">
          <span class="badge ${statusClass}" style="font-size: 0.9rem; padding: 0.4rem 0.8rem;">${escapeHtml(order.status)}</span>
          <div style="margin-top: 0.6rem;">${priceDisplay}</div>
        </div>
      </div>

      <div style="width: 100%; border-top: 1px dashed #eee; padding-top: 0.8rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.8rem;">
        <div style="font-size: 0.9rem; color: var(--text-muted);">
          <i class="fa-solid fa-location-dot" style="color: var(--primary-color);"></i> <strong>Location:</strong> ${escapeHtml(order.delivery_location)}
          <span style="margin-left: 1rem;"><i class="fa-solid fa-utensils"></i> <strong>${totalItemsCount} units</strong> (${items.length} dishes)</span>
        </div>
        <button class="btn btn-secondary" style="padding: 0.4rem 1rem; font-size: 0.85rem;" onclick="viewBulkOrderDetails('${order.id}')">
          <i class="fa-solid fa-eye"></i> View Full Details
        </button>
      </div>

      ${order.admin_notes ? `
        <div style="width: 100%; background: #fdfae6; border-left: 4px solid #f39c12; padding: 0.8rem; border-radius: 4px; font-size: 0.9rem;">
          <strong><i class="fa-solid fa-comment-dots"></i> Admin Note:</strong> ${escapeHtml(order.admin_notes)}
        </div>
      ` : ''}
    `;

    bulkHistoryContainer.appendChild(card);
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

// --- VIEW BULK ORDER DETAILS MODAL ---
window.viewBulkOrderDetails = function(orderId) {
  const order = myBulkOrders.find(o => o.id === orderId);
  if (!order) return;

  if (modalEventTitle) modalEventTitle.innerText = order.event_name;
  if (modalOrderId) modalOrderId.innerText = `ID: ${order.id} | Status: ${order.status}`;

  const items = JSON.parse(order.items || '[]');
  const itemsHtml = items.map(i => `
    <div style="display: flex; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid #f0f0f0;">
      <div><strong>${escapeHtml(i.quantity)}×</strong> ${escapeHtml(i.name)}</div>
      <div>₹${(i.quantity * i.price).toFixed(2)}</div>
    </div>
  `).join('');

  if (modalContentBody) {
    modalContentBody.innerHTML = `
      <div style="background: var(--bg-color); padding: 1rem; border-radius: 8px; font-size: 0.9rem;">
        <div><strong>📅 Date & Time:</strong> ${new Date(order.event_date).toLocaleDateString()} at ${escapeHtml(order.event_time)}</div>
        <div style="margin-top:0.3rem;"><strong>👥 Headcount:</strong> ${escapeHtml(order.headcount)} people</div>
        <div style="margin-top:0.3rem;"><strong>📍 Location:</strong> ${escapeHtml(order.delivery_location)}</div>
        <div style="margin-top:0.3rem;"><strong>👤 Coordinator:</strong> ${escapeHtml(order.contact_name)} (${escapeHtml(order.contact_phone)})</div>
      </div>

      <div>
        <h4 style="margin-bottom: 0.5rem; font-size: 1rem;"><i class="fa-solid fa-list-check"></i> Menu Breakdown</h4>
        <div style="max-height: 180px; overflow-y: auto;">
          ${itemsHtml}
        </div>
        <div style="display: flex; justify-content: space-between; font-weight: bold; margin-top: 0.8rem; padding-top: 0.5rem; border-top: 2px solid var(--text-main);">
          <span>Estimated Total:</span>
          <span>₹${parseFloat(order.estimated_total).toFixed(2)}</span>
        </div>
        ${order.final_price ? `
          <div style="display: flex; justify-content: space-between; font-weight: 800; color: var(--primary-color); margin-top: 0.4rem; font-size: 1.1rem;">
            <span>Approved Quotation:</span>
            <span>₹${parseFloat(order.final_price).toFixed(2)}</span>
          </div>
        ` : ''}
      </div>

      ${order.custom_requirements ? `
        <div>
          <h4 style="margin-bottom: 0.3rem; font-size: 0.95rem;"><i class="fa-solid fa-note-sticky"></i> Custom Requests</h4>
          <div style="background: #fafafa; border: 1px solid #eee; padding: 0.8rem; border-radius: 6px; font-size: 0.9rem; color: #444;">
            ${escapeHtml(order.custom_requirements)}
          </div>
        </div>
      ` : ''}

      ${order.admin_notes ? `
        <div style="background: #fff8e1; border: 1px solid #f39c12; padding: 0.8rem; border-radius: 6px; font-size: 0.9rem;">
          <strong style="color: #d35400;"><i class="fa-solid fa-bullhorn"></i> Note from Canteen Admin:</strong>
          <p style="margin-top: 0.3rem; margin-bottom: 0;">${escapeHtml(order.admin_notes)}</p>
        </div>
      ` : ''}
    `;
  }

  if (bulkDetailsModal) bulkDetailsModal.classList.add('active');
};

if (closeBulkModal) {
  closeBulkModal.onclick = () => bulkDetailsModal.classList.remove('active');
}
window.addEventListener('click', (e) => {
  if (e.target === bulkDetailsModal) bulkDetailsModal.classList.remove('active');
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

// --- Real-time Socket Updates ---
socket.on('bulk_order_status_update', (data) => {
  const guestOrders = JSON.parse(localStorage.getItem('guest_bulk_orders') || '[]');
  if ((user && data.userId === user.id) || guestOrders.includes(data.id)) {
    alert(`📢 Bulk Order Update: "${data.event_name}" is now marked as "${data.status}".`);
    fetchMyBulkOrders();
  }
});

// --- INIT ---
fetchMenuItems();
fetchMyBulkOrders();
