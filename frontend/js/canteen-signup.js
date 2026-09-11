const API_URL = `${window.location.origin}/api`;

const form = document.getElementById('form-tenant-register');
const canteenNameInput = document.getElementById('reg-canteen-name');
const slugInput = document.getElementById('reg-slug');
const slugPreview = document.getElementById('slug-preview');
const emailInput = document.getElementById('reg-email');
const phoneInput = document.getElementById('reg-phone');
const passwordInput = document.getElementById('reg-password');
const addressInput = document.getElementById('reg-address');
const planSelect = document.getElementById('reg-plan');
const submitBtn = document.getElementById('btn-submit-signup');
const alertBox = document.getElementById('signup-alert');

function showAlert(message, isError = true) {
  alertBox.textContent = message;
  alertBox.className = `form-alert ${isError ? 'error' : 'success'}`;
  alertBox.style.display = 'block';
  alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateSlugPreview(slug) {
  const origin = window.location.origin;
  slugPreview.textContent = `Your link: ${origin}/menu.html?canteen=${slug || 'your-canteen'}`;
}

// Auto-generate slug from canteen name
canteenNameInput.addEventListener('input', (e) => {
  if (!slugInput.dataset.manual) {
    const generated = e.target.value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    slugInput.value = generated;
    updateSlugPreview(generated);
  }
});

slugInput.addEventListener('input', (e) => {
  slugInput.dataset.manual = 'true';
  const clean = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  slugInput.value = clean;
  updateSlugPreview(clean);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.style.display = 'none';

  const canteenName = canteenNameInput.value.trim();
  const slug = slugInput.value.trim();
  const email = emailInput.value.trim();
  const phone = phoneInput.value.trim();
  const password = passwordInput.value;
  const address = addressInput.value.trim();
  const planTier = planSelect.value;

  if (!canteenName || canteenName.length < 3) {
    return showAlert('Canteen name must be at least 3 characters.');
  }
  if (!slug || slug.length < 3) {
    return showAlert('A valid URL slug is required (at least 3 letters/numbers).');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showAlert('Please provide a valid email address.');
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) {
    return showAlert('Please provide a valid 10-digit phone number.');
  }
  if (!password || password.length < 6) {
    return showAlert('Password must be at least 6 characters.');
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Provisioning your canteen...';

  try {
    const res = await fetch(`${API_URL}/auth/tenant-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canteenName,
        slug,
        email,
        password,
        phone,
        address,
        planTier
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to provision canteen');
    }

    // Auto-login: Store token & user
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.setItem('selected_canteen', data.tenant.slug);

    showAlert('Canteen launched successfully! Redirecting to your Admin Dashboard...', false);

    setTimeout(() => {
      window.location.replace('admin.html');
    }, 1500);

  } catch (err) {
    showAlert(err.message, true);
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-rocket"></i> Launch My Canteen Now';
  }
});
