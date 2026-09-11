const API_URL = `${window.location.origin}/api`;

const token = localStorage.getItem('token');
const currentUser = JSON.parse(localStorage.getItem('user') || 'null');

// Access Control: Super Admin check
if (!token || !currentUser || (!currentUser.is_superadmin && currentUser.role !== 'superadmin')) {
  alert('Access restricted to SaaS Super Administrators only. Please log in with Super Admin credentials.');
  window.location.replace('login.html');
}

let allTenants = [];
let allPlans = [];

// DOM Elements
const kpiActiveTenants = document.getElementById('kpi-active-tenants');
const kpiTotalTenants = document.getElementById('kpi-total-tenants');
const kpiGmv = document.getElementById('kpi-gmv');
const kpiTotalOrders = document.getElementById('kpi-total-orders');
const kpiTodayOrders = document.getElementById('kpi-today-orders');
const kpiTodayRevenue = document.getElementById('kpi-today-revenue');

const tenantsTbody = document.getElementById('tenants-tbody');
const tenantSearch = document.getElementById('tenant-search');
const tenantPlanFilter = document.getElementById('tenant-plan-filter');
const tenantStatusFilter = document.getElementById('tenant-status-filter');
const plansGrid = document.getElementById('plans-grid');

const modalAddCanteen = document.getElementById('modal-add-canteen');
const formAddCanteen = document.getElementById('form-add-canteen');
const btnOpenAddCanteen = document.getElementById('btn-open-add-canteen');
const btnRefreshData = document.getElementById('btn-refresh-data');
const btnLogout = document.getElementById('btn-logout');

const modalQr = document.getElementById('modal-qr');
const qrModalImg = document.getElementById('qr-modal-img');
const qrModalCanteenName = document.getElementById('qr-modal-canteen-name');
const qrModalUrl = document.getElementById('qr-modal-url');
const btnDownloadQr = document.getElementById('btn-download-qr');

const superToast = document.getElementById('super-toast');
const toastMessage = document.getElementById('toast-message');

function showToast(msg, isError = false) {
  toastMessage.textContent = msg;
  superToast.style.borderColor = isError ? 'var(--danger)' : 'var(--accent)';
  superToast.classList.add('show');
  setTimeout(() => superToast.classList.remove('show'), 3500);
}

// Fetch headers
const getAuthHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`
});

// Load Platform Metrics
async function loadPlatformStats() {
  try {
    const res = await fetch(`${API_URL}/super/stats`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to load stats');
    const data = await res.json();

    kpiActiveTenants.textContent = data.activeTenants || 0;
    kpiTotalTenants.textContent = `Out of ${data.totalTenants || 0} registered`;
    kpiGmv.textContent = `₹${Number(data.totalGmv || 0).toLocaleString('en-IN')}`;
    kpiTotalOrders.textContent = Number(data.totalOrders || 0).toLocaleString('en-IN');
    kpiTodayOrders.textContent = `${data.todayOrders || 0} orders placed today`;
    kpiTodayRevenue.textContent = `₹${Number(data.todayRevenue || 0).toLocaleString('en-IN')}`;
  } catch (err) {
    console.error('Stats error:', err);
  }
}

// Load Tenants
async function loadTenants() {
  try {
    const res = await fetch(`${API_URL}/super/tenants`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Failed to load tenants');
    allTenants = await res.json();
    renderTenantsTable();
  } catch (err) {
    console.error('Tenants load error:', err);
    tenantsTbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 30px;">Failed to load canteens: ${err.message}</td></tr>`;
  }
}

// Load Plans
async function loadPlans() {
  try {
    const res = await fetch(`${API_URL}/super/plans`, { headers: getAuthHeaders() });
    if (!res.ok) return;
    allPlans = await res.json();
    renderPlansGrid();
  } catch (err) {
    console.error('Plans error:', err);
  }
}

function renderPlansGrid() {
  if (!plansGrid || allPlans.length === 0) return;
  plansGrid.innerHTML = allPlans.map(plan => {
    let featuresList = [];
    try {
      featuresList = Array.isArray(plan.features) ? plan.features : JSON.parse(plan.features || '[]');
    } catch (_) {}

    return `
      <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-card); border-radius: 12px; padding: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h4 style="font-size: 16px; font-weight: 700; color: #fff;">${plan.name}</h4>
          <span class="badge-plan">${plan.id}</span>
        </div>
        <div style="font-size: 26px; font-weight: 800; color: #38bdf8; margin-bottom: 12px;">
          ₹${Number(plan.price_monthly).toLocaleString('en-IN')}<span style="font-size: 13px; font-weight: 400; color: var(--text-muted);"> / month</span>
        </div>
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
          Items: Up to ${plan.max_items || 'Unlimited'} | Orders: ${plan.max_monthly_orders || 'Unlimited'}/mo
        </p>
        <ul style="list-style: none; font-size: 13px; color: #cbd5e1; display: flex; flex-direction: column; gap: 6px;">
          ${featuresList.map(f => `<li><i class="fa-solid fa-check" style="color: var(--accent); margin-right: 6px;"></i>${f}</li>`).join('')}
        </ul>
      </div>
    `;
  }).join('');
}

function renderTenantsTable() {
  const searchQ = (tenantSearch.value || '').trim().toLowerCase();
  const planF = tenantPlanFilter.value;
  const statusF = tenantStatusFilter.value;

  const filtered = allTenants.filter(t => {
    const matchSearch = !searchQ ||
      t.name.toLowerCase().includes(searchQ) ||
      t.slug.toLowerCase().includes(searchQ) ||
      (t.address && t.address.toLowerCase().includes(searchQ));
    const matchPlan = planF === 'all' || t.plan_tier === planF;
    const matchStatus = statusF === 'all' || t.status === statusF;
    return matchSearch && matchPlan && matchStatus;
  });

  if (filtered.length === 0) {
    tenantsTbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 40px;">No canteens match current filters.</td></tr>`;
    return;
  }

  tenantsTbody.innerHTML = filtered.map(t => {
    const statusClass = t.status === 'active' ? 'badge-active' : 'badge-suspended';
    const isOpen = Boolean(t.is_shop_open);
    const orderCount = Number(t.total_orders || 0).toLocaleString('en-IN');
    const revenue = Number(t.total_revenue || 0).toLocaleString('en-IN');
    const logoSrc = t.logo_url || 'logo.png';

    return `
      <tr>
        <td>
          <div class="tenant-info-cell">
            <img src="${logoSrc}" alt="${t.name}" class="tenant-avatar" onerror="this.src='logo.png'">
            <div class="tenant-name-text">
              <strong>${t.name}</strong>
              <span>Slug: <code>${t.slug}</code> | Menu: ${t.menu_count || 0} items</span>
            </div>
          </div>
        </td>
        <td>
          <span style="font-size: 13px;">${t.address || 'Campus Canteen'}</span>
          <br><small style="color: var(--text-muted);">${t.contact_phone || ''}</small>
        </td>
        <td>
          <span class="badge-plan">${t.plan_tier || 'growth'}</span>
        </td>
        <td>
          <strong style="color: #fff;">${orderCount} orders</strong>
          <br><span style="color: var(--accent); font-size: 12px; font-weight: 600;">₹${revenue}</span>
        </td>
        <td>
          <button class="btn-action" onclick="toggleShopOpen(${t.id}, ${!isOpen})" title="Click to toggle shop open state" style="font-weight: 600; color: ${isOpen ? 'var(--accent)' : 'var(--warning)'};">
            <i class="fa-solid ${isOpen ? 'fa-door-open' : 'fa-door-closed'}"></i> ${isOpen ? 'Open' : 'Closed'}
          </button>
        </td>
        <td>
          <span class="badge-pill ${statusClass}">
            <i class="fa-solid ${t.status === 'active' ? 'fa-check' : 'fa-ban'}"></i> ${t.status}
          </span>
        </td>
        <td>
          <div class="action-btn-group">
            <a href="menu.html?canteen=${encodeURIComponent(t.slug)}" target="_blank" class="btn-action" title="Open Customer Menu">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> Storefront
            </a>
            <button class="btn-action btn-qr" onclick="showTenantQr('${t.slug}', '${encodeURIComponent(t.name)}')" title="View QR Code">
              <i class="fa-solid fa-qrcode"></i> QR
            </button>
            <button class="btn-action ${t.status === 'active' ? 'btn-toggle-suspend' : ''}" onclick="toggleTenantStatus(${t.id}, '${t.status === 'active' ? 'suspended' : 'active'}')" title="${t.status === 'active' ? 'Suspend Canteen' : 'Activate Canteen'}">
              <i class="fa-solid ${t.status === 'active' ? 'fa-pause' : 'fa-play'}"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Toggle Canteen Open/Close
window.toggleShopOpen = async function(tenantId, newOpenState) {
  try {
    const res = await fetch(`${API_URL}/super/tenants/${tenantId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ is_shop_open: newOpenState })
    });
    if (!res.ok) throw new Error('Failed to update shop status');
    showToast(`Kitchen status updated to ${newOpenState ? 'OPEN' : 'CLOSED'}`);
    loadTenants();
  } catch (err) {
    showToast(err.message, true);
  }
};

// Toggle Canteen Account Status (Active / Suspended)
window.toggleTenantStatus = async function(tenantId, targetStatus) {
  const confirmMsg = targetStatus === 'suspended'
    ? 'Are you sure you want to suspend this canteen? Customers will not be able to order.'
    : 'Activate this canteen now?';

  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`${API_URL}/super/tenants/${tenantId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status: targetStatus })
    });
    if (!res.ok) throw new Error('Failed to update tenant status');
    showToast(`Canteen is now ${targetStatus.toUpperCase()}`);
    loadTenants();
    loadPlatformStats();
  } catch (err) {
    showToast(err.message, true);
  }
};

// Show Canteen QR Code Modal
window.showTenantQr = async function(slug, encodedName) {
  const canteenName = decodeURIComponent(encodedName);
  qrModalCanteenName.textContent = canteenName;

  try {
    const res = await fetch(`${API_URL}/tenants/${slug}/qr`);
    if (!res.ok) throw new Error('Failed to generate QR code');
    const data = await res.json();

    qrModalImg.src = data.qr_code;
    qrModalUrl.textContent = data.order_url;
    btnDownloadQr.href = data.qr_code;
    btnDownloadQr.download = `${slug}-canteen-qr.png`;

    modalQr.classList.add('open');
  } catch (err) {
    showToast('Failed to load QR code: ' + err.message, true);
  }
};

// Modal Open / Close Bindings
btnOpenAddCanteen.addEventListener('click', () => {
  formAddCanteen.reset();
  modalAddCanteen.classList.add('open');
});

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-close');
    const target = document.getElementById(targetId);
    if (target) target.classList.remove('open');
  });
});

// Auto Slugify canteen name
document.getElementById('new-canteen-name').addEventListener('input', (e) => {
  const slugInput = document.getElementById('new-canteen-slug');
  if (!slugInput.dataset.manual) {
    slugInput.value = e.target.value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
});

document.getElementById('new-canteen-slug').addEventListener('input', () => {
  document.getElementById('new-canteen-slug').dataset.manual = 'true';
});

// Submit Onboard New Canteen Form
formAddCanteen.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-canteen-name').value.trim();
  const slug = document.getElementById('new-canteen-slug').value.trim();
  const plan_tier = document.getElementById('new-canteen-plan').value;
  const tagline = document.getElementById('new-canteen-tagline').value.trim();
  const address = document.getElementById('new-canteen-address').value.trim();
  const contact_email = document.getElementById('new-canteen-email').value.trim();
  const contact_phone = document.getElementById('new-canteen-phone').value.trim();
  const upi_id = document.getElementById('new-canteen-upi').value.trim();

  const submitBtn = document.getElementById('btn-submit-canteen');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Provisioning...';

  try {
    const res = await fetch(`${API_URL}/super/tenants`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        name, slug, plan_tier, tagline, address,
        contact_email, contact_phone, upi_id
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create canteen');

    showToast(`Canteen "${name}" provisioned successfully!`);
    modalAddCanteen.classList.remove('open');
    formAddCanteen.reset();
    loadTenants();
    loadPlatformStats();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Create & Provision Canteen';
  }
});

// Search & Filter event listeners
tenantSearch.addEventListener('input', renderTenantsTable);
tenantPlanFilter.addEventListener('change', renderTenantsTable);
tenantStatusFilter.addEventListener('change', renderTenantsTable);

btnRefreshData.addEventListener('click', () => {
  loadPlatformStats();
  loadTenants();
  showToast('Platform metrics refreshed');
});

btnLogout.addEventListener('click', () => {
  if (confirm('Log out from Super Admin Console?')) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.replace('login.html');
  }
});

// Initial Data Load
loadPlatformStats();
loadTenants();
loadPlans();
