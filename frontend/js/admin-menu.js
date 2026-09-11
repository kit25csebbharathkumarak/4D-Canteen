const API_URL = `${window.location.origin}/api`;
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

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

socket.on('menu_updated', () => fetchAdminMenu());

const adminMenuList = document.getElementById('admin-menu-list');
const addItemForm = document.getElementById('add-item-form');

async function fetchAdminMenu() {
  try {
    const res = await fetch(`${API_URL}/items`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const items = await res.json();
    renderAdminMenu(items);
  } catch (err) {
    console.error(err);
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

function renderAdminMenu(items) {
  adminMenuList.innerHTML = '';
  if (items.length === 0) {
    adminMenuList.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--text-muted);">No items in menu.</p>';
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'glass-panel';
    div.style.marginBottom = '1rem';
    div.style.padding = '1rem';
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.alignItems = 'center';
    
    const safeName = escapeHtml(item.name);
    const safePrice = escapeHtml(item.price);
    const safeStock = escapeHtml(item.stock);
    const safeId = escapeHtml(item.id);

    div.innerHTML = `
      <div>
        <div style="font-weight: 700; font-size: 1.1rem;">${safeName}</div>
        <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.2rem;">
          Price: ₹${safePrice} | Stock: <strong>${safeStock}</strong> | 
          Status: <span class="badge ${item.available ? (item.stock > 0 ? 'delivered' : 'pending') : 'pending'}" style="padding: 0.1rem 0.4rem; font-size: 0.7rem;">
            ${item.available ? (item.stock > 0 ? 'Available' : 'Out of Stock') : 'Hidden'}
          </span>
        </div>
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <button class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="editItem(${safeId})">Edit</button>
        <button class="btn btn-danger" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="deleteItem(${safeId}, '${safeName}')">Delete</button>
      </div>
    `;
    adminMenuList.appendChild(div);
  });
}

window.editItem = function(id) {
  window.location.href = `edit-menu.html?id=${id}`;
};

window.deleteItem = async function(id, name) {
  if (!confirm(`Are you sure you want to delete "${name}"?`)) return;

  try {
    const res = await fetch(`${API_URL}/items/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      fetchAdminMenu();
    } else {
      alert('Error deleting item');
    }
  } catch (err) {
    console.error(err);
  }
};

addItemForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('new-item-name').value;
  const price = parseFloat(document.getElementById('new-item-price').value);
  const stock = parseInt(document.getElementById('new-item-stock').value);
  const image = document.getElementById('new-item-image').value;
  const available = document.getElementById('new-item-avail').value === '1';


  try {
    const res = await fetch(`${API_URL}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, price, image, available, stock })
    });

    if (res.ok) {
      alert('Item added successfully!');
      addItemForm.reset();
      fetchAdminMenu();
    } else {
      alert('Error adding item');
    }
  } catch (err) {
    console.error(err);
  }
});

// Real-time updates if stock changes due to orders
socket.on('menu_updated', () => {
  fetchAdminMenu();
});

// Logout logic
const nav = document.getElementById('admin-nav');
if (nav) {
  const logoutBtn = document.createElement('a');
  logoutBtn.href = '#';
  logoutBtn.innerText = `Logout`;
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

// Init
fetchAdminMenu();

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
