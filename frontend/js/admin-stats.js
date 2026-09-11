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

// State
let rawStatsResponse = null;
let currentView = 'cards'; // 'cards' | 'table'
let searchQuery = '';
let currentSort = 'revenue_desc';
let lastFetchedAt = null;
let currentPeriod = 'all'; // 'all' | 'today' | 'month'
let customFilter = null;   // { type: 'date'|'month', value: string, label: string }
let currentSection = 'items'; // 'items' | 'daily' | 'monthly'

// DOM Elements
const kpiRevenue = document.getElementById('kpi-revenue');
const kpiRevenueSub = document.getElementById('kpi-revenue-sub');
const kpiDelivered = document.getElementById('kpi-delivered') || document.getElementById('kpi-orders');
const kpiDeliveredSub = document.getElementById('kpi-delivered-sub') || document.getElementById('kpi-orders-sub');
const kpiOrdered = document.getElementById('kpi-ordered') || document.getElementById('kpi-items');
const kpiOrderedSub = document.getElementById('kpi-ordered-sub') || document.getElementById('kpi-items-sub');
const kpiRate = document.getElementById('kpi-rate');
const kpiRateSub = document.getElementById('kpi-rate-sub');
const countBadge = document.getElementById('stats-count-badge');
const viewContainer = document.getElementById('stats-view-container');
const searchInput = document.getElementById('stats-search-input');
const sortSelect = document.getElementById('stats-sort-select');
const btnViewCards = document.getElementById('btn-view-cards');
const btnViewTable = document.getElementById('btn-view-table');
const btnRefresh = document.getElementById('btn-refresh-stats');
const refreshIcon = document.getElementById('refresh-icon');
const btnExport = document.getElementById('btn-export-stats');
const syncTimeText = document.getElementById('stats-sync-time');
const liveBadge = document.getElementById('stats-live-badge');

// Tracking & Period Filter Elements
const periodBtns = document.querySelectorAll('.stats-period-btn');
const periodIndicatorText = document.getElementById('stats-period-text');
const tabItems = document.getElementById('tab-items');
const tabDaily = document.getElementById('tab-daily');
const tabMonthly = document.getElementById('tab-monthly');
const sectionItems = document.getElementById('section-items');
const sectionDaily = document.getElementById('section-daily');
const sectionMonthly = document.getElementById('section-monthly');
const dailyCountBadge = document.getElementById('daily-count-badge');
const monthlyCountBadge = document.getElementById('monthly-count-badge');
const statsDailyBadge = document.getElementById('stats-daily-badge');
const statsMonthlyBadge = document.getElementById('stats-monthly-badge');
const dailyViewContainer = document.getElementById('daily-view-container');
const monthlyViewContainer = document.getElementById('monthly-view-container');

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

function updateSyncTime() {
  if (!lastFetchedAt || !syncTimeText) return;
  const elapsedSec = Math.floor((Date.now() - lastFetchedAt.getTime()) / 1000);
  if (elapsedSec < 10) {
    syncTimeText.innerText = 'Updated just now';
  } else if (elapsedSec < 60) {
    syncTimeText.innerText = `Updated ${elapsedSec}s ago`;
  } else {
    const mins = Math.floor(elapsedSec / 60);
    syncTimeText.innerText = `Updated ${mins}m ago`;
  }
}

setInterval(updateSyncTime, 15000);

async function fetchItemStats(isManual = false) {
  if (refreshIcon && isManual) {
    refreshIcon.classList.add('fa-spin');
  }

  try {
    let url = `${API_URL}/items/stats`;
    const params = new URLSearchParams();
    if (customFilter) {
      if (customFilter.type === 'date') params.append('date', customFilter.value);
      else if (customFilter.type === 'month') params.append('month', customFilter.value);
    } else if (currentPeriod && currentPeriod !== 'all') {
      params.append('period', currentPeriod);
    }
    const queryStr = params.toString();
    if (queryStr) url += `?${queryStr}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch sales statistics');
    const data = await res.json();
    rawStatsResponse = data;
    lastFetchedAt = new Date();
    updateSyncTime();
    renderDashboard();
  } catch (err) {
    console.error('Error fetching stats:', err);
    if (viewContainer && !rawStatsResponse) {
      viewContainer.innerHTML = `
        <div class="stats-empty-state">
          <i class="fa-solid fa-circle-exclamation" style="color: var(--primary-color);"></i>
          <h4>Unable to load statistics</h4>
          <p>${escapeHtml(err.message || 'Please check your connection and try again.')}</p>
        </div>
      `;
    }
  } finally {
    if (refreshIcon) {
      setTimeout(() => refreshIcon.classList.remove('fa-spin'), 400);
    }
  }
}

function processStatsData() {
  if (!rawStatsResponse) return { summary: {}, items: [] };

  // Support both enhanced backend response { summary, items } and legacy dict { [id]: item }
  let itemsMap = {};
  let summary = {};

  if (rawStatsResponse.items && typeof rawStatsResponse.items === 'object') {
    itemsMap = rawStatsResponse.items;
    summary = rawStatsResponse.summary || {};
  } else {
    itemsMap = rawStatsResponse;
  }

  let calculatedRevenue = 0;
  let calculatedItemsOrdered = 0;
  let calculatedItemsDelivered = 0;

  const itemsList = Object.entries(itemsMap).map(([id, item]) => {
    const ordered = Number(item.orderedQuantity) || 0;
    const delivered = Number(item.deliveredQuantity) || 0;
    const revenue = Number(item.totalRevenue) || 0;
    const pending = Math.max(0, ordered - delivered);
    const rate = ordered > 0 ? Math.round((delivered / ordered) * 100) : 0;

    calculatedRevenue += revenue;
    calculatedItemsOrdered += ordered;
    calculatedItemsDelivered += delivered;

    return {
      id,
      name: item.name || 'Unnamed Item',
      price: Number(item.price) || (delivered > 0 ? revenue / delivered : 0),
      orderedQuantity: ordered,
      deliveredQuantity: delivered,
      pendingQuantity: pending,
      totalRevenue: revenue,
      fulfillmentRate: rate,
      revenueShare: 0 // Will compute below
    };
  });

  const totalRev = Number(summary.totalRevenue != null ? summary.totalRevenue : calculatedRevenue);
  const itemsDelivered = Number(summary.totalItemsDelivered != null ? summary.totalItemsDelivered : calculatedItemsDelivered);
  const itemsOrdered = Number(summary.totalItemsOrdered != null ? summary.totalItemsOrdered : calculatedItemsOrdered);
  const deliveredOrders = Number(summary.deliveredOrders != null ? summary.deliveredOrders : 0);
  const totalOrders = Number(summary.totalOrders != null ? summary.totalOrders : deliveredOrders);

  // Compute revenue shares
  itemsList.forEach(item => {
    item.revenueShare = totalRev > 0 ? Math.round((item.totalRevenue / totalRev) * 100) : 0;
  });

  const overallRate = itemsOrdered > 0 ? Math.round((itemsDelivered / itemsOrdered) * 100) : (deliveredOrders > 0 ? 100 : 0);

  return {
    summary: {
      totalRevenue: totalRev,
      totalOrders,
      deliveredOrders,
      totalItemsOrdered: itemsOrdered,
      totalItemsDelivered: itemsDelivered,
      fulfillmentRate: overallRate
    },
    items: itemsList
  };
}

function updatePeriodIndicator() {
  if (!periodIndicatorText) return;
  if (customFilter) {
    periodIndicatorText.innerHTML = `Filtered: <strong>${escapeHtml(customFilter.label)}</strong> <button id="btn-clear-filter" style="background:none;border:none;color:var(--primary-color);font-weight:700;cursor:pointer;margin-left:6px;text-decoration:underline;" title="Clear filter">&times; Clear</button>`;
    const clearBtn = document.getElementById('btn-clear-filter');
    if (clearBtn) {
      clearBtn.onclick = () => {
        customFilter = null;
        currentPeriod = 'all';
        updatePeriodButtonsUI();
        updatePeriodIndicator();
        fetchItemStats(true);
      };
    }
  } else if (currentPeriod === 'today') {
    periodIndicatorText.innerText = "Today's Live Sales";
  } else if (currentPeriod === 'month') {
    periodIndicatorText.innerText = "This Month's Sales";
  } else {
    periodIndicatorText.innerText = "All-Time Sales";
  }
}

function updatePeriodButtonsUI() {
  periodBtns.forEach(btn => {
    const p = btn.getAttribute('data-period');
    if (!customFilter && p === currentPeriod) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function switchSection(section) {
  currentSection = section;

  if (tabItems) tabItems.classList.toggle('active', section === 'items');
  if (tabDaily) tabDaily.classList.toggle('active', section === 'daily');
  if (tabMonthly) tabMonthly.classList.toggle('active', section === 'monthly');

  if (sectionItems) sectionItems.style.display = (section === 'items') ? 'block' : 'none';
  if (sectionDaily) sectionDaily.style.display = (section === 'daily') ? 'block' : 'none';
  if (sectionMonthly) sectionMonthly.style.display = (section === 'monthly') ? 'block' : 'none';

  renderDashboard();
}

function renderDashboard() {
  const { summary, items } = processStatsData();

  // 1. Update KPI Cards
  const deliveredItems = summary.totalItemsDelivered || 0;
  const orderedItems = summary.totalItemsOrdered || 0;
  const deliveredOrders = summary.deliveredOrders || 0;
  const totalOrders = summary.totalOrders || 0;
  const revenue = summary.totalRevenue || 0;
  const fulfillmentRate = summary.fulfillmentRate || 0;

  // Total Revenue & delivered orders count
  if (kpiRevenue) kpiRevenue.innerText = `₹${revenue.toFixed(2)}`;
  if (kpiRevenueSub) {
    kpiRevenueSub.innerText = `${deliveredOrders} ${deliveredOrders === 1 ? 'order' : 'orders'} delivered`;
  }

  // Delivered items count & delivered orders count
  if (kpiDelivered) kpiDelivered.innerText = deliveredItems;
  if (kpiDeliveredSub) {
    kpiDeliveredSub.innerText = `${deliveredOrders} ${deliveredOrders === 1 ? 'order' : 'orders'} delivered`;
  }

  // Ordered items count & total orders count
  if (kpiOrdered) kpiOrdered.innerText = orderedItems;
  if (kpiOrderedSub) {
    kpiOrderedSub.innerText = `${totalOrders} ${totalOrders === 1 ? 'order' : 'orders'} placed`;
  }

  // Fulfillment Rate & delivered vs ordered count
  if (kpiRate) kpiRate.innerText = `${fulfillmentRate}%`;
  if (kpiRateSub) {
    kpiRateSub.innerText = `${deliveredItems} of ${orderedItems} items`;
  }

  // Update Period Indicator & Buttons
  updatePeriodIndicator();
  updatePeriodButtonsUI();

  // Update Badges for Daily and Monthly lists
  const dailyList = rawStatsResponse?.daily || [];
  const monthlyList = rawStatsResponse?.monthly || [];

  if (dailyCountBadge) dailyCountBadge.innerText = dailyList.length;
  if (monthlyCountBadge) monthlyCountBadge.innerText = monthlyList.length;
  if (statsDailyBadge) statsDailyBadge.innerText = `${dailyList.length} ${dailyList.length === 1 ? 'day' : 'days'}`;
  if (statsMonthlyBadge) statsMonthlyBadge.innerText = `${monthlyList.length} ${monthlyList.length === 1 ? 'month' : 'months'}`;

  // 2. Render Active Section
  if (currentSection === 'daily') {
    renderDailyTable(dailyList);
    return;
  } else if (currentSection === 'monthly') {
    renderMonthlyTable(monthlyList);
    return;
  }

  // 3. Filter & Sort Items (Items Breakdown section)
  let filtered = items.filter(item => {
    if (!searchQuery.trim()) return true;
    return item.name.toLowerCase().includes(searchQuery.trim().toLowerCase());
  });

  filtered.sort((a, b) => {
    switch (currentSort) {
      case 'revenue_desc':
        return b.totalRevenue - a.totalRevenue;
      case 'ordered_desc':
        return b.orderedQuantity - a.orderedQuantity;
      case 'delivered_desc':
        return b.deliveredQuantity - a.deliveredQuantity;
      case 'rate_desc':
        return b.fulfillmentRate - a.fulfillmentRate;
      case 'name_asc':
        return a.name.localeCompare(b.name);
      default:
        return b.totalRevenue - a.totalRevenue;
    }
  });

  // Update count badge
  if (countBadge) {
    countBadge.innerText = `${filtered.length} ${filtered.length === 1 ? 'item' : 'items'}`;
  }

  // Render View Container
  if (!viewContainer) return;

  if (filtered.length === 0) {
    if (items.length === 0) {
      viewContainer.innerHTML = `
        <div class="stats-empty-state">
          <i class="fa-solid fa-chart-pie"></i>
          <h4>No sales recorded for this period</h4>
          <p>Orders completed by students will appear here in real-time.</p>
        </div>
      `;
    } else {
      viewContainer.innerHTML = `
        <div class="stats-empty-state">
          <i class="fa-solid fa-magnifying-glass"></i>
          <h4>No matching items</h4>
          <p>No menu items matched "<strong>${escapeHtml(searchQuery)}</strong>". Try clearing your search filter.</p>
        </div>
      `;
    }
    return;
  }

  if (currentView === 'cards') {
    renderCardsView(filtered);
  } else {
    renderTableView(filtered);
  }
}

function renderCardsView(items) {
  let html = '<div class="stats-items-grid">';

  items.forEach((item, index) => {
    const isTop = index === 0 && item.totalRevenue > 0;
    const rankLabel = isTop ? '★ #1 Top Seller' : `#${index + 1}`;
    const rankClass = isTop ? 'gold' : '';
    const cardRankClass = isTop ? 'rank-top' : '';
    const isComplete = item.fulfillmentRate >= 100;
    const fillClass = isComplete ? '' : 'in-progress';

    html += `
      <div class="stats-item-card ${cardRankClass}">
        <div class="stats-item-header">
          <div class="stats-item-title-wrap">
            <span class="stats-rank-tag ${rankClass}">${rankLabel}</span>
            <h4 class="stats-item-title">${escapeHtml(item.name)}</h4>
          </div>
          <div style="text-align: right;">
            <div class="stats-item-rev-badge">₹${item.totalRevenue.toFixed(2)}</div>
            <div class="stats-item-rev-share">${item.revenueShare}% of sales</div>
          </div>
        </div>

        <div class="stats-progress-wrap">
          <div class="stats-progress-info">
            <span>Fulfillment</span>
            <span>${item.deliveredQuantity} of ${item.orderedQuantity} (${item.fulfillmentRate}%)</span>
          </div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${fillClass}" style="width: ${Math.min(100, item.fulfillmentRate)}%;"></div>
          </div>
        </div>

        <div class="stats-item-metrics">
          <div class="stats-metric-pill">
            <div class="stats-metric-pill-label">Ordered</div>
            <div class="stats-metric-pill-val">${item.orderedQuantity}</div>
          </div>
          <div class="stats-metric-pill">
            <div class="stats-metric-pill-label">Delivered</div>
            <div class="stats-metric-pill-val" style="color: #059669;">${item.deliveredQuantity}</div>
          </div>
          <div class="stats-metric-pill">
            <div class="stats-metric-pill-label">Pending</div>
            <div class="stats-metric-pill-val" style="color: ${item.pendingQuantity > 0 ? '#d97706' : 'var(--text-muted)'};">${item.pendingQuantity}</div>
          </div>
        </div>
      </div>
    `;
  });

  html += '</div>';
  viewContainer.innerHTML = html;
}

function renderTableView(items) {
  let html = `
    <!-- Desktop Table View -->
    <div class="stats-desktop-table-view">
      <div class="stats-table-wrapper">
        <table class="stats-table">
          <thead>
            <tr>
              <th style="width: 60px;">#</th>
              <th>Item Name</th>
              <th style="text-align: center;">Ordered</th>
              <th style="text-align: center;">Delivered</th>
              <th style="text-align: center;">Pending</th>
              <th>Fulfillment</th>
              <th style="text-align: right;">Revenue</th>
              <th style="text-align: center;">Status</th>
            </tr>
          </thead>
          <tbody>
  `;

  items.forEach((item, index) => {
    const isTop = index === 0 && item.totalRevenue > 0;
    const isComplete = item.fulfillmentRate >= 100;
    const statusPill = isComplete
      ? `<span class="stats-status-pill completed"><i class="fa-solid fa-check"></i> Fulfilled</span>`
      : `<span class="stats-status-pill partial"><i class="fa-solid fa-clock"></i> In Kitchen (${item.pendingQuantity})</span>`;

    html += `
      <tr>
        <td style="font-weight: 700; color: ${isTop ? '#d97706' : 'var(--text-muted)'};">
          ${isTop ? '★ 1' : index + 1}
        </td>
        <td>
          <strong style="color: var(--text-main); font-size: 0.98rem;">${escapeHtml(item.name)}</strong>
        </td>
        <td style="text-align: center; font-weight: 600;">${item.orderedQuantity}</td>
        <td style="text-align: center; font-weight: 700; color: #059669;">${item.deliveredQuantity}</td>
        <td style="text-align: center; font-weight: 600; color: ${item.pendingQuantity > 0 ? '#d97706' : 'var(--text-muted)'};">${item.pendingQuantity}</td>
        <td style="min-width: 140px;">
          <div style="font-size: 0.78rem; font-weight: 600; margin-bottom: 3px;">${item.fulfillmentRate}%</div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${isComplete ? '' : 'in-progress'}" style="width: ${Math.min(100, item.fulfillmentRate)}%;"></div>
          </div>
        </td>
        <td style="text-align: right; font-weight: 800; color: var(--primary-color); font-size: 1.05rem;">
          ₹${item.totalRevenue.toFixed(2)}
        </td>
        <td style="text-align: center;">${statusPill}</td>
      </tr>
    `;
  });

  html += `
          </tbody>
        </table>
      </div>
    </div>

    <!-- Mobile List View -->
    <div class="stats-mobile-list-view stats-mobile-items-list">
  `;

  items.forEach((item, index) => {
    const isTop = index === 0 && item.totalRevenue > 0;
    const rankLabel = isTop ? '★ #1 Top Seller' : `#${index + 1}`;
    const rankClass = isTop ? 'gold' : '';
    const cardRankClass = isTop ? 'rank-top' : '';
    const isComplete = item.fulfillmentRate >= 100;
    const fillClass = isComplete ? '' : 'in-progress';
    const statusPill = isComplete
      ? `<span class="stats-status-pill completed"><i class="fa-solid fa-check"></i> Fulfilled</span>`
      : `<span class="stats-status-pill partial"><i class="fa-solid fa-clock"></i> In Kitchen (${item.pendingQuantity})</span>`;

    html += `
      <div class="stats-item-list-card ${cardRankClass}">
        <div class="stats-item-list-header">
          <div class="stats-item-list-name-wrap">
            <span class="stats-rank-tag ${rankClass}">${rankLabel}</span>
            <h4 class="stats-item-list-title">${escapeHtml(item.name)}</h4>
          </div>
          <div class="stats-item-list-price-wrap">
            <span class="stats-item-list-rev">₹${item.totalRevenue.toFixed(2)}</span>
            <span class="stats-item-list-share">${item.revenueShare}% of sales</span>
          </div>
        </div>

        <div class="stats-progress-wrap" style="margin: 0.35rem 0;">
          <div class="stats-progress-info">
            <span>Fulfillment</span>
            <span>${item.deliveredQuantity} of ${item.orderedQuantity} (${item.fulfillmentRate}%)</span>
          </div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${fillClass}" style="width: ${Math.min(100, item.fulfillmentRate)}%;"></div>
          </div>
        </div>

        <div class="stats-item-list-footer">
          <div class="stats-item-list-pill-group">
            <span class="stats-mini-pill"><strong>${item.orderedQuantity}</strong> ord</span>
            <span class="stats-mini-pill green"><strong>${item.deliveredQuantity}</strong> del</span>
            ${item.pendingQuantity > 0 ? `<span class="stats-mini-pill amber"><strong>${item.pendingQuantity}</strong> pend</span>` : ''}
          </div>
          <div>${statusPill}</div>
        </div>
      </div>
    `;
  });

  html += `
    </div>
  `;

  viewContainer.innerHTML = html;
}

// Render Daily Tracking Table
function renderDailyTable(dailyList) {
  if (!dailyViewContainer) return;
  if (!dailyList || dailyList.length === 0) {
    dailyViewContainer.innerHTML = `
      <div class="stats-empty-state">
        <i class="fa-solid fa-calendar-xmark"></i>
        <h4>No daily sales records yet</h4>
        <p>Completed orders will automatically form daily timeline records here.</p>
      </div>
    `;
    return;
  }

  // Determine current IST date string
  const now = new Date();
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffsetMs);
  const todayStr = `${istTime.getUTCFullYear()}-${String(istTime.getUTCMonth() + 1).padStart(2, '0')}-${String(istTime.getUTCDate()).padStart(2, '0')}`;

  let html = `
    <!-- Desktop Table View -->
    <div class="stats-desktop-table-view">
      <div class="stats-track-table-wrap">
        <table class="stats-track-table">
          <thead>
            <tr>
              <th>Date</th>
              <th style="text-align: center;">Orders Placed</th>
              <th style="text-align: center;">Delivered</th>
              <th style="text-align: center;">Pending</th>
              <th style="text-align: center;">Items Sold</th>
              <th>Fulfillment Rate</th>
              <th style="text-align: right;">Total Revenue</th>
              <th style="text-align: center;">Action</th>
            </tr>
          </thead>
          <tbody>
  `;

  dailyList.forEach(day => {
    const isToday = (day.date === todayStr);
    const todayBadge = isToday ? '<span class="stats-date-badge-today">Today</span>' : '';
    const isComplete = (day.fulfillmentRate >= 100);

    html += `
      <tr>
        <td>
          <div class="stats-date-pill">
            <i class="fa-regular fa-calendar" style="color: var(--primary-color);"></i>
            <span>${escapeHtml(day.formattedDate || day.date)}</span>
            ${todayBadge}
          </div>
        </td>
        <td style="text-align: center; font-weight: 600;">${day.totalOrders}</td>
        <td style="text-align: center; font-weight: 700; color: #059669;">${day.deliveredOrders}</td>
        <td style="text-align: center; font-weight: 600; color: ${day.pendingOrders > 0 ? '#d97706' : 'var(--text-muted)'};">${day.pendingOrders}</td>
        <td style="text-align: center; font-weight: 600;">${day.totalItemsDelivered}</td>
        <td style="min-width: 140px;">
          <div style="font-size: 0.78rem; font-weight: 600; margin-bottom: 3px;">${day.fulfillmentRate}%</div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${isComplete ? '' : 'in-progress'}" style="width: ${Math.min(100, day.fulfillmentRate)}%;"></div>
          </div>
        </td>
        <td style="text-align: right; font-weight: 800; color: var(--primary-color); font-size: 1.05rem;">
          ₹${Number(day.totalRevenue || 0).toFixed(2)}
        </td>
        <td style="text-align: center;">
          <button class="stats-btn-view-period" onclick="viewDayDetails('${escapeHtml(day.date)}', '${escapeHtml(day.formattedDate || day.date)}')">
            <i class="fa-solid fa-eye"></i> View Items
          </button>
        </td>
      </tr>
    `;
  });

  html += `
          </tbody>
        </table>
      </div>
    </div>

    <!-- Mobile Cards List View -->
    <div class="stats-mobile-list-view stats-mobile-track-list">
  `;

  dailyList.forEach(day => {
    const isToday = (day.date === todayStr);
    const todayBadge = isToday ? '<span class="stats-date-badge-today">Today</span>' : '';
    const isComplete = (day.fulfillmentRate >= 100);

    html += `
      <div class="stats-track-mobile-card">
        <div class="stats-track-mobile-header">
          <div class="stats-date-pill">
            <i class="fa-regular fa-calendar" style="color: var(--primary-color);"></i>
            <span class="stats-track-mobile-date">${escapeHtml(day.formattedDate || day.date)}</span>
            ${todayBadge}
          </div>
          <div class="stats-track-mobile-revenue">
            ₹${Number(day.totalRevenue || 0).toFixed(2)}
          </div>
        </div>

        <div class="stats-progress-wrap" style="margin: 0.45rem 0;">
          <div class="stats-progress-info">
            <span>Fulfillment</span>
            <span>${day.deliveredOrders} of ${day.totalOrders} orders (${day.fulfillmentRate}%)</span>
          </div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${isComplete ? '' : 'in-progress'}" style="width: ${Math.min(100, day.fulfillmentRate)}%;"></div>
          </div>
        </div>

        <div class="stats-track-mobile-stats-row">
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Placed</span>
            <span class="stats-stat-val">${day.totalOrders}</span>
          </div>
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Delivered</span>
            <span class="stats-stat-val green">${day.deliveredOrders}</span>
          </div>
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Pending</span>
            <span class="stats-stat-val ${day.pendingOrders > 0 ? 'amber' : ''}">${day.pendingOrders}</span>
          </div>
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Items</span>
            <span class="stats-stat-val">${day.totalItemsDelivered}</span>
          </div>
        </div>

        <div class="stats-track-mobile-actions">
          <button class="stats-btn-view-period full-width" onclick="viewDayDetails('${escapeHtml(day.date)}', '${escapeHtml(day.formattedDate || day.date)}')">
            <i class="fa-solid fa-eye"></i> View Items (${day.totalItemsDelivered} sold)
          </button>
        </div>
      </div>
    `;
  });

  html += `
    </div>
  `;

  dailyViewContainer.innerHTML = html;
}

// Render Monthly Tracking Table
function renderMonthlyTable(monthlyList) {
  if (!monthlyViewContainer) return;
  if (!monthlyList || monthlyList.length === 0) {
    monthlyViewContainer.innerHTML = `
      <div class="stats-empty-state">
        <i class="fa-solid fa-calendar-xmark"></i>
        <h4>No monthly sales records yet</h4>
        <p>Completed orders will aggregate into monthly reports here.</p>
      </div>
    `;
    return;
  }

  const now = new Date();
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffsetMs);
  const currentMonthStr = `${istTime.getUTCFullYear()}-${String(istTime.getUTCMonth() + 1).padStart(2, '0')}`;

  let html = `
    <!-- Desktop Table View -->
    <div class="stats-desktop-table-view">
      <div class="stats-track-table-wrap">
        <table class="stats-track-table">
          <thead>
            <tr>
              <th>Month</th>
              <th style="text-align: center;">Orders Placed</th>
              <th style="text-align: center;">Delivered</th>
              <th style="text-align: center;">Pending</th>
              <th style="text-align: center;">Items Sold</th>
              <th>Fulfillment Rate</th>
              <th style="text-align: right;">Total Revenue</th>
              <th style="text-align: center;">Action</th>
            </tr>
          </thead>
          <tbody>
  `;

  monthlyList.forEach(m => {
    const isCurrent = (m.month === currentMonthStr);
    const currentBadge = isCurrent ? '<span class="stats-date-badge-today">Current Month</span>' : '';
    const isComplete = (m.fulfillmentRate >= 100);

    html += `
      <tr>
        <td>
          <div class="stats-date-pill">
            <i class="fa-regular fa-calendar-days" style="color: var(--primary-color);"></i>
            <span>${escapeHtml(m.formattedMonth || m.month)}</span>
            ${currentBadge}
          </div>
        </td>
        <td style="text-align: center; font-weight: 600;">${m.totalOrders}</td>
        <td style="text-align: center; font-weight: 700; color: #059669;">${m.deliveredOrders}</td>
        <td style="text-align: center; font-weight: 600; color: ${m.pendingOrders > 0 ? '#d97706' : 'var(--text-muted)'};">${m.pendingOrders}</td>
        <td style="text-align: center; font-weight: 600;">${m.totalItemsDelivered}</td>
        <td style="min-width: 140px;">
          <div style="font-size: 0.78rem; font-weight: 600; margin-bottom: 3px;">${m.fulfillmentRate}%</div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${isComplete ? '' : 'in-progress'}" style="width: ${Math.min(100, m.fulfillmentRate)}%;"></div>
          </div>
        </td>
        <td style="text-align: right; font-weight: 800; color: var(--primary-color); font-size: 1.05rem;">
          ₹${Number(m.totalRevenue || 0).toFixed(2)}
        </td>
        <td style="text-align: center;">
          <button class="stats-btn-view-period" onclick="viewMonthDetails('${escapeHtml(m.month)}', '${escapeHtml(m.formattedMonth || m.month)}')">
            <i class="fa-solid fa-eye"></i> View Items
          </button>
        </td>
      </tr>
    `;
  });

  html += `
          </tbody>
        </table>
      </div>
    </div>

    <!-- Mobile Cards List View -->
    <div class="stats-mobile-list-view stats-mobile-track-list">
  `;

  monthlyList.forEach(m => {
    const isCurrent = (m.month === currentMonthStr);
    const currentBadge = isCurrent ? '<span class="stats-date-badge-today">Current Month</span>' : '';
    const isComplete = (m.fulfillmentRate >= 100);

    html += `
      <div class="stats-track-mobile-card">
        <div class="stats-track-mobile-header">
          <div class="stats-date-pill">
            <i class="fa-regular fa-calendar-days" style="color: var(--primary-color);"></i>
            <span class="stats-track-mobile-date">${escapeHtml(m.formattedMonth || m.month)}</span>
            ${currentBadge}
          </div>
          <div class="stats-track-mobile-revenue">
            ₹${Number(m.totalRevenue || 0).toFixed(2)}
          </div>
        </div>

        <div class="stats-progress-wrap" style="margin: 0.45rem 0;">
          <div class="stats-progress-info">
            <span>Fulfillment</span>
            <span>${m.deliveredOrders} of ${m.totalOrders} orders (${m.fulfillmentRate}%)</span>
          </div>
          <div class="stats-progress-track">
            <div class="stats-progress-fill ${isComplete ? '' : 'in-progress'}" style="width: ${Math.min(100, m.fulfillmentRate)}%;"></div>
          </div>
        </div>

        <div class="stats-track-mobile-stats-row">
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Placed</span>
            <span class="stats-stat-val">${m.totalOrders}</span>
          </div>
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Delivered</span>
            <span class="stats-stat-val green">${m.deliveredOrders}</span>
          </div>
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Pending</span>
            <span class="stats-stat-val ${m.pendingOrders > 0 ? 'amber' : ''}">${m.pendingOrders}</span>
          </div>
          <div class="stats-track-stat-box">
            <span class="stats-stat-lbl">Items</span>
            <span class="stats-stat-val">${m.totalItemsDelivered}</span>
          </div>
        </div>

        <div class="stats-track-mobile-actions">
          <button class="stats-btn-view-period full-width" onclick="viewMonthDetails('${escapeHtml(m.month)}', '${escapeHtml(m.formattedMonth || m.month)}')">
            <i class="fa-solid fa-eye"></i> View Items (${m.totalItemsDelivered} sold)
          </button>
        </div>
      </div>
    `;
  });

  html += `
    </div>
  `;

  monthlyViewContainer.innerHTML = html;
}


// Global drill-down handlers
window.viewDayDetails = function(dateKey, formattedLabel) {
  customFilter = { type: 'date', value: dateKey, label: formattedLabel || dateKey };
  switchSection('items');
  updatePeriodIndicator();
  updatePeriodButtonsUI();
  fetchItemStats(true);
};

window.viewMonthDetails = function(monthKey, formattedLabel) {
  customFilter = { type: 'month', value: monthKey, label: formattedLabel || monthKey };
  switchSection('items');
  updatePeriodIndicator();
  updatePeriodButtonsUI();
  fetchItemStats(true);
};

// Export CSV Report (Adapts to Active Tab)
function exportToCsv() {
  const dateStr = new Date().toISOString().split('T')[0];

  // 1. Export Daily Records
  if (currentSection === 'daily') {
    const dailyList = rawStatsResponse?.daily || [];
    if (dailyList.length === 0) {
      alert('No daily sales records available to export.');
      return;
    }
    let csv = 'data:text/csv;charset=utf-8,';
    csv += 'Date,Orders Placed,Delivered Orders,Pending Orders,Items Sold,Fulfillment Rate,Total Revenue (INR)\r\n';
    dailyList.forEach(d => {
      csv += `"${d.formattedDate || d.date}",${d.totalOrders},${d.deliveredOrders},${d.pendingOrders},${d.totalItemsDelivered},${d.fulfillmentRate}%,${Number(d.totalRevenue || 0).toFixed(2)}\r\n`;
    });
    downloadCsv(csv, `canteen-daily-sales-${dateStr}.csv`);
    return;
  }

  // 2. Export Monthly Records
  if (currentSection === 'monthly') {
    const monthlyList = rawStatsResponse?.monthly || [];
    if (monthlyList.length === 0) {
      alert('No monthly sales records available to export.');
      return;
    }
    let csv = 'data:text/csv;charset=utf-8,';
    csv += 'Month,Orders Placed,Delivered Orders,Pending Orders,Items Sold,Fulfillment Rate,Total Revenue (INR)\r\n';
    monthlyList.forEach(m => {
      csv += `"${m.formattedMonth || m.month}",${m.totalOrders},${m.deliveredOrders},${m.pendingOrders},${m.totalItemsDelivered},${m.fulfillmentRate}%,${Number(m.totalRevenue || 0).toFixed(2)}\r\n`;
    });
    downloadCsv(csv, `canteen-monthly-sales-${dateStr}.csv`);
    return;
  }

  // 3. Export Item Breakdown
  const { items, summary } = processStatsData();
  if (items.length === 0) {
    alert('No sales data available to export.');
    return;
  }

  let csvContent = 'data:text/csv;charset=utf-8,';
  csvContent += 'Rank,Item Name,Ordered Units,Delivered Units,Pending Units,Fulfillment Rate,Total Revenue (INR),Revenue Share\r\n';

  items.forEach((item, idx) => {
    const row = [
      idx + 1,
      `"${item.name.replace(/"/g, '""')}"`,
      item.orderedQuantity,
      item.deliveredQuantity,
      item.pendingQuantity,
      `${item.fulfillmentRate}%`,
      item.totalRevenue.toFixed(2),
      `${item.revenueShare}%`
    ];
    csvContent += row.join(',') + '\r\n';
  });

  csvContent += `\r\n"Total Revenue",,,,,"₹${(summary.totalRevenue || 0).toFixed(2)}"\r\n`;
  csvContent += `"Total Delivered Units",,,,,"${summary.totalItemsDelivered || 0}"\r\n`;

  const periodLabel = customFilter ? customFilter.value : currentPeriod;
  downloadCsv(csvContent, `canteen-items-stats-${periodLabel}-${dateStr}.csv`);
}

function downloadCsv(content, filename) {
  const encodedUri = encodeURI(content);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Event Listeners
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderDashboard();
  });
}

if (sortSelect) {
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderDashboard();
  });
}

if (btnViewCards && btnViewTable) {
  btnViewCards.addEventListener('click', () => {
    if (currentView === 'cards') return;
    currentView = 'cards';
    btnViewCards.classList.add('active');
    btnViewTable.classList.remove('active');
    renderDashboard();
  });

  btnViewTable.addEventListener('click', () => {
    if (currentView === 'table') return;
    currentView = 'table';
    btnViewTable.classList.add('active');
    btnViewCards.classList.remove('active');
    renderDashboard();
  });
}

// Tab navigation listeners
if (tabItems) {
  tabItems.addEventListener('click', () => switchSection('items'));
}
if (tabDaily) {
  tabDaily.addEventListener('click', () => switchSection('daily'));
}
if (tabMonthly) {
  tabMonthly.addEventListener('click', () => switchSection('monthly'));
}

// Period buttons listeners
periodBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const period = btn.getAttribute('data-period');
    if (period === currentPeriod && !customFilter) return;
    customFilter = null;
    currentPeriod = period;
    updatePeriodButtonsUI();
    updatePeriodIndicator();
    fetchItemStats(true);
  });
});

if (btnRefresh) {
  btnRefresh.addEventListener('click', () => {
    fetchItemStats(true);
  });
}

if (btnExport) {
  btnExport.addEventListener('click', exportToCsv);
}

// Live Updates via Socket.IO
function handleLiveEvent() {
  if (liveBadge) {
    liveBadge.style.transform = 'scale(1.08)';
    setTimeout(() => {
      if (liveBadge) liveBadge.style.transform = 'scale(1)';
    }, 400);
  }
  fetchItemStats();
}

socket.on('new_order', handleLiveEvent);
socket.on('payment_confirmed', handleLiveEvent);
socket.on('order_status_update', handleLiveEvent);

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

// Initialize
fetchItemStats();

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
