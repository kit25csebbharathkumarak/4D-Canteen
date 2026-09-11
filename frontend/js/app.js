const API_URL = `${window.location.origin}/api`;

const token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
const user = currentUser;

if (!token || !currentUser) {
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

// Keep profile synchronized with backend (phone and verification status)
async function refreshUserProfile() {
  if (!token) return;
  try {
    const res = await fetch(`${API_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        currentUser = data.user;
        localStorage.setItem('user', JSON.stringify(currentUser));
      }
    }
  } catch (err) {
    console.warn('Failed to refresh user profile:', err);
  }
}
refreshUserProfile();

// Multi-Tenant Canteen Context
const urlParams = new URLSearchParams(window.location.search);
let activeCanteenSlug = urlParams.get('canteen') || localStorage.getItem('selected_canteen') || 'kit-coimbatore';
localStorage.setItem('selected_canteen', activeCanteenSlug);
let currentCanteen = null;

async function loadCanteenBranding() {
  try {
    const res = await fetch(`${API_URL}/tenants/${encodeURIComponent(activeCanteenSlug)}`);
    if (res.ok) {
      currentCanteen = await res.json();
      document.title = `${currentCanteen.name} - Online Menu & Ordering`;
      const logoEl = document.getElementById('canteen-header-logo');
      const nameEl = document.getElementById('canteen-header-name');
      if (logoEl) logoEl.src = currentCanteen.logo_url || 'logo.png';
      if (nameEl) nameEl.textContent = currentCanteen.name;

      if (currentCanteen.is_shop_open !== undefined) {
        shopOpen = Boolean(currentCanteen.is_shop_open);
        updateShopUI();
      }

      if (typeof socket !== 'undefined' && socket && currentCanteen.id) {
        socket.emit('subscribe_canteen', currentCanteen.id);
      }
    }
  } catch (err) {
    console.warn('Failed to load canteen branding:', err);
  }
}
loadCanteenBranding();

let cart       = {};
let menuItems  = [];
let searchQuery = '';
let currentFilter = 'all';
let currentSort = 'default';
let shopOpen = true;

// Current order context (used by Razorpay integration)
let currentOrderId  = null;

const socket = io({
  auth: { token }
});

// --- DOM Elements ---
const menuGrid          = document.getElementById('menu-grid');
const cartItemsContainer= document.getElementById('cart-items');
const cartTotalElement  = document.getElementById('cart-total');
const checkoutBtn       = document.getElementById('checkout-btn');
const menuSearchInput   = document.getElementById('menu-search');



// --- Fetch & Render Menu ---

// --- SOUND & TOAST NOTIFICATION HELPERS ---
function playNotificationSound(type = 'chime') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    if (type === 'food_ready') {
      // Pleasant double-bell alert chime
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'triangle';
      osc2.type = 'sine';

      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

      osc2.frequency.setValueAtTime(880, now + 0.2); // A5
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.45); // D6

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.2);
      osc2.start(now + 0.2);
      osc2.stop(now + 0.8);
    } else {
      // Gentle shop-open welcome chime
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.12); // E5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.25); // G5

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.6);
    }
  } catch (e) {
    console.debug('Audio notification not supported or blocked by browser policy:', e);
  }
}

function showToast({ title, message, type = 'shop-open', icon = 'fa-store', duration = 6000 }) {
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

  // Native notification if permitted
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body: message, icon: 'logo.png' });
  }

  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

function showFoodReadyPopup(orderId, message) {
  const existing = document.getElementById('food-ready-popup');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'food-ready-popup';
  overlay.className = 'food-ready-popup-overlay';
  overlay.innerHTML = `
    <div class="food-ready-popup-card">
      <div style="font-size: 3.5rem; color: #f39c12; margin-bottom: 0.8rem;">
        <i class="fa-solid fa-bell-concierge fa-shake"></i>
      </div>
      <h2 style="font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--text-main);">Your Food is Ready!</h2>
      <p style="font-size: 1.05rem; color: var(--text-muted); margin-bottom: 1.2rem;">
        ${message || `Order #${orderId} is packed and ready for collection at the counter.`}
      </p>
      <div style="font-family: monospace; font-size: 1.15rem; font-weight: 700; background: #fdf5e6; padding: 0.6rem 1rem; border-radius: 8px; display: inline-block; margin-bottom: 1.5rem; border: 1px dashed #f39c12; color: #d35400;">
        Order ID: ${orderId}
      </div>
      <div style="display: flex; gap: 0.8rem; justify-content: center; flex-wrap: wrap;">
        <a href="orders.html" class="btn btn-primary" style="padding: 0.8rem 1.6rem; font-size: 1rem; text-decoration: none; display: inline-flex; align-items: center; gap: 0.5rem; background: #e67e22; border-color: #e67e22;">
          <i class="fa-solid fa-qrcode"></i> View Pickup QR
        </a>
        <button id="close-food-popup" class="btn btn-secondary" style="padding: 0.8rem 1.4rem; font-size: 1rem;">
          Dismiss
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('close-food-popup').onclick = () => overlay.remove();
}

// Request notification permission opportunistically on customer interaction
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => {
    Notification.requestPermission().catch(() => {});
  }, { once: true });
}

// Fetch Shop Status
let isInitialShopCheck = true;
fetch(`${API_URL}/shop-status`)
  .then(res => res.json())
  .then(data => {
    shopOpen = data.isOpen;
    updateShopUI();
    isInitialShopCheck = false;
  })
  .catch(err => console.error('Error fetching shop status:', err));

socket.on('shop_status_changed', (isOpen) => {
  const previousState = shopOpen;
  shopOpen = isOpen;
  updateShopUI();

  if (!isInitialShopCheck && !previousState && isOpen) {
    // Transitioned from closed to open: notify customer
    playNotificationSound('shop_open');
    showToast({
      title: '🎉 Canteen is Now Open!',
      message: 'The kitchen is active and taking orders. Browse today\'s menu and order now!',
      type: 'shop-open',
      icon: 'fa-store',
      duration: 8000
    });
  } else if (!isInitialShopCheck && previousState && !isOpen) {
    showToast({
      title: 'Shop Closed',
      message: 'The canteen has closed for new orders.',
      type: 'shop-open',
      icon: 'fa-store-slash',
      duration: 5000
    });
  }
});

socket.on('food_ready', (data) => {
  if (user && data.userId === user.id) {
    playNotificationSound('food_ready');
    showToast({
      title: '🍽️ Food Ready for Pickup!',
      message: data.message || `Order #${data.orderId} is ready to collect at the counter.`,
      type: 'food-ready',
      icon: 'fa-bell-concierge',
      duration: 12000
    });
    showFoodReadyPopup(data.orderId, data.message);
  }
});

function updateShopUI() {
  const banner = document.getElementById('shop-closed-banner');
  if (banner) {
    banner.style.display = shopOpen ? 'none' : 'block';
  }
  if (checkoutBtn) {
    checkoutBtn.disabled = !shopOpen;
    if (!shopOpen) {
      checkoutBtn.style.opacity = '0.5';
      checkoutBtn.style.cursor = 'not-allowed';
    } else {
      checkoutBtn.style.opacity = '1';
      checkoutBtn.style.cursor = 'pointer';
    }
  }
  renderMenu();
}

async function fetchMenu() {
  try {
    const res = await fetch(`${API_URL}/items?canteen=${encodeURIComponent(activeCanteenSlug)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    menuItems = await res.json();
    renderMenu();
    renderCart();
  } catch (err) {
    console.error('Failed to fetch menu', err);
  }
}

const escapeHtml = (str) => {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
};

function renderMenu(items) {
  if (items) menuItems = items;
  
  const filtered = menuItems.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = currentFilter === 'all' || 
                          (currentFilter === 'available' && item.available && item.stock > 0);
    return matchesSearch && matchesFilter;
  });

  // 3. Sort by Price
  if (currentSort === 'price-asc') {
    filtered.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  } else if (currentSort === 'price-desc') {
    filtered.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  }

  if (filtered.length === 0) {
    menuGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">No items found matching the criteria</div>`;
    return;
  }

  const currentIds = Array.from(menuGrid.children).map(c => c.getAttribute('data-item-id'));
  const newIds = filtered.filter(i => i.available).map(i => i.id.toString());
  const orderChanged = currentIds.join(',') !== newIds.join(',');

  if (orderChanged) {
    menuGrid.innerHTML = '';
    filtered.forEach(item => {
      if (!item.available) return;
      const div = document.createElement('div');
      div.className = 'menu-item glass-panel';
      div.setAttribute('data-item-id', item.id);
      
      const safeName = escapeHtml(item.name);
      const safePrice = escapeHtml(item.price);
      const safeStock = escapeHtml(item.stock);
      const safeImg = encodeURI(item.image || '');
      const cartItem = cart[item.id];
      const inCartQty = cartItem ? cartItem.quantity : 0;

      let actionHtml = '';
      if (inCartQty > 0) {
        actionHtml = `
          <div class="item-stepper">
            <button type="button" class="stepper-btn stepper-btn-minus" data-id="${escapeHtml(item.id)}">-</button>
            <span class="stepper-count">${inCartQty}</span>
            <button type="button" class="stepper-btn stepper-btn-plus" data-id="${escapeHtml(item.id)}">+</button>
          </div>`;
      } else {
        actionHtml = `
          <button type="button" class="btn btn-primary btn-add" data-id="${escapeHtml(item.id)}"
            ${item.stock <= 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
            <i class="fa-solid fa-plus"></i> ${item.stock > 0 ? 'Add' : 'Sold Out'}
          </button>`;
      }

      div.innerHTML = `
        <div class="item-img-wrap">
          <img src="${safeImg}" alt="${safeName}" loading="lazy" onerror="this.src='parotta.png';">
        </div>
        <div class="item-info">
          <h3>${safeName}</h3>
          <div class="item-price">₹${safePrice}</div>
          <div class="item-stock" style="color:${item.stock > 0 ? 'var(--text-muted)' : '#ff5252'};">
            ${item.stock > 0 ? `In Stock: ${safeStock}` : 'Out of Stock'}
          </div>
        </div>
        ${actionHtml}
      `;
      menuGrid.appendChild(div);
    });
  } else {
    // In-place update for existing items
    filtered.forEach(item => {
      if (!item.available) return;
      const div = menuGrid.querySelector(`.menu-item[data-item-id="${item.id}"]`);
      if (div) {
        const stockDiv = div.querySelector('.item-stock');
        if (stockDiv) {
          stockDiv.style.color = item.stock > 0 ? 'var(--text-muted)' : '#ff5252';
          stockDiv.innerText = item.stock > 0 ? `In Stock: ${item.stock}` : 'Out of Stock';
        }
        
        const cartItem = cart[item.id];
        const inCartQty = cartItem ? cartItem.quantity : 0;
        const existingStepper = div.querySelector('.item-stepper');
        const existingBtn = div.querySelector('.btn-add');

        if (inCartQty > 0) {
          if (existingStepper) {
            existingStepper.querySelector('.stepper-count').innerText = inCartQty;
          } else if (existingBtn) {
            existingBtn.outerHTML = `
              <div class="item-stepper">
                <button type="button" class="stepper-btn stepper-btn-minus" data-id="${escapeHtml(item.id)}">-</button>
                <span class="stepper-count">${inCartQty}</span>
                <button type="button" class="stepper-btn stepper-btn-plus" data-id="${escapeHtml(item.id)}">+</button>
              </div>`;
          }
        } else {
          if (existingStepper) {
            existingStepper.outerHTML = `
              <button type="button" class="btn btn-primary btn-add" data-id="${escapeHtml(item.id)}"
                ${item.stock <= 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
                <i class="fa-solid fa-plus"></i> ${item.stock > 0 ? 'Add' : 'Sold Out'}
              </button>`;
          } else if (existingBtn) {
            if (item.stock <= 0) {
              existingBtn.setAttribute('disabled', 'true');
              existingBtn.style.opacity = '0.5';
              existingBtn.style.cursor = 'not-allowed';
              existingBtn.innerHTML = 'Sold Out';
            } else {
              existingBtn.removeAttribute('disabled');
              existingBtn.style.opacity = '1';
              existingBtn.style.cursor = 'pointer';
              existingBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add';
            }
          }
        }
      }
    });
  }
}

// --- Cart State Management (Session in-memory only, not saved to localStorage) ---
function loadCartFromStorage() {
  cart = {};
  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('canteen_cart')) {
        localStorage.removeItem(key);
      }
    });
  } catch (_) {}
}

function saveCartToStorage() {
  // In-memory cart only per user preference - do not persist cart to localStorage
  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('canteen_cart')) {
        localStorage.removeItem(key);
      }
    });
  } catch (_) {}
}

// --- Cart Logic ---
function addToCart(id) {
  const cleanId = parseInt(id, 10);
  const item = menuItems.find(i => i.id == cleanId || i.id == id);
  if (!item) return;

  if (!item.available || item.stock <= 0) {
    alert(`${item.name} is currently out of stock.`);
    return;
  }

  const currentQty = cart[item.id] ? cart[item.id].quantity : (cart[id] ? cart[id].quantity : 0);
  if (currentQty + 1 > item.stock) {
    alert(`Cannot add more. Only ${item.stock} available in stock.`);
    return;
  }

  cart[item.id] = {
    id: item.id,
    name: item.name,
    price: Number(item.price),
    image: item.image,
    quantity: currentQty + 1
  };

  saveCartToStorage();
  renderCart();

  if (socket && socket.connected) {
    socket.emit('update_cart', { itemId: item.id, change: 1 });
  }
}
window.addToCart = addToCart;

function updateQuantity(id, change) {
  const cleanId = parseInt(id, 10);
  const item = menuItems.find(i => i.id == cleanId || i.id == id) || cart[id];
  if (!item) return;

  const currentQty = cart[item.id] ? cart[item.id].quantity : (cart[id] ? cart[id].quantity : 0);
  const targetQty = currentQty + change;

  if (change > 0 && targetQty > (item.stock || 999)) {
    alert(`Cannot add more. Only ${item.stock} available in stock.`);
    return;
  }

  if (targetQty <= 0) {
    delete cart[item.id];
    if (cart[id]) delete cart[id];
  } else {
    cart[item.id] = {
      id: item.id,
      name: item.name,
      price: Number(item.price),
      image: item.image,
      quantity: targetQty
    };
  }

  saveCartToStorage();
  renderCart();

  if (socket && socket.connected) {
    socket.emit('update_cart', { itemId: item.id, change: change });
  }
}
window.updateQuantity = updateQuantity;

function renderCart() {
  cartItemsContainer.innerHTML = '';
  let total = 0;
  const keys = Object.keys(cart);

  if (keys.length === 0) {
    cartItemsContainer.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:2rem;">Cart is empty</p>';
    checkoutBtn.disabled = true;
    cartTotalElement.innerText = '₹0';
    updateCartCount();
    return;
  }

  keys.forEach(id => {
    const item = cart[id];
    total += item.price * item.quantity;
    const div = document.createElement('div');
    div.className = 'cart-item';
    const safeName = escapeHtml(item.name);
    const safePrice = escapeHtml(item.price);
    const safeQty = escapeHtml(item.quantity);
    const safeId = escapeHtml(id);

    div.innerHTML = `
      <div>
        <div style="font-weight:500;">${safeName}</div>
        <div style="font-size:0.9rem;color:var(--text-muted)">₹${safePrice} × ${safeQty}</div>
      </div>
      <div class="cart-item-controls">
        <button type="button" class="cart-qty-btn cart-qty-minus" data-id="${safeId}">-</button>
        <span>${safeQty}</span>
        <button type="button" class="cart-qty-btn cart-qty-plus" data-id="${safeId}">+</button>
      </div>
    `;
    cartItemsContainer.appendChild(div);
  });

  cartTotalElement.innerText = `₹${total}`;
  checkoutBtn.disabled = !shopOpen;
  checkoutBtn.onclick  = () => processCheckout(total);
  updateCartCount();
}

// --- Google reCAPTCHA for Checkout (Invisible mode) ---
window.checkoutRecaptchaWidgetId = null;
window.checkoutRecaptchaSiteKey = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
let checkoutRecaptchaResolve = null;

window._initCheckoutRecaptchaWidget = function () {
  const container = document.getElementById('checkout-recaptcha');
  if (!container || window.checkoutRecaptchaWidgetId !== null) return;
  if (typeof grecaptcha === 'undefined' || typeof grecaptcha.render !== 'function') return;

  try {
    window.checkoutRecaptchaWidgetId = grecaptcha.render('checkout-recaptcha', {
      sitekey: window.checkoutRecaptchaSiteKey,
      size: 'invisible',
      badge: 'bottomright',
      callback: function (recaptchaToken) {
        if (typeof checkoutRecaptchaResolve === 'function') {
          const fn = checkoutRecaptchaResolve;
          checkoutRecaptchaResolve = null;
          fn(recaptchaToken);
        }
      },
      'error-callback': function () {
        if (typeof checkoutRecaptchaResolve === 'function') {
          const fn = checkoutRecaptchaResolve;
          checkoutRecaptchaResolve = null;
          fn('');
        }
      }
    });
  } catch (err) {
    console.warn('[Checkout reCAPTCHA] render error:', err);
  }
};

async function initCheckoutRecaptcha() {
  const container = document.getElementById('checkout-recaptcha');
  if (!container) return;

  try {
    const res = await fetch(`${API_URL}/auth/recaptcha-config`);
    if (res.ok) {
      const data = await res.json();
      if (data.siteKey) {
        window.checkoutRecaptchaSiteKey = data.siteKey;
      }
    }
  } catch (err) {
    console.warn('[Checkout reCAPTCHA] Failed to load config:', err);
  }

  if (typeof grecaptcha !== 'undefined' && typeof grecaptcha.render === 'function') {
    window._initCheckoutRecaptchaWidget();
  } else if (window._recaptchaApiLoaded) {
    window._initCheckoutRecaptchaWidget();
  }
}

function getCheckoutRecaptchaToken() {
  const container = document.getElementById('checkout-recaptcha');
  if (!container) return Promise.resolve('');

  if (window.checkoutRecaptchaWidgetId === null && typeof grecaptcha !== 'undefined' && typeof grecaptcha.render === 'function') {
    window._initCheckoutRecaptchaWidget();
  }

  if (typeof grecaptcha === 'undefined' || window.checkoutRecaptchaWidgetId === null || window.checkoutRecaptchaWidgetId === undefined) {
    return Promise.resolve('');
  }

  return new Promise((resolve) => {
    let timer = setTimeout(() => {
      if (checkoutRecaptchaResolve) {
        checkoutRecaptchaResolve = null;
        resolve('');
      }
    }, 10000);

    checkoutRecaptchaResolve = (token) => {
      clearTimeout(timer);
      resolve(token || '');
    };

    try {
      const existing = grecaptcha.getResponse(window.checkoutRecaptchaWidgetId);
      if (existing) {
        grecaptcha.reset(window.checkoutRecaptchaWidgetId);
      }
      grecaptcha.execute(window.checkoutRecaptchaWidgetId);
    } catch (e) {
      console.warn('[Checkout reCAPTCHA] execute error:', e);
      clearTimeout(timer);
      checkoutRecaptchaResolve = null;
      resolve('');
    }
  });
}

function resetCheckoutRecaptcha() {
  if (typeof grecaptcha !== 'undefined' && window.checkoutRecaptchaWidgetId !== null && window.checkoutRecaptchaWidgetId !== undefined) {
    try {
      grecaptcha.reset(window.checkoutRecaptchaWidgetId);
    } catch (e) {}
  }
}

// --- Checkout -  Zoho Payments ---
async function processCheckout(total) {
  // Enforce mobile phone verification before placing order
  if (!currentUser || !currentUser.phone || !currentUser.phone_verified) {
    openPhoneVerifyModal(total);
    return;
  }

  checkoutBtn.disabled = true;
  checkoutBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Securing Order...';

  // Obtain Invisible reCAPTCHA verification token in the background
  let recaptchaToken = '';
  try {
    recaptchaToken = await getCheckoutRecaptchaToken();
  } catch (err) {
    console.warn('[Checkout reCAPTCHA] Verification error:', err);
  }

  checkoutBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating Order...';

  try {
    const itemsList = Object.values(cart);
    const res = await fetch(`${API_URL}/orders/create`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ items: itemsList, total, tenant_id: currentCanteen?.id || 1, socketId: socket.id, recaptchaToken })
    });

    const data = await res.json();

    if (!res.ok) {
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
      resetCheckoutRecaptcha();
      if (res.status === 403 && data.requires_phone_verification) {
        openPhoneVerifyModal(total);
        return;
      }
      alert(data.error || 'Failed to initiate order. Please try again.');
      return;
    }

    // Cart is preserved here in case they cancel/go back. 
    // It will be cleared upon successful payment.

    if (data.payment_url) {
      window.location.href = data.payment_url;
      return;
    }

    if (data.paymentSessionId) {
      let configData = null;
      try {
        const configRes = await fetch(`${API_URL}/zoho-config`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (configRes.ok) {
          configData = await configRes.json();
        }
      } catch (e) {
        console.error('Failed to load Zoho config:', e);
      }

      if (typeof ZPayments !== 'undefined' && configData && configData.account_id) {
        let config = {
          "account_id": configData.account_id,
          "domain": "IN",
          "otherOptions": {
            "api_key": configData.api_key
          }
        };

        const zp = new ZPayments(config);
        
        // Wait for webhook or server to confirm via socket
        socket.once('payment_confirmed', (msg) => {
           if (msg.orderId === data.orderId) {
               window.location.href = `orders.html?payment=success&orderId=${data.orderId}`;
           }
        });

        let options = {
          "amount": total.toString(),
          "currency_code": "INR",
          "payments_session_id": data.paymentSessionId,
          "description": "Order " + data.orderId
        };

        let widgetPromise;
        if (typeof zp.open === 'function') {
           widgetPromise = zp.open(options);
        } else if (typeof zp.requestPaymentMethod === 'function') {
           widgetPromise = zp.requestPaymentMethod(options);
        } else if (typeof zp.checkout === 'function') {
           widgetPromise = zp.checkout(options);
        } else {
           alert('Checkout Error: Unable to find payment method on Zoho widget.');
           checkoutBtn.disabled = false;
           checkoutBtn.innerText = 'Proceed to Pay';
           resetCheckoutRecaptcha();
           return;
        }

        try {
          let response = await widgetPromise;
          if (response) {
            checkoutBtn.disabled = true;
            checkoutBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying with Kitchen...';

            const paymentId = response.payment_id || response.id || null;
            const paymentSessionId = response.payments_session_id || response.payment_session_id || data.paymentSessionId;
            const signature = response.signature || null;

            const verificationPayload = {
              orderId: data.orderId,
              paymentSessionId: paymentSessionId,
              paymentId: paymentId,
              signature: signature,
              widgetResponse: response
            };

            try {
              sessionStorage.setItem(`canteen_verify_${data.orderId}`, JSON.stringify(verificationPayload));
              sessionStorage.setItem('canteen_last_paid_order_id', data.orderId);
            } catch (_) {}

            localStorage.removeItem('canteen_cart');
            cart = {};
            if (typeof renderCart === 'function') {
              renderCart();
            }

            let verifyJson = null;
            try {
              const verifyRes = await fetch(`${API_URL}/orders/verify-zoho-payment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(verificationPayload)
              });
              verifyJson = await verifyRes.json();
              console.log('[Zoho Checkout] Instant verification result:', verifyJson);
            } catch (e) { 
              console.error('Server-side verify error:', e); 
            }

            if (verifyJson && (verifyJson.isPaid === true || (verifyJson.success === true && verifyJson.status !== 'Pending Payment'))) {
              window.location.href =
                `orders.html?payment=success&orderId=${encodeURIComponent(data.orderId)}`;
            } else {
              window.location.href =
                `orders.html?payment=pending&orderId=${encodeURIComponent(data.orderId)}`;
            }
            return;
          }
        } catch (widgetErr) {
          resetCheckoutRecaptcha();
          if (widgetErr && widgetErr.code !== 'widget_closed') {
            console.error("Widget Error:", widgetErr);
            alert("Payment error: " + (widgetErr.message || JSON.stringify(widgetErr)));
            checkoutBtn.disabled = false;
            checkoutBtn.innerText = 'Proceed to Pay';
          } else {
            window.location.reload();
          }
          return;
        }
      } else {
        alert('Online payment service is currently unavailable. Please contact canteen staff or try again later.');
        checkoutBtn.disabled = false;
        checkoutBtn.innerText = 'Proceed to Pay';
        resetCheckoutRecaptcha();
        return;
      }
      
      checkoutBtn.disabled  = false;
      checkoutBtn.innerText = 'Proceed to Pay';
      resetCheckoutRecaptcha();
    } else {
      window.location.href = `orders.html?orderId=${data.orderId}`;
    }

  } catch (err) {
    console.error(err);
    alert('Checkout Error: ' + (err.message || JSON.stringify(err)));
    checkoutBtn.disabled  = false;
    checkoutBtn.innerText = 'Proceed to Pay';
    resetCheckoutRecaptcha();
  }
}

// Socket event for menu updates
socket.on('menu_updated', () => fetchMenu());

// Ensure we fetch the latest menu once the socket connects, 
// guaranteeing the old socket's disconnect has finished releasing stock.
socket.on('connect', () => fetchMenu());

// Socket event for cart updates
socket.on('cart_updated', (serverCart) => {
  if (!serverCart || typeof serverCart !== 'object') return;

  const serverKeys = Object.keys(serverCart);
  if (serverKeys.length === 0) {
    // If server has no cart yet and client has a saved cart, sync local cart to server
    const localKeys = Object.keys(cart);
    if (localKeys.length > 0) {
      localKeys.forEach(id => {
        socket.emit('update_cart', { itemId: parseInt(id, 10), change: cart[id].quantity });
      });
    }
    return;
  }

  const mergedCart = {};
  for (const id in serverCart) {
    const item = menuItems.find(i => i.id == id) || cart[id];
    if (item && serverCart[id] > 0) {
      mergedCart[item.id] = {
        id: item.id,
        name: item.name,
        price: Number(item.price),
        image: item.image,
        quantity: serverCart[id]
      };
    }
  }
  cart = mergedCart;
  saveCartToStorage();
  renderCart();
});

socket.on('cart_error', (msg) => {
  alert(msg);
});



// --- Nav Links ---injected dynamically) ---
const nav = document.querySelector('nav');
if (nav) {
  const ordersLink  = document.createElement('a');
  ordersLink.href   = 'orders.html';
  ordersLink.innerText = 'My Orders';
  nav.appendChild(ordersLink);

  function handleLogout() {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('canteen_cart')) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) {}
    cart = {};
    window.location.replace('login.html');
  }
  window.logout = handleLogout;

  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = `Logout (${user ? user.name : ''})`;
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    handleLogout();
  };
  nav.appendChild(logoutBtn);
}

// --- Search, Filter --- Sort ---
if (menuSearchInput) {
  menuSearchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderMenu();
  });
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter');
    renderMenu();
  });
});

const menuSortSelect = document.getElementById('menu-sort');
if (menuSortSelect) {
  menuSortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderMenu();
  });
}

// --- Mobile Cart Handling ---
const floatingCartBtn = document.getElementById('floating-cart-btn');
const cartPanel = document.getElementById('cart-panel');
const cartOverlay = document.getElementById('cart-overlay');
const closeCartBtn = document.getElementById('close-cart-btn');
const mobileCartBar = document.getElementById('mobile-cart-bar');

if (cartPanel && cartOverlay) {
  if (floatingCartBtn) {
    floatingCartBtn.onclick = () => {
      cartPanel.classList.add('open');
      cartOverlay.classList.add('open');
    };
  }
  
  if (closeCartBtn) {
    closeCartBtn.onclick = () => {
      cartPanel.classList.remove('open');
      cartOverlay.classList.remove('open');
    };
  }
  
  cartOverlay.onclick = () => {
    cartPanel.classList.remove('open');
    cartOverlay.classList.remove('open');
  };
}

// --- DOM Event Delegation for Cart & Menu Actions (CSP Immune) ---
if (menuGrid) {
  menuGrid.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.btn-add');
    if (addBtn && !addBtn.disabled) {
      e.preventDefault();
      const id = addBtn.getAttribute('data-id') || addBtn.closest('.menu-item')?.getAttribute('data-item-id');
      if (id) addToCart(id);
      return;
    }

    const minusBtn = e.target.closest('.stepper-btn-minus');
    if (minusBtn) {
      e.preventDefault();
      const id = minusBtn.getAttribute('data-id') || minusBtn.closest('.menu-item')?.getAttribute('data-item-id');
      if (id) updateQuantity(id, -1);
      return;
    }

    const plusBtn = e.target.closest('.stepper-btn-plus');
    if (plusBtn) {
      e.preventDefault();
      const id = plusBtn.getAttribute('data-id') || plusBtn.closest('.menu-item')?.getAttribute('data-item-id');
      if (id) updateQuantity(id, 1);
      return;
    }
  });
}

if (cartItemsContainer) {
  cartItemsContainer.addEventListener('click', (e) => {
    const minusBtn = e.target.closest('.cart-qty-minus');
    if (minusBtn) {
      e.preventDefault();
      const id = minusBtn.getAttribute('data-id');
      if (id) updateQuantity(id, -1);
      return;
    }

    const plusBtn = e.target.closest('.cart-qty-plus');
    if (plusBtn) {
      e.preventDefault();
      const id = plusBtn.getAttribute('data-id');
      if (id) updateQuantity(id, 1);
      return;
    }
  });
}

if (mobileCartBar && cartPanel && cartOverlay) {
  mobileCartBar.addEventListener('click', (e) => {
    e.preventDefault();
    cartPanel.classList.add('open');
    cartOverlay.classList.add('open');
  });
}

const bottomNavCartBtn = document.querySelector('.bottom-nav a[href="#"]');
if (bottomNavCartBtn && cartPanel && cartOverlay) {
  bottomNavCartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    cartPanel.classList.add('open');
    cartOverlay.classList.add('open');
  });
}

function updateCartCount() {
  const items = Object.values(cart);
  const totalItems = items.reduce((acc, item) => acc + item.quantity, 0);
  const totalPrice = items.reduce((acc, item) => acc + (item.price * item.quantity), 0);

  const countBtn = document.getElementById('floating-cart-count');
  if (countBtn) {
    countBtn.innerText = totalItems;
    if (totalItems > 0) {
      countBtn.style.display = 'inline-block';
    } else {
      countBtn.style.display = 'none';
    }
  }

  // Update floating sticky mobile cart bar
  if (mobileCartBar) {
    if (totalItems > 0) {
      const itemsText = document.getElementById('mobile-cart-items-text');
      const totalText = document.getElementById('mobile-cart-total-text');
      if (itemsText) itemsText.innerText = `${totalItems} ${totalItems === 1 ? 'ITEM' : 'ITEMS'}`;
      if (totalText) totalText.innerText = `₹${totalPrice}`;
      mobileCartBar.classList.add('visible');
    } else {
      mobileCartBar.classList.remove('visible');
    }
  }

  // Sync menu card steppers with cart changes
  renderMenu();
}

// --- Init ---
loadCartFromStorage();
fetchMenu();
renderCart();

// Reload page if returned via browser bfcache (e.g., from Zoho redirect)
window.addEventListener('pageshow', function (event) {
  if (event.persisted) {
    window.location.reload();
  }
});

// ─── MANDATORY PHONE VERIFICATION MODAL FOR ORDERING ──────────────────────────
let modalRecaptchaVerifier = null;
let modalConfirmationResult = null;
let pendingCheckoutTotal = null;

async function initModalFirebaseAuth() {
  const container = document.getElementById('modal-recaptcha-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_URL}/auth/firebase-config`);
    if (!res.ok) return;
    const config = await res.json();

    if (config && config.apiKey && typeof firebase !== 'undefined') {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(config);
      }

      if (!modalRecaptchaVerifier) {
        modalRecaptchaVerifier = new firebase.auth.RecaptchaVerifier('modal-recaptcha-container', {
          size: 'invisible',
          callback: () => {},
          'expired-callback': () => {
            const errEl = document.getElementById('modal-error-msg');
            if (errEl) {
              errEl.innerText = 'Security verification expired. Please try again.';
              errEl.style.display = 'block';
            }
          }
        });
        modalRecaptchaVerifier.render().catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[Modal Firebase] init notice:', e);
  }
}

function openPhoneVerifyModal(total) {
  pendingCheckoutTotal = total;
  const modal = document.getElementById('phone-verify-modal');
  if (!modal) return;

  const phoneInput = document.getElementById('modal-phone-input');
  const otpGroup = document.getElementById('modal-otp-group');
  const otpInput = document.getElementById('modal-otp-input');
  const infoMsg = document.getElementById('modal-info-msg');
  const errorMsg = document.getElementById('modal-error-msg');
  const submitBtn = document.getElementById('modal-submit-btn');

  if (otpGroup) otpGroup.style.display = 'none';
  if (otpInput) { otpInput.value = ''; otpInput.removeAttribute('required'); }
  if (infoMsg) infoMsg.style.display = 'none';
  if (errorMsg) errorMsg.style.display = 'none';
  if (phoneInput) {
    phoneInput.readOnly = false;
    if (currentUser && currentUser.phone) {
      phoneInput.value = currentUser.phone.replace(/^91/, '').slice(-10);
    }
    phoneInput.focus();
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Send Verification Code</span>';
  }

  modal.style.display = 'flex';
}

function closePhoneVerifyModal() {
  const modal = document.getElementById('phone-verify-modal');
  if (modal) modal.style.display = 'none';
  if (checkoutBtn) {
    checkoutBtn.disabled = false;
    checkoutBtn.innerText = 'Proceed to Pay';
  }
}

function setupPhoneVerifyModalListeners() {
  const modalForm = document.getElementById('phone-verify-modal-form');
  const closeBtn = document.getElementById('close-phone-modal-btn');
  const resendBtn = document.getElementById('modal-resend-otp-btn');
  const phoneInput = document.getElementById('modal-phone-input');
  const otpGroup = document.getElementById('modal-otp-group');
  const otpInput = document.getElementById('modal-otp-input');
  const infoMsg = document.getElementById('modal-info-msg');
  const errorMsg = document.getElementById('modal-error-msg');
  const submitBtn = document.getElementById('modal-submit-btn');

  if (closeBtn) {
    closeBtn.onclick = closePhoneVerifyModal;
  }

  if (resendBtn) {
    resendBtn.onclick = () => {
      if (otpGroup) otpGroup.style.display = 'none';
      if (phoneInput) phoneInput.readOnly = false;
      modalConfirmationResult = null;
      if (modalForm) modalForm.dispatchEvent(new Event('submit'));
    };
  }

  if (modalForm) {
    modalForm.onsubmit = async (e) => {
      e.preventDefault();
      if (errorMsg) errorMsg.style.display = 'none';
      if (infoMsg) infoMsg.style.display = 'none';

      const phoneVal = phoneInput ? phoneInput.value.trim() : '';
      const phoneDigits = phoneVal.replace(/\D/g, '');

      if (phoneDigits.length !== 10 || !/^[6-9]\d{9}$/.test(phoneDigits)) {
        if (errorMsg) {
          errorMsg.innerText = 'Please enter a valid 10-digit Indian mobile number (starting with 6, 7, 8, or 9).';
          errorMsg.style.display = 'block';
        }
        return;
      }

      // Step 1: Send SMS verification code if OTP field is not yet shown
      if (!otpGroup || otpGroup.style.display === 'none') {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying Number...';

        try {
          // Pre-check phone availability
          const checkRes = await fetch(`${API_URL}/auth/send-otp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ phone: phoneDigits, email: currentUser?.email })
          });
          const checkData = await checkRes.json();

          if (!checkRes.ok) {
            errorMsg.innerText = checkData.error || 'Unable to verify phone number. Please try again.';
            errorMsg.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Send Verification Code</span>';
            return;
          }

          // Trigger Firebase SMS
          if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0 && modalRecaptchaVerifier) {
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending Verification Code...';
            const internationalPhone = '+91' + phoneDigits;

            try {
              modalConfirmationResult = await firebase.auth().signInWithPhoneNumber(internationalPhone, modalRecaptchaVerifier);

              infoMsg.innerHTML = `<i class="fa-solid fa-circle-check"></i> Verification code sent to <strong>+91 ${phoneDigits}</strong>!`;
              infoMsg.style.display = 'block';
              otpGroup.style.display = 'block';
              otpInput.setAttribute('required', 'true');
              otpInput.focus();
              phoneInput.readOnly = true;
              submitBtn.disabled = false;
              submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
            } catch (firebaseErr) {
              console.error('Firebase modal signInWithPhoneNumber error:', firebaseErr);
              if (window.grecaptcha && modalRecaptchaVerifier) {
                try {
                  const widgetId = await modalRecaptchaVerifier.render();
                  window.grecaptcha.reset(widgetId);
                } catch (e) {}
              }

              let userErrMsg = 'Unable to send verification code right now. Please try again in a few moments.';
              if (firebaseErr.code === 'auth/invalid-phone-number') {
                userErrMsg = 'Please enter a valid 10-digit mobile number.';
              } else if (firebaseErr.code === 'auth/quota-exceeded' || firebaseErr.code === 'auth/too-many-requests') {
                userErrMsg = 'Too many requests. Please wait a moment before requesting another code.';
              } else if (firebaseErr.code === 'auth/operation-not-allowed') {
                console.warn('Firebase SMS region policy restriction:', firebaseErr);
                userErrMsg = 'SMS verification is temporarily unavailable. Please try again later.';
              } else if (firebaseErr.code === 'auth/captcha-check-failed') {
                userErrMsg = 'Security verification failed. Please try again.';
              }
              errorMsg.innerText = userErrMsg;
              errorMsg.style.display = 'block';
              submitBtn.disabled = false;
              submitBtn.innerHTML = '<span>Send Verification Code</span>';
            }
          } else {
            // Dev sandbox mode
            infoMsg.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${checkData.message || 'Enter verification code to continue.'}`;
            infoMsg.style.display = 'block';
            otpGroup.style.display = 'block';
            otpInput.setAttribute('required', 'true');
            otpInput.focus();
            phoneInput.readOnly = true;
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
          }
        } catch (err) {
          errorMsg.innerText = 'Unable to connect to the server. Please check your internet and try again.';
          errorMsg.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Send Verification Code</span>';
        }
        return;
      }

      // Step 2: Confirm OTP & link phone to user account
      const otpVal = otpInput.value.trim();
      if (!otpVal) {
        errorMsg.innerText = 'Please enter the 6-digit verification code.';
        errorMsg.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;

      // A) Firebase confirmation
      if (modalConfirmationResult) {
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying Code...';
        let firebaseIdToken = null;

        try {
          const userCredential = await modalConfirmationResult.confirm(otpVal);
          firebaseIdToken = await userCredential.user.getIdToken();
        } catch (confirmErr) {
          console.error('Modal OTP confirm error:', confirmErr);
          let userErrMsg = 'Incorrect verification code. Please check and re-enter.';
          if (confirmErr.code === 'auth/invalid-verification-code') {
            userErrMsg = 'Incorrect verification code. Please check and re-enter.';
          } else if (confirmErr.code === 'auth/code-expired') {
            userErrMsg = 'Verification code has expired. Please click "Resend SMS".';
          }
          errorMsg.innerText = userErrMsg;
          errorMsg.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
          return;
        }

        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving Mobile Number...';
        try {
          const verifyRes = await fetch(`${API_URL}/auth/verify-phone`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ phone: phoneDigits, firebaseIdToken })
          });
          const verifyData = await verifyRes.json();

          if (!verifyRes.ok) {
            errorMsg.innerText = verifyData.error || 'Unable to save phone number. Please try again.';
            errorMsg.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
            return;
          }

          // Successfully verified and linked!
          if (verifyData.user) {
            currentUser = verifyData.user;
            localStorage.setItem('user', JSON.stringify(currentUser));
          }
          closePhoneVerifyModal();

          // Auto-resume checkout
          if (pendingCheckoutTotal) {
            processCheckout(pendingCheckoutTotal);
          }
        } catch (err) {
          errorMsg.innerText = 'Connection issue. Please try saving again.';
          errorMsg.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
        }
        return;
      }

      // B) Dev fallback confirmation
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving Mobile Number...';
      try {
        const verifyRes = await fetch(`${API_URL}/auth/verify-phone`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ phone: phoneDigits, otp: otpVal })
        });
        const verifyData = await verifyRes.json();

        if (!verifyRes.ok) {
          errorMsg.innerText = verifyData.error || 'Unable to save phone number. Please try again.';
          errorMsg.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
          return;
        }

        if (verifyData.user) {
          currentUser = verifyData.user;
          localStorage.setItem('user', JSON.stringify(currentUser));
        }
        closePhoneVerifyModal();

        if (pendingCheckoutTotal) {
          processCheckout(pendingCheckoutTotal);
        }
      } catch (err) {
        errorMsg.innerText = 'Connection issue. Please try saving again.';
        errorMsg.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Verify & Continue Checkout</span>';
      }
    };
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initCheckoutRecaptcha();
    initModalFirebaseAuth();
    setupPhoneVerifyModalListeners();
  });
} else {
  initCheckoutRecaptcha();
  initModalFirebaseAuth();
  setupPhoneVerifyModalListeners();
}


