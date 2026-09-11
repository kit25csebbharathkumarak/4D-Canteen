const API_URL = `${window.location.origin}/api`;

const grid = document.getElementById('canteen-cards-grid');
const searchInput = document.getElementById('directory-search');

let canteens = [];

async function fetchCanteens() {
  try {
    const res = await fetch(`${API_URL}/tenants`);
    if (!res.ok) throw new Error('Failed to load canteens');
    canteens = await res.json();
    renderCanteens();
  } catch (err) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #ef4444;">
        <i class="fa-solid fa-triangle-exclamation fa-2x"></i>
        <p style="margin-top: 10px;">Failed to load canteens: ${err.message}</p>
      </div>
    `;
  }
}

function renderCanteens() {
  const query = (searchInput.value || '').trim().toLowerCase();

  const filtered = canteens.filter(c => {
    return !query ||
      c.name.toLowerCase().includes(query) ||
      (c.tagline && c.tagline.toLowerCase().includes(query)) ||
      (c.address && c.address.toLowerCase().includes(query));
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px; color: #64748b;">
        <i class="fa-solid fa-store-slash fa-2x"></i>
        <p style="margin-top: 12px;">No canteens found matching "${query}".</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(c => {
    const isOpen = Boolean(c.is_shop_open);
    const banner = c.banner_url || 'biryani.jpg';
    const logo = c.logo_url || 'logo.png';

    return `
      <div class="canteen-card">
        <div class="canteen-card-banner" style="background-image: url('${banner}');">
          <span class="canteen-status-badge ${isOpen ? 'status-open' : 'status-closed'}">
            <i class="fa-solid ${isOpen ? 'fa-door-open' : 'fa-door-closed'}"></i> ${isOpen ? 'Open Now' : 'Closed'}
          </span>
        </div>
        <div class="canteen-card-body">
          <img src="${logo}" alt="${c.name}" class="canteen-logo-wrap" onerror="this.src='logo.png'">
          <h3 class="canteen-card-title">${c.name}</h3>
          <p class="canteen-card-tagline">${c.tagline || 'Campus Dining & Fresh Meals'}</p>

          <div class="canteen-card-meta">
            <div>
              <i class="fa-solid fa-location-dot" style="color: #ea580c; width: 16px;"></i>
              <span>${c.address || 'Campus Canteen'}</span>
            </div>
            ${c.contact_phone ? `
              <div>
                <i class="fa-solid fa-phone" style="color: #10b981; width: 16px;"></i>
                <span>${c.contact_phone}</span>
              </div>
            ` : ''}
          </div>

          <a href="menu.html?canteen=${encodeURIComponent(c.slug)}" class="btn-order-canteen">
            <i class="fa-solid fa-utensils"></i> View Menu &amp; Order Online
          </a>
        </div>
      </div>
    `;
  }).join('');
}

searchInput.addEventListener('input', renderCanteens);

fetchCanteens();
